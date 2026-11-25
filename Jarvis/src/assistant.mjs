'use strict'

/**
 * Локальная часть Джарвиса: команды, которые не нужно отправлять модели.
 *
 * Часы, дата, открытие программ и сайтов, заметки, таймер и загрузка машины
 * отвечают мгновенно и работают даже без freePi. Всё остальное уходит в LLM.
 */

import os from "node:os"

const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
]

const WEEKDAYS = [
  "воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота",
]

const APPS = {
  "блокнот": "notepad",
  "калькулятор": "calc",
  "проводник": "explorer",
  "проводнике": "explorer",
  "паинт": "mspaint",
  "paint": "mspaint",
  "консоль": "cmd",
  "терминал": "wt",
  "диспетчер задач": "taskmgr",
  "параметры": "ms-settings:",
  "настройки": "ms-settings:",
  "word": "winword",
  "ворд": "winword",
  "excel": "excel",
  "эксель": "excel",
  "telegram": "tg://",
  "телеграм": "tg://",
  "телеграмм": "tg://",
  "steam": "steam://open/main",
}

const SITES = {
  "ютуб": "https://youtube.com",
  "youtube": "https://youtube.com",
  "гугл": "https://google.com",
  "google": "https://google.com",
  "яндекс": "https://ya.ru",
  "github": "https://github.com",
  "гитхаб": "https://github.com",
  "почту": "https://mail.google.com",
  "почта": "https://mail.google.com",
  "карты": "https://yandex.ru/maps",
  "погоду": "https://yandex.ru/pogoda",
  "погода": "https://yandex.ru/pogoda",
}

function pad(value) {
  return String(value).padStart(2, "0")
}

export function timeReply(date = new Date()) {
  return "Сейчас " + pad(date.getHours()) + ":" + pad(date.getMinutes())
}

export function dateReply(date = new Date()) {
  return (
    "Сегодня " + WEEKDAYS[date.getDay()] + ", " + date.getDate() + " " +
    MONTHS[date.getMonth()] + " " + date.getFullYear() + " года"
  )
}

function plural(count, one, few, many) {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}

export function timerReply(amount, unit) {
  const unitName = unit === "minutes" ? plural(amount, "минуту", "минуты", "минут") : plural(amount, "секунду", "секунды", "секунд")
  return "Таймер на " + amount + " " + unitName + " пошёл"
}

export function systemReply() {
  const totalGb = os.totalmem() / 1024 ** 3
  const freeGb = os.freemem() / 1024 ** 3
  const usedPercent = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100)
  const cpus = os.cpus()
  const load = os.loadavg()[0]
  return (
    "Память занята на " + usedPercent + "%: " + freeGb.toFixed(1) + " ГБ свободно из " +
    totalGb.toFixed(0) + " ГБ. Процессор: " + cpus.length + " ядер, средняя загрузка " +
    load.toFixed(2) + "."
  )
}

function normalize(text) {
  return String(text ?? "").trim().replace(/\s+/g, " ")
}

/** Куда открывать: известное приложение, известный сайт или голый адрес. */
export function resolveTarget(raw) {
  const target = normalize(raw).toLowerCase().replace(/[.!?,]+$/, "")
  if (target === "") return null
  if (APPS[target] !== undefined) return { type: "app", value: APPS[target], label: target }
  if (SITES[target] !== undefined) return { type: "url", value: SITES[target], label: target }
  const words = target.split(" ")
  const guessSite = SITES[words[0]]
  if (guessSite !== undefined) return { type: "url", value: guessSite, label: guessSite }
  if (/^[a-z0-9-]+(\.[a-z]{2,})+(\/\S*)?$/.test(target) || target.startsWith("http")) {
    const url = target.startsWith("http") ? target : "https://" + target
    return { type: "url", value: url, label: url }
  }
  return null
}

/**
 * Разбирает реплику до обращения к модели.
 * Возвращает { reply, action } для локальной команды или null.
 */
