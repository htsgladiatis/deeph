'use strict'

/**
 * Джарвис - локальный голосовой ассистент без Ollama.
 *
 * Сервер отдаёт страницу, стримит ответы freePi через локальный маршрут
 * Andrey DS Harness, хранит заметки и открывает программы по просьбе.
 * Зависимостей нет: только node:http, node:fs и стандартный fetch.
 */

import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

import { LlmClient, resolveConfig } from "./src/llm.mjs"
import { createStore } from "./src/store.mjs"
import {
  composeMessages,
  handleLocal,
  notesSpeech,
} from "./src/assistant.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(HERE, "public")
const DATA_DIR = path.join(HERE, "data")

loadEnv(path.join(HERE, ".env"))

const config = resolveConfig(process.env)
const store = createStore(DATA_DIR)
const llm = new LlmClient(config)
const logFile = path.join(DATA_DIR, "jarvis.log")

function loadEnv(file) {
  let text = ""
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) value = value.slice(1, -1)
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function log(message, extra) {
  const record = { ts: new Date().toISOString(), message, ...(extra ?? {}) }
  try {
    fs.appendFileSync(logFile, JSON.stringify(record) + "\n", "utf8")
  } catch {
    /* журнал не должен ронять сервер */
  }
  if (process.env.JARVIS_QUIET !== "1") console.log(record.ts.slice(11, 19), message, extra === undefined ? "" : JSON.stringify(extra))
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(body)
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("Слишком большой запрос"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch (error) {
        reject(new Error("Некорректный JSON: " + error.message))
      }
    })
    req.on("error", reject)
  })
}

function serveStatic(req, res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1)
  const target = path.resolve(PUBLIC_DIR, relative)
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403)
    res.end("forbidden")
    return
  }
  fs.stat(target, (error, stats) => {
    if (error !== null || !stats.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      res.end("Не найдено: " + pathname)
      return
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    })
    fs.createReadStream(target).pipe(res)
  })
}

