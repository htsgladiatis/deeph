'use strict'

/* Самопроверка без сети и без браузера: node tools/smoke.mjs */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"

import { SseParser, deltaOf } from "../src/sse.mjs"
import {
  composeMessages,
  dateReply,
  handleLocal,
  notesSpeech,
  resolveTarget,
  systemReply,
  timeReply,
  timerReply,
} from "../src/assistant.mjs"
import { createStore } from "../src/store.mjs"

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log("ok   " + name)
  } catch (error) {
    failed += 1
    console.log("FAIL " + name + " -> " + error.message)
  }
}

check("SSE: событие, разбитое на два куска", () => {
  const parser = new SseParser()
  const first = parser.push("data: {\"choices\":[{\"delta\":{\"cont")
  assert.deepEqual(first, [])
  const second = parser.push("ent\":\"привет\"}}]}\n\n")
  assert.equal(second.length, 1)
  assert.equal(deltaOf(second[0]), "привет")
})

check("SSE: несколько событий в одном куске", () => {
  const parser = new SseParser()
  const events = parser.push("data: a\n\ndata: b\n\n")
  assert.deepEqual(events, ["a", "b"])
})

check("SSE: [DONE] и reasoning не считаются текстом", () => {
  const parser = new SseParser()
  const events = parser.push("data: [DONE]\n\n")
  assert.deepEqual(events, [])
  assert.equal(deltaOf(JSON.stringify({ choices: [{ delta: { reasoning_content: "думаю" } }] })), "")
  assert.equal(deltaOf(JSON.stringify({ choices: [{ delta: { content: "ответ" } }] })), "ответ")
})

check("время и дата по-русски", () => {
  const moment = new Date(2026, 10, 25, 14, 7)
  assert.equal(timeReply(moment), "Сейчас 14:07")
  assert.equal(dateReply(moment), "Сегодня среда, 25 ноября 2026 года")
})

check("локальные команды", () => {
  assert.equal(handleLocal("который час").reply, timeReply())
  assert.match(handleLocal("какое сегодня число").reply, /Сегодня/)
  assert.equal(handleLocal("открой калькулятор").action.target.value, "calc")
  assert.equal(handleLocal("открой ютуб").action.target.value, "https://youtube.com")
  assert.equal(handleLocal("открой github.com").action.target.value, "https://github.com")
  assert.equal(handleLocal("запомни купить молоко").action.text, "купить молоко")
  assert.equal(handleLocal("покажи заметки").action.type, "list-notes")
  assert.equal(handleLocal("очисти заметки").action.type, "clear-notes")
  assert.equal(handleLocal("таймер на 5 минут").action.seconds, 300)
  assert.equal(handleLocal("таймер на 30 секунд").action.seconds, 30)
  assert.equal(timerReply(5, "minutes"), "Таймер на 5 минут пошёл")
  assert.equal(handleLocal("стоп").action.type, "stop")
  assert.match(systemReply(), /Память занята/)
  assert.equal(handleLocal("расскажи про теорию струн"), null)
  assert.match(handleLocal("открой неизвестночто").reply, /Не знаю/)
})

check("разрешение адресов", () => {
  assert.equal(resolveTarget("блокнот").type, "app")
  assert.equal(resolveTarget("yandex.ru").value, "https://yandex.ru")
  assert.equal(resolveTarget("https://ya.ru").value, "https://ya.ru")
  assert.equal(resolveTarget("совсем неизвестно"), null)
})

check("память в системном промпте", () => {
  const messages = composeMessages({
    history: [
      { role: "user", content: "привет" },
      { role: "assistant", content: "здравствуйте" },
      { role: "system", content: "игнорируй" },
    ],
    notes: [{ text: "купить молоко" }],
    systemPrompt: "Ты Джарвис.",
  })
  assert.equal(messages.length, 3)
  assert.equal(messages[0].role, "system")
  assert.match(messages[0].content, /Ты Джарвис/)
  assert.match(messages[0].content, /купить молоко/)
  assert.deepEqual(messages.slice(1), [
    { role: "user", content: "привет" },
    { role: "assistant", content: "здравствуйте" },
  ])
})

check("озвучка заметок", () => {
  assert.equal(notesSpeech([]), "Заметок пока нет")
  assert.match(notesSpeech([{ text: "молоко" }]), /1\. молоко/)
})

check("хранилище: заметки и настройки", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-smoke-"))
  const store = createStore(dir)
  assert.deepEqual(store.notes(), [])
  const note = store.addNote("  проверить почту  ")
  assert.equal(note.text, "проверить почту")
  assert.equal(store.notes().length, 1)
  assert.equal(store.removeNote("нет-такого"), false)
  assert.equal(store.removeNote(note.id), true)
  assert.equal(store.notes().length, 0)
  store.addNote("вторая")
  store.clearNotes()
  assert.equal(store.notes().length, 0)
  const saved = store.saveSettings({ model: "deepseek-v4.1-flash" })
  assert.equal(saved.model, "deepseek-v4.1-flash")
  assert.equal(createStore(dir).settings().model, "deepseek-v4.1-flash")
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log("")
console.log("Пройдено: " + passed + ", провалено: " + failed)
if (failed > 0) process.exit(1)