export function handleLocal(text) {
  const phrase = normalize(text).toLowerCase().replace(/[!?.,]+$/, "")
  if (phrase === "") return null

  if (/^(котор(ый|ое) час|сколько (сейчас )?врем(я|ени)|время)$/.test(phrase) || /который (сейчас )?час/.test(phrase) || /сколько (сейчас )?врем/.test(phrase)) {
    return { reply: timeReply() }
  }
  if (/^(какое сегодня|какой сегодня|какое число|сегодняшняя дата|дата)$/.test(phrase) || /(какое|какой) (сегодня )?(число|день|дата)/.test(phrase)) {
    return { reply: dateReply() }
  }

  const openMatch = phrase.match(/^(?:открой|запусти|включи|открыть) (?:мне )?(.+)$/)
  if (openMatch !== null) {
    const target = resolveTarget(openMatch[1])
    if (target === null) {
      return { reply: "Не знаю, как открыть «" + openMatch[1] + "». Скажи название программы или адрес сайта." }
    }
    return {
      reply: "Открываю " + openMatch[1].trim(),
      action: { type: "open", target },
    }
  }

  const rememberMatch = text.match(/^\s*запомни[\s,:]+(.+)$/i)
  if (rememberMatch !== null) {
    return { reply: "Запомнил: " + rememberMatch[1].trim(), action: { type: "remember", text: rememberMatch[1].trim() } }
  }

  if (/(покажи|что ты) (мои )?заметк|что (ты )?запомнил|список заметок/.test(phrase)) {
    return { action: { type: "list-notes" } }
  }
  if (/^(очисти|удали) (все )?заметки$/.test(phrase)) {
    return { reply: "Заметки очищены", action: { type: "clear-notes" } }
  }

  const timerMatch = phrase.match(/^таймер на (\d+) ?(минут|минуту|минуты|мин|секунд|секунду|секунды|сек)$/)
  if (timerMatch !== null) {
    const amount = Number(timerMatch[1])
    const unit = timerMatch[2].startsWith("мин") ? "minutes" : "seconds"
    const seconds = unit === "minutes" ? amount * 60 : amount
    return { reply: timerReply(amount, unit), action: { type: "timer", seconds, label: "Таймер" } }
  }

  if (/(сколько|какая|покажи).{0,20}(памят|cpu|процессор|загрузк|озу)/.test(phrase)) {
    return { reply: systemReply() }
  }

  if (/^(стоп|хватит|замолчи|отмена)$/.test(phrase)) {
    return { reply: "Хорошо", action: { type: "stop" } }
  }

  return null
}

export const DEFAULT_PROMPT = [
  "Ты - Джарвис, голосовой ассистент пользователя на его компьютере с Windows.",
  "Отвечай по-русски, кратко и по делу: две-четыре фразы, если не попросили подробнее.",
  "Твой ответ читается голосом, поэтому без списков, таблиц, markdown и смайликов.",
  "Не выдумывай факты; если не знаешь - скажи это прямо.",
  "Данные ниже - то, что пользователь просил запомнить.",
].join(" ")

/** Сообщения для модели: системный характер + память + последние реплики. */
export function composeMessages({ history, notes, systemPrompt }) {
  const messages = []
  const memory = (notes ?? []).slice(0, 12).map((note) => "- " + note.text).join("\n")
  const prompt = [systemPrompt || DEFAULT_PROMPT]
  if (memory !== "") prompt.push("Память:\n" + memory)
  messages.push({ role: "system", content: prompt.join("\n\n") })
  for (const item of (history ?? []).slice(-14)) {
    if (item.role !== "user" && item.role !== "assistant") continue
    if (typeof item.content !== "string" || item.content.trim() === "") continue
    messages.push({ role: item.role, content: item.content.slice(0, 4000) })
  }
  return messages
}

/** Заметки для голоса: без id и служебных полей. */
export function notesSpeech(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return "Заметок пока нет"
  const shown = notes.slice(0, 6).map((note, index) => index + 1 + ". " + note.text)
  const tail = notes.length > 6 ? ". И ещё " + (notes.length - 6) + " в панели" : ""
  return "Ты просил запомнить: " + shown.join(". ") + tail
}
