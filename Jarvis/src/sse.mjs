'use strict'

/**
 * Разбор потока server-sent events от OpenAI-совместимого маршрута.
 *
 * Модуль ничего не знает про сеть: на вход идут куски текста, на выходе -
 * готовые события data: {...}. Так его можно проверить в node:test без сервера.
 */

export class SseParser {
  constructor() {
    this.buffer = ""
  }

  /** Принимает очередной кусок ответа и возвращает массив payload-строк. */
  push(chunk) {
    this.buffer += chunk
    const events = []
    let index = this.buffer.indexOf("\n\n")
    while (index !== -1) {
      const block = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 2)
      const payload = payloadOf(block)
      if (payload !== null) events.push(payload)
      index = this.buffer.indexOf("\n\n")
    }
    return events
  }

  /** Хвост без завершающего перевода строки. */
  flush() {
    const rest = this.buffer.trim()
    this.buffer = ""
    if (rest === "") return []
    const payload = payloadOf(rest)
    return payload === null ? [] : [payload]
  }
}

function payloadOf(block) {
  const lines = block.split(/\r?\n/)
  const parts = []
  for (const line of lines) {
    if (line.startsWith("data:")) parts.push(line.slice(5).trimStart())
  }
  if (parts.length === 0) return null
  const data = parts.join("\n").trim()
  if (data === "" || data === "[DONE]") return null
  return data
}

/** Текст ответа из одного события; reasoning-модели кладут мысли отдельно. */
export function deltaOf(payload) {
  let event
  try {
    event = JSON.parse(payload)
  } catch {
    return ""
  }
  const choice = event?.choices?.[0]
  if (choice === undefined || choice === null) return ""
  const content = choice.delta?.content
  return typeof content === "string" ? content : ""
}
