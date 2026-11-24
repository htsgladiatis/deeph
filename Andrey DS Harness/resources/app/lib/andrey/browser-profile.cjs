'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { runtimeRequire } = require('./pi-profile.cjs')

/**
 * Mount the browser bridge as an MCP server named `browser`.
 *
 * The host reads this profile when it mounts plugins, so the entry has to exist
 * before `main.js` runs. The command is the bundled Node binary (a packaged app
 * has no `node` on PATH) and the script is the stdio entry in ./browser. Only our
 * own entry with our own id is touched; a host rewrite that drops it is repaired
 * on the next boot.
 */

const ENTRY_ID = 'browser-bridge'
const PLUGIN = '@deepseek-ai/dsh-mcp-client'
const SERVER_NAME = 'browser'

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
    startupTimeoutMs: 30000,
    toolCallTimeoutMs: 180000,
    failOnStartupError: false,
  }
}

function sameEntry(entry, config) {
  const current = entry?.config
  if (!current || typeof current !== 'object') return false
  if (current.transport !== config.transport) return false
  if (current.serverName !== config.serverName) return false
  if (current.command !== config.command) return false
  if (JSON.stringify(current.args || []) !== JSON.stringify(config.args)) return false
  if (current.cwd !== config.cwd) return false
  if (current.startupTimeoutMs !== config.startupTimeoutMs) return false
  if (current.toolCallTimeoutMs !== config.toolCallTimeoutMs) return false
  const env = current.env || {}
  const wantedEnv = config.env || {}
  return Object.keys(wantedEnv).every((key) => env[key] === wantedEnv[key])
}

function applyBrowserProfileSync({ profilePath, mcpServerPath, dataRoot, nodePath } = {}) {
  try {
    if (!profilePath || !mcpServerPath) return { ok: false, error: 'missing-arguments' }
    if (!fs.existsSync(profilePath)) return { ok: false, error: 'profile-missing' }

    const YAML = runtimeRequire('yaml')
    const doc = YAML.parse(fs.readFileSync(profilePath, 'utf8'))
    if (!Array.isArray(doc)) return { ok: false, error: 'profile-not-a-list' }

    const config = wantedConfig({ mcpServerPath, nodePath: resolveNodePath(nodePath), dataRoot })
    let changed = false

    let entry = doc.find((item) => item && item.id === ENTRY_ID)
    if (!entry) {
      entry = { id: ENTRY_ID, name: PLUGIN, config }
      doc.push(entry)
      changed = true
    } else {
      if (entry.name !== PLUGIN) {
        entry.name = PLUGIN
        changed = true
      }
      if (!sameEntry(entry, config)) {
        entry.config = config
        changed = true
      }
    }

    if (!changed) return { ok: true, changed: false }
    fs.writeFileSync(profilePath, YAML.stringify(doc))
    return { ok: true, changed: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

module.exports = { applyBrowserProfileSync, resolveNodePath, wantedConfig, ENTRY_ID, PLUGIN, SERVER_NAME }
