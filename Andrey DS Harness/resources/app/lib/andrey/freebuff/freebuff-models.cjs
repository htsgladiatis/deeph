'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { cliConfigDir } = require('./freebuff-cli.cjs')

/**
 * The Freebuff model list lives inside the CLI's own `/model` picker. The API
 * route that feeds it needs the CLI's signed device key, so instead of
 * re-implementing that signature we read the picker the official client draws
 * and drive it with arrow keys — same client, same gate, no bypass.
 *
 * The TUI redraws the whole screen repeatedly, so the captured stream holds
 * several frames. Names keep their first-seen order (the picker's order), and
 * the `›` marker is taken from the newest frame.
 */

const ANSI = /\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][A-Za-z0-9]/g

function stripAnsi(raw) {
  return String(raw ?? '').replace(ANSI, ' ')
}

/** Lines of a boxed card: `│ › Name · description │`, badges on the next line. */
function parsePicker(raw) {
  const text = stripAnsi(raw)
  if (!/choose model|↑↓/i.test(text)) return { open: false, entries: [], selected: null }

  const order = []
  const last = new Map()
  for (const line of text.split(/\r?\n/)) {
    const first = line.indexOf('│')
    const lastBar = line.lastIndexOf('│')
    if (first < 0 || lastBar <= first) continue
    let inner = line.slice(first + 1, lastBar).trim()
    if (!inner) continue
    const selected = inner.startsWith('›')
    if (selected) inner = inner.slice(1).trim()
    // A card reads `Name • level · description`; the name ends at ` • `. Usage
    // counters (`10/17`) are badges, not part of the name.
    const name = inner.split(' · ')[0].split(' • ')[0]
      .replace(/\s+\d+\s*\/\s*\d+$/, '')
      .trim()
    if (!name || !inner.includes(' · ')) continue
    if (/^(may use data|paid plan|promotional|free|recommended|best|best value)$/i.test(name)) continue
    if (!last.has(name)) order.push(name)
    last.set(name, selected)
  }

  const entries = order.map((name) => ({ name, selected: last.get(name) === true }))
  return { open: true, entries, selected: entries.find((entry) => entry.selected)?.name ?? null }
}

function settingsPath({ userHome } = {}) {
  return path.join(cliConfigDir({ userHome }), 'settings.json')
}

function readCliSettings({ userHome } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath({ userHome }), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Drives the picker through the pty. `write` sends raw keystrokes, `capture`
 * returns everything printed since `mark()`, and `sleep` keeps tests instant.
 */
function createModelController({ write, capture, mark, userHome, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const openPicker = async () => {
    mark?.()
    write('/model')
    await sleep(60)
    write('\r')
    await sleep(900)
    return parsePicker(await capture())
  }

  return {
    async list() {
      let parsed = await openPicker()
      if (!parsed.open) {
        await sleep(500)
        parsed = parsePicker(await capture())
      }
      if (!parsed.open) {
        return { ok: true, models: [], current: null, open: false }
      }

      const current = parsed.selected
      // The picker scrolls: walk it to the top, then step down, collecting every
      // card once. Names keep the order they first appear in, so the panel shows
      // the same order the CLI does.
      for (let i = 0; i < 12; i += 1) {
        write('\x1b[A')
        await sleep(40)
      }
      const names = []
      const seen = new Set()
      let previous = null
      for (let step = 0; step < 24; step += 1) {
        parsed = parsePicker(await capture())
        for (const entry of parsed.entries) {
          if (seen.has(entry.name)) continue
          seen.add(entry.name)
          names.push(entry.name)
        }
        if (previous && parsed.selected === previous) break
        previous = parsed.selected
        write('\x1b[B')
        await sleep(90)
      }
      write('\x1b')
      await sleep(80)
      return {
        ok: true,
        models: names.map((name) => ({ name })),
        current,
        open: true,
      }
    },

    async select(target) {
      const wanted = String(target ?? '').trim()
      if (!wanted) return { ok: false, error: 'invalid-model' }
      let parsed = await openPicker()
      if (!parsed.open) {
        await sleep(500)
        parsed = parsePicker(await capture())
      }
      if (!parsed.open || parsed.entries.length === 0) {
        write('\x1b')
        return { ok: false, error: 'picker-unavailable' }
      }

      // The picker only renders a window, so the target may be off-screen. Walk
      // to the top first, then step down until the selection marker reaches it.
      for (let step = 0; step < 14; step += 1) {
        write('\x1b[A')
        await sleep(35)
      }
      for (let step = 0; step < 48; step += 1) {
        parsed = parsePicker(await capture())
        if (parsed.selected === wanted) break
        write('\x1b[B')
        await sleep(90)
      }
      if (parsed.selected !== wanted) {
        write('\x1b')
        await sleep(60)
        return { ok: false, error: 'model-not-selected' }
      }

      write('\r')
      await sleep(350)
      const settings = readCliSettings({ userHome })
      return { ok: true, model: wanted, id: settings.freebuffModel ?? null }
    },
  }
}

module.exports = {
  stripAnsi,
  parsePicker,
  settingsPath,
  readCliSettings,
  createModelController,
}
