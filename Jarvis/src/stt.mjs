'use strict'

/**
 * Локальное распознавание речи на Vosk: работает без интернета.
 *
 * Python-воркер (stt/stt_worker.py) читает со stdin куски PCM16 mono 16 kHz,
 * обрамлённые 4-байтовой длиной, и печатает построчный JSON с partial/final.
 * Класс LocalStt прячет процесс и превращает его вывод в события.
 */

import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import path from "node:path"

/** Ищет распакованную модель vosk-model-* в каталоге models. */
export function findModel(root) {
  const dir = path.join(root, "models")
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  const found = names
    .filter((name) => name.startsWith("vosk-model"))
    .map((name) => path.join(dir, name))
    .find((target) => {
      try {
        return fs.statSync(target).isDirectory()
      } catch {
        return false
      }
    })
  return found ?? null
}

export function sttStatus(root) {
  const model = findModel(root)
  return {
    available: model !== null,
    model: model === null ? null : path.basename(model),
  }
}

function frame(buffer) {
  const header = Buffer.alloc(4)
  header.writeUInt32LE(buffer.length, 0)
  return Buffer.concat([header, buffer])
}

export class LocalStt extends EventEmitter {
  constructor(options) {
    super()
    this.python = options.python ?? "python"
    this.worker = options.worker
    this.model = options.model
    this.child = null
    this.ready = false
    this.lastPartial = ""
  }

  start() {
    if (this.child !== null) return this.ready
    const child = spawn(this.python, ["-u", this.worker, this.model], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.child = child
    this.ready = false
    let pending = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      pending += chunk
      let index = pending.indexOf("\n")
      while (index !== -1) {
        const line = pending.slice(0, index).trim()
        pending = pending.slice(index + 1)
        if (line !== "") this.handleLine(line)
        index = pending.indexOf("\n")
      }
    })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim()
      if (text !== "" && !text.startsWith("LOG")) this.emit("stderr", text.slice(0, 400))
    })
    child.on("error", (error) => {
      this.emit("error", error)
      this.child = null
      this.ready = false
    })
    child.on("exit", (code) => {
      this.child = null
      this.ready = false
      this.emit("exit", code)
    })
    return false
  }

  handleLine(line) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (event.ready === true) {
      this.ready = true
      this.emit("ready")
      return
    }
    if (typeof event.error === "string") {
      this.emit("error", new Error(event.error))
      return
    }
    if (typeof event.partial === "string") {
      if (event.partial !== this.lastPartial) {
        this.lastPartial = event.partial
        this.emit("partial", event.partial)
      }
      return
    }
    if (typeof event.final === "string") {
      this.lastPartial = ""
      this.emit("final", event.final)
    }
  }

  push(buffer) {
    if (this.child === null || this.child.stdin.writable === false) return false
    try {
      this.child.stdin.write(frame(Buffer.from(buffer)))
      return true
    } catch {
      return false
    }
  }

  stop() {
    const child = this.child
    this.child = null
    this.ready = false
    this.lastPartial = ""
    if (child === null) return
    try {
      child.stdin.end()
    } catch {
      /* уже закрыт */
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* уже мёртв */
      }
    }, 1500)
    child.once("exit", () => clearTimeout(timer))
  }
}