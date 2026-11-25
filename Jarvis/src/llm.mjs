'use strict'

/**
 * Клиент локального маршрута freePi (OpenAI-совместимый).
 *
 * Ollama тут не нужен: Andrey DS Harness уже держит HTTP-маршрут на loopback,
 * который сам подставляет токен активного freePi-аккаунта. Мы находим его порт
 * (39147, при занятости 39148..39156), получаем список моделей и стримим ответ.
 */

import { SseParser, deltaOf } from "./sse.mjs"

const PORT_FIRST = 39147
const PORT_LAST = 39156
const ROUTE_TTL_MS = 30_000

export function resolveConfig(env = process.env) {
  return {
    baseUrl: (env.JARVIS_BASE_URL || "").trim(),
    model: (env.JARVIS_MODEL || "deepseek-v4.1-flash").trim(),
    apiKey: (env.JARVIS_API_KEY || "").trim(),
  }
}

/** Кандидаты в порядке предпочтения: сначала явный адрес из .env. */
export function candidateBases(config) {
  const bases = []
  if (config.baseUrl !== "") bases.push(trimSlash(config.baseUrl))
  for (let port = PORT_FIRST; port <= PORT_LAST; port += 1) {
    const base = "http://127.0.0.1:" + port + "/freepi/v1"
    if (!bases.includes(base)) bases.push(base)
  }
  return bases
}

function trimSlash(url) {
  return url.replace(/\/+$/, "")
}

function authHeaders(config) {
  const headers = { "content-type": "application/json" }
  if (config.apiKey !== "") headers.authorization = "Bearer " + config.apiKey
  return headers
}

export class LlmClient {
  constructor(config, options = {}) {
    this.config = config
    this.timeoutMs = options.timeoutMs ?? 1200
    this.route = null
  }

  /** Находит живой маршрут и кэширует его вместе со списком моделей. */
  async ensureRoute(force = false) {
    const fresh = this.route !== null && Date.now() - this.route.at < ROUTE_TTL_MS
    if (fresh && !force) return this.route
    for (const base of candidateBases(this.config)) {
      const models = await this.probe(base)
      if (models !== null) {
        this.route = { base, models, at: Date.now() }
        return this.route
      }
    }
    this.route = null
    return null
  }

  async probe(base) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(base + "/models", {
        headers: authHeaders(this.config),
        signal: controller.signal,
      })
      if (!res.ok) return null
      const body = await res.json()
      const models = Array.isArray(body?.data)
        ? body.data.map((item) => item?.id).filter((id) => typeof id === "string")
        : []
      return models
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async status() {
    const route = await this.ensureRoute()
    if (route === null) {
      return {
        online: false,
        baseUrl: null,
        models: [],
        model: this.config.model,
        hint: "Маршрут freePi не отвечает. Запустите Andrey DS Harness и залогиньтесь в freePi.",
      }
    }
    return { online: true, baseUrl: route.base, models: route.models, model: this.config.model }
  }

  /**
   * Стримит ответ модели. onDelta получает куски текста по мере прихода.
   * Возвращает { text, model, aborted, usage }.
   */
  async chat({ messages, model, onDelta, signal }) {
    const route = await this.ensureRoute()
    if (route === null) {
      const error = new Error("Маршрут freePi недоступен")
      error.code = "NO_ROUTE"
      throw error
    }
    const chosen = typeof model === "string" && model !== "" ? model : this.config.model
    const controller = new AbortController()
    const forwardAbort = () => controller.abort()
    if (signal !== undefined) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener("abort", forwardAbort, { once: true })
    }
    const payload = {
      model: chosen,
      messages,
      stream: true,
      max_tokens: 900,
      temperature: 0.6,
    }
    let res
    try {
      res = await fetch(route.base + "/chat/completions", {
        method: "POST",
        headers: authHeaders(this.config),
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
    } catch (error) {
      if (signal?.aborted) return { text: "", model: chosen, aborted: true, usage: null }
      throw decorate(error, "Маршрут freePi оборвал соединение")
    }
    if (!res.ok) {
      const detail = await safeText(res)
      const error = new Error(httpHint(res.status, detail))
      error.code = String(res.status)
      error.detail = detail
      throw error
    }
    if (res.body === null) {
      const error = new Error("Маршрут вернул пустой поток")
      error.code = "EMPTY_STREAM"
      throw error
    }
    const parser = new SseParser()
    const decoder = new TextDecoder("utf-8")
    let text = ""
    let usage = null
    try {
      for await (const chunk of res.body) {
        for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
          if (event.includes("\"usage\"")) usage = readUsage(event) ?? usage
          const delta = deltaOf(event)
          if (delta === "") continue
          text += delta
          if (typeof onDelta === "function") onDelta(delta)
        }
      }
      for (const event of parser.flush()) {
        const delta = deltaOf(event)
        if (delta === "") continue
        text += delta
        if (typeof onDelta === "function") onDelta(delta)
      }
    } catch (error) {
      if (controller.signal.aborted) return { text, model: chosen, aborted: true, usage }
      throw decorate(error, "Поток ответа прервался")
    } finally {
      if (signal !== undefined) signal.removeEventListener("abort", forwardAbort)
    }
    return { text, model: chosen, aborted: false, usage }
  }
}

function readUsage(event) {
  try {
    return JSON.parse(event)?.usage ?? null
  } catch {
    return null
  }
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 400)
  } catch {
    return ""
  }
}

function httpHint(status, detail) {
  const tail = detail === "" ? "" : " (" + detail.slice(0, 160) + ")"
  if (status === 401 || status === 403) {
    return "freePi не пускает: " + status + ". Войдите в аккаунт freePi в Andrey DS Harness." + tail
  }
  if (status === 404) return "Такой модели или пути нет на маршруте (404)" + tail
  if (status === 429) return "freePi просит подождать: слишком много запросов (429)" + tail
  return "Маршрут ответил " + status + tail
}

function decorate(error, prefix) {
  const result = new Error(prefix + ": " + (error?.message ?? error))
  result.code = error?.code ?? "NETWORK"
  return result
}
