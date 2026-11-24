'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * Mount the browser bridge as an MCP server named `browser`.
 *
 * A profile's `cordis.patch.yml` is a list of *patch* operations, not a list of
 * plugins: an entry with only an `id` targets an existing entry (and a
 * not-found id is dropped with a warning), while new plugins must arrive inside
 * an `insert:` list. This was learned the hard way: the first version appended
 * `- id: browser-bridge` and the host silently ignored it, so the bridge never
 * started.
 *
 * The file is edited as text on purpose. It is the user's own patch layer and
 * may hold comments and `!!js` expressions that a parse/stringify round trip
 * would destroy; only blocks that carry our id are cut out, everything else is
 * left byte for byte.
 */

const ENTRY_ID = 'browser-bridge'
const PLUGIN = '@deepseek-ai/dsh-mcp-client'
const SERVER_NAME = 'browser'
const STARTUP_TIMEOUT_MS = 30000
const TOOL_CALL_TIMEOUT_MS = 180000

/** Matches the row that declares our id anywhere inside a patch block. */
const ID_LINE = /^(\s*)-\s*id:\s*['"]?browser-bridge['"]?\s*$/

/** The bundled runtime's own Node, because the host may have none on PATH. */
function resolveNodePath(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    path.resolve(__dirname, '..', '..', '..', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node'),
  ]
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  return process.execPath
}

function wantedConfig({ mcpServerPath, nodePath, dataRoot }) {
  return {
    transport: 'stdio',
    serverName: SERVER_NAME,
    command: nodePath,
    args: [mcpServerPath],
    env: dataRoot ? { ANDREY_DATA_ROOT: dataRoot } : {},
    cwd: path.dirname(mcpServerPath),
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: false,
  }
}

/** A YAML single-quoted scalar: the one form that keeps Windows paths literal. */
function quoted(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/** The rows of one insert patch, indented under `- insert:`. */
function renderRows(config) {
  const rows = [
    '    - id: ' + ENTRY_ID,
    '      name: ' + quoted(PLUGIN),
    '      config:',
    '        transport: ' + quoted(config.transport),
    '        serverName: ' + quoted(config.serverName),
    '        command: ' + quoted(config.command),
    '        args:',
    '          - ' + quoted(config.args[0]),
  ]
  const envKeys = Object.keys(config.env || {})
  if (envKeys.length === 0) {
    rows.push('        env: {}')
  } else {
    rows.push('        env:')
    for (const key of envKeys) rows.push('          ' + key + ': ' + quoted(config.env[key]))
  }
  rows.push('        cwd: ' + quoted(config.cwd))
  rows.push('        startupTimeoutMs: ' + config.startupTimeoutMs)
  rows.push('        toolCallTimeoutMs: ' + config.toolCallTimeoutMs)
  rows.push('        failOnStartupError: ' + String(Boolean(config.failOnStartupError)))
  return rows
}

/**
 * Split a patch file into top-level list items.
 *
 * A top-level item starts at column zero with `-`; blank lines end it, so the
 * separator between two entries is never swallowed when an entry is removed.
 */
function splitBlocks(lines) {
  const blocks = []
  let current = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^-(\s|$)/.test(line)) {
      if (current !== null) blocks.push(current)
      current = { start: index, lines: [line] }
      continue
    }
    if (current === null) continue
    if (line.trim() === '') {
      blocks.push(current)
      current = null
      continue
    }
    current.lines.push(line)
  }
  if (current !== null) blocks.push(current)
  return blocks.map((block) => Object.assign({}, block, { end: block.start + block.lines.length }))
}

/** Compare a file block with the one we would write, ignoring quoting style. */
function canonical(text) {
  return text.replace(/[\s'"]+/g, '').toLowerCase()
}

function applyBrowserProfileSync({ profilePath, mcpServerPath, dataRoot, nodePath } = {}) {
  try {
    if (!profilePath || !mcpServerPath) return { ok: false, error: 'missing-arguments' }
    if (!fs.existsSync(profilePath)) return { ok: false, error: 'profile-missing' }

    const config = wantedConfig({ mcpServerPath, nodePath: resolveNodePath(nodePath), dataRoot })
    const block = ['- insert:', ...renderRows(config)].join('\n')

    const text = fs.readFileSync(profilePath, 'utf8')
    const lines = text.split(/\r?\n/)
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

    const owned = splitBlocks(lines).filter((item) => item.lines.some((line) => ID_LINE.test(line)))
    // Idempotent when exactly one insert block holds our row and it already says
    // what we want; a plain `- id:` block is the old broken shape and is repaired.
    const unchanged = owned.length === 1 &&
      owned[0].lines[0].startsWith('- insert') &&
      canonical(owned[0].lines.join('\n')) === canonical(block)
    if (unchanged) return { ok: true, changed: false }

    const kept = lines.slice()
    for (let index = owned.length - 1; index >= 0; index -= 1) {
      kept.splice(owned[index].start, owned[index].end - owned[index].start)
    }
    while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()

    let out
    if (kept.length === 1 && kept[0].trim() === '[]') {
      out = block + '\n'
    } else if (kept.length === 0) {
      out = block + '\n'
    } else {
      out = kept.join('\n') + '\n\n' + block + '\n'
    }
    fs.writeFileSync(profilePath, out)
    return { ok: true, changed: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

module.exports = { applyBrowserProfileSync, resolveNodePath, wantedConfig, renderRows, ENTRY_ID, PLUGIN, SERVER_NAME }