/** Открывает программу или сайт средствами Windows. */
function openTarget(target) {
  if (target === null || typeof target !== "object") return false
  if (target.type !== "app" && target.type !== "url") return false
  const value = String(target.value ?? "")
  if (value === "") return false
  try {
    const child = spawn("cmd.exe", ["/c", "start", "", value], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
    child.unref()
    log("open", { type: target.type, value })
    return true
  } catch (error) {
    log("open-failed", { value, error: String(error?.message ?? error) })
    return false
  }
}

/** Выполняет локальное действие и собирает текстовый ответ для озвучки. */
function runLocal(local) {
  const action = local.action ?? null
  if (action === null) return { reply: local.reply ?? "", kind: "local" }
  if (action.type === "open") {
    const ok = openTarget(action.target)
    const reply = ok ? local.reply : "Не получилось открыть «" + action.target.label + "»"
    return { reply, kind: "open", opened: ok }
  }
  if (action.type === "remember") {
    store.addNote(action.text)
    log("note-added", { length: action.text.length })
    return { reply: local.reply, kind: "memory" }
  }
  if (action.type === "list-notes") {
    const notes = store.notes()
    return { reply: notesSpeech(notes), kind: "memory", notes }
  }
  if (action.type === "clear-notes") {
    store.clearNotes()
    return { reply: local.reply, kind: "memory", notes: [] }
  }
  if (action.type === "timer") {
    return { reply: local.reply, kind: "timer", timer: { seconds: action.seconds, label: action.label } }
  }
  if (action.type === "stop") return { reply: local.reply, kind: "stop" }
  return { reply: local.reply ?? "", kind: "local" }
}

async function handleChat(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch (error) {
    sendJson(res, 400, { error: String(error.message) })
    return
  }
  const history = Array.isArray(body.messages) ? body.messages : []
  const last = [...history].reverse().find((item) => item?.role === "user")
  const text = typeof last?.content === "string" ? last.content : ""

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  const send = (value) => {
    res.write("data: " + JSON.stringify(value) + "\n\n")
  }
  const controller = new AbortController()
  req.on("close", () => controller.abort())

  const local = text === "" ? null : handleLocal(text)
  if (local !== null) {
    const result = runLocal(local)
    send({ type: "delta", text: result.reply })
    send({ type: "done", text: result.reply, kind: result.kind, model: "local", timer: result.timer, notes: result.notes })
    res.end()
    return
  }

  const settings = store.settings()
  const messages = composeMessages({
    history,
    notes: store.notes(),
    systemPrompt: typeof settings.systemPrompt === "string" ? settings.systemPrompt : undefined,
  })
  try {
    const result = await llm.chat({
      messages,
      model: typeof body.model === "string" && body.model !== "" ? body.model : settings.model,
      onDelta: (delta) => send({ type: "delta", text: delta }),
      signal: controller.signal,
    })
    send({ type: "done", text: result.text, kind: "llm", model: result.model, aborted: result.aborted })
    log("chat", { model: result.model, chars: result.text.length, aborted: result.aborted })
  } catch (error) {
    log("chat-failed", { code: error?.code ?? null, message: String(error?.message ?? error) })
    send({ type: "error", message: String(error?.message ?? error), code: error?.code ?? null })
  }
  res.end()
}

async function route(req, res) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  const pathname = decodeURIComponent(url.pathname)

  if (pathname === "/api/status") {
    const status = await llm.status()
    sendJson(res, 200, { ...status, version: "0.1.0", notes: store.notes().length })
    return
  }

  if (pathname === "/api/models") {
    const status = await llm.status()
    sendJson(res, 200, { models: status.models, online: status.online })
    return
  }

  if (pathname === "/api/state") {
    const status = await llm.status()
    sendJson(res, 200, { status, notes: store.notes(), settings: store.settings() })
    return
  }

  if (pathname === "/api/chat" && req.method === "POST") {
    await handleChat(req, res)
    return
  }

  if (pathname === "/api/notes" && req.method === "GET") {
    sendJson(res, 200, { notes: store.notes() })
    return
  }

  if (pathname === "/api/notes" && req.method === "POST") {
    try {
      const body = await readBody(req)
      const note = store.addNote(body.text)
      sendJson(res, 200, { ok: true, note, notes: store.notes() })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error.message) })
    }
    return
  }

  if (pathname === "/api/notes" && req.method === "DELETE") {
    const id = url.searchParams.get("id") ?? ""
    const removed = store.removeNote(id)
    sendJson(res, 200, { ok: removed, notes: store.notes() })
    return
  }

  if (pathname === "/api/notes/clear" && req.method === "POST") {
    store.clearNotes()
    sendJson(res, 200, { ok: true, notes: [] })
    return
  }

  if (pathname === "/api/settings" && req.method === "POST") {
    try {
      const body = await readBody(req)
      const settings = store.saveSettings({
        model: typeof body.model === "string" ? body.model : undefined,
        voice: typeof body.voice === "string" ? body.voice : undefined,
        autospeak: typeof body.autospeak === "boolean" ? body.autospeak : undefined,
        systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
      })
      sendJson(res, 200, { ok: true, settings })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error.message) })
    }
    return
  }

  if (pathname === "/api/open" && req.method === "POST") {
    try {
      const body = await readBody(req)
      const ok = openTarget(body.target)
      sendJson(res, 200, { ok })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error.message) })
    }
    return
  }

  if (pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "Нет такого метода: " + pathname })
    return
  }

  serveStatic(req, res, pathname)
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    log("route-failed", { message: String(error?.message ?? error) })
    if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) })
    else res.end()
  })
})

const preferredPort = Number(process.env.JARVIS_PORT ?? 7788) || 7788

function listen(port, attemptsLeft) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
      log("port-busy", { port, next: port + 1 })
      listen(port + 1, attemptsLeft - 1)
      return
    }
    log("listen-failed", { port, message: String(error?.message ?? error) })
    process.exit(1)
  })
  server.listen(port, "127.0.0.1", () => {
    const address = "http://127.0.0.1:" + port
    log("ready", { url: address, model: config.model })
    console.log("")
    console.log("  Джарвис запущен:  " + address)
    console.log("  Мозг:             freePi через Andrey DS Harness (" + config.model + ")")
    console.log("  Остановить:       Ctrl+C")
    console.log("")
    if (process.env.JARVIS_OPEN === "1") {
      try {
        const opener = spawn("cmd.exe", ["/c", "start", "", address], { detached: true, stdio: "ignore", windowsHide: true })
        opener.unref()
      } catch {
        /* браузер не обязателен */
      }
    }
  })
}

listen(preferredPort, 20)

process.on("SIGINT", () => {
  log("stop")
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
})
