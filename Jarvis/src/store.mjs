'use strict'

/**
 * Память и настройки Джарвиса.
 *
 * Всё лежит рядом с программой, в Jarvis/data: заметки (memory.json) и
 * настройки (settings.json). Никаких баз и зависимостей - обычный JSON.
 */

import fs from "node:fs"
import path from "node:path"

const emptyMemory = () => ({ notes: [] })

export function createStore(dir) {
  const dataDir = dir
  const memoryFile = path.join(dataDir, "memory.json")
  const settingsFile = path.join(dataDir, "settings.json")
  fs.mkdirSync(dataDir, { recursive: true })

  function readJson(file, fallback) {
    try {
      const text = fs.readFileSync(file, "utf8")
      const parsed = JSON.parse(text)
      return parsed !== null && typeof parsed === "object" ? parsed : fallback
    } catch {
      return fallback
    }
  }

  function writeJson(file, value) {
    const tmp = file + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8")
    fs.renameSync(tmp, file)
  }

  function memory() {
    const value = readJson(memoryFile, emptyMemory())
    const notes = Array.isArray(value.notes) ? value.notes : []
    return { notes }
  }

  return {
    dataDir,

    notes() {
      return memory().notes
    },

    addNote(text) {
      const clean = String(text ?? "").trim()
      if (clean === "") throw new Error("Пустая заметка")
      const state = memory()
      const note = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: clean, ts: new Date().toISOString() }
      state.notes.unshift(note)
      state.notes = state.notes.slice(0, 200)
      writeJson(memoryFile, state)
      return note
    },

    removeNote(id) {
      const state = memory()
      const before = state.notes.length
      state.notes = state.notes.filter((note) => note.id !== id)
      writeJson(memoryFile, state)
      return before !== state.notes.length
    },

    clearNotes() {
      writeJson(memoryFile, emptyMemory())
    },

    settings() {
      return readJson(settingsFile, {})
    },

    saveSettings(patch) {
      const current = readJson(settingsFile, {})
      const next = { ...current, ...(patch ?? {}) }
      writeJson(settingsFile, next)
      return next
    },
  }
}
