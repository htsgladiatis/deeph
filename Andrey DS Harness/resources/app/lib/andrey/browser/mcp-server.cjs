'use strict'

/**
 * The MCP stdio endpoint the harness mounts as `browser`.
 *
 * This process is the whole server side of the bridge: it owns the pairing
 * state, listens for the extension on ws://127.0.0.1:<port>/ext, exposes the
 * tools to the model over stdio, and serves a token-authenticated /control
 * endpoint that the app's own UI uses (the renderer cannot open a WebSocket to
 * loopback from a dsh-app:// origin, but it can fetch its own route).
 *
 * stdout belongs to the JSON-RPC stream; every diagnostic goes to stderr.
 */

const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')

const { openState } = require('./state.cjs')
const { createBridge } = require('./bridge.cjs')
const { createTools } = require('./tools.cjs')
const { createMcpServer } = require('./mcp.cjs')

const VERSION = '0.1.0'

function resolveDataRoot() {
  const base = process.env.ANDREY_DATA_ROOT || path.join(process.env.APPDATA || process.env.HOME || '.', 'andrey-ds-harness')
  return path.join(base, 'browser')
}

function stderrLogger() {
  const write = (level) => (message) => {
    try {
      process.stderr.write('[' + level + '] browser: ' + String(message) + '\n')
    } catch {
      /* stderr is best effort */
    }
  }
  return { info: write('info'), warn: write('warn'), error: write('error') }
}

async function createRuntime({ dir, logger = stderrLogger() } = {}) {
  const root = dir || resolveDataRoot()
  fs.mkdirSync(root, { recursive: true })
  const state = openState({ dir: root })

  let bridge = null
  let toolList = []

  async function control(action, body = {}) {
    switch (action) {
      case 'status':
        return bridge.status()
      case 'pair':
        return { code: state.pairCode }
      case 'permissions.list':
        return { permissions: state.listPermissions() }
      case 'permissions.set': {
        const mode = String(body.mode || '')
        if (!['ask', 'allow', 'block'].includes(mode)) return { error: 'bad-mode' }
        return state.setPermission(String(body.origin || ''), mode)
      }
      case 'permissions.clear':
        state.clearPermission(String(body.origin || ''))
        return { ok: true }
      case 'pause':
        state.paused.set(true)
        return { paused: true }
      case 'resume':
        return bridge.resume()
      case 'rotate-token':
        return { token: state.rotateToken(), code: state.regeneratePairCode() }
      case 'audit':
        return { rows: state.readAudit(Number(body.limit) || 100) }
      default:
        throw Object.assign(new Error('unknown control action: ' + action), { status: 400 })
    }
  }

  bridge = createBridge({ state, logger, onControl: control })
  toolList = createTools({ bridge, state })
  const mcp = createMcpServer({ tools: toolList, name: 'browser', version: VERSION, logger })

  async function start() {
    const { port } = await bridge.start()
    try {
      fs.writeFileSync(path.join(root, 'bridge.json'), JSON.stringify({ port, pid: process.pid, updatedAt: new Date().toISOString() }), 'utf8')
    } catch {
      /* discovery is a convenience, not a requirement */
    }
    return { port }
  }

  return { root, state, bridge, tools: toolList, mcp, control, start, stop: () => bridge.stop() }
}

async function runStdio() {
  const runtime = await createRuntime()
  await runtime.start()
  const logger = stderrLogger()

  const queue = []
  let busy = false
  const flush = async () => {
    if (busy) return
    busy = true
    while (queue.length > 0) {
      const message = queue.shift()
      let response = null
      try {
        response = await runtime.mcp.handle(message)
      } catch (error) {
        logger.error('unhandled: ' + String(error?.message || error))
        if (message && message.id !== undefined) response = { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'internal error' } }
      }
      if (response) process.stdout.write(JSON.stringify(response) + '\n')
    }
    busy = false
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    let message = null
    try {
      message = JSON.parse(text)
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n')
      return
    }
    queue.push(message)
    void flush()
  })
  rl.on('close', () => {
    void runtime.stop().catch(() => {})
    process.exit(0)
  })

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      void runtime.stop().catch(() => {})
      process.exit(0)
    })
  }
}

if (require.main === module) {
  runStdio().catch((error) => {
    process.stderr.write('browser mcp server failed: ' + String(error?.stack || error) + '\n')
    process.exit(1)
  })
}

module.exports = { createRuntime, resolveDataRoot, runStdio, VERSION }
