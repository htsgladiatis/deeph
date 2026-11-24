'use strict'

const http = require('node:http')
const crypto = require('node:crypto')

const { validateParams, ERROR_CODES } = require('./protocol.cjs')
const { classifyAction } = require('./risk.cjs')
const { runtimeRequire } = require('../pi-profile.cjs')

/**
 * The local end of the browser bridge.
 *
 * The extension dials ws://127.0.0.1:<port>/ext and authenticates with either
 * the six digit pair code (first time) or the 64 hex token the server handed out
 * then. Every request the model makes is validated against the protocol
 * whitelist, classified by risk, optionally confirmed by the user in the side
 * panel, and finally forwarded to the extension as a JSON-RPC-ish frame.
 *
 * Why a bridge at all instead of talking to Chrome directly: Chrome 136+ ignores
 * --remote-debugging-port for the default profile, so the only way into the
 * user's real, logged-in browser is from inside an extension. The bridge is the
 * process the extension can reach without the browser exposing anything.
 */

const CONFIRM_TIMEOUT_MS = 120000
const REQUEST_TIMEOUT_MS = 120000
const DIAGNOSTIC_TIMEOUT_MS = 30000
const PAIR_WINDOW_MS = 60000
const PAIR_MAX_ATTEMPTS = 5

/** Calls that change the page or the account: these pass the risk gate. */
const STATE_CHANGING = new Set(['page.click', 'page.type', 'page.press', 'page.navigate', 'page.upload'])
/** Calls that name an element and therefore need a describe() to classify. */
const TARGETED = new Set(['page.click', 'page.type', 'page.press'])

function bridgeError(code, message) {
  const error = new Error(message || code)
  error.code = code
  return error
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function createBridge({
  state,
  logger = { info() {}, warn() {}, error() {} },
  port = 39160,
  host = '127.0.0.1',
  requireWs = () => runtimeRequire('ws'),
}) {
  const WebSocketServer = requireWs().WebSocketServer

  let server = null
  let wss = null
  let boundPort = port
  let client = null
  let nextId = 1
  const pending = new Map()
  const confirmations = new Map()
  const listeners = new Set()
  let pairAttempts = []

  const send = (socket, message) => {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(message))
  }

  function request(method, params, timeoutMs) {
    if (!client) return Promise.reject(bridgeError(ERROR_CODES.NOT_CONNECTED, 'the browser extension is not connected'))
    const id = nextId
    nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(bridgeError(ERROR_CODES.TIMEOUT, method + ' did not answer within ' + timeoutMs + ' ms'))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      send(client, { type: 'req', id, method, params })
    })
  }

  function requestConfirmation(summary) {
    const id = crypto.randomBytes(6).toString('hex')
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        confirmations.delete(id)
        resolve('timeout')
      }, CONFIRM_TIMEOUT_MS)
      confirmations.set(id, { resolve, timer })
      send(client, { type: 'event', event: 'confirm.request', data: { id, ...summary } })
    })
  }

  async function describeTarget(params) {
    if (!params.ref && !params.selector) return undefined
    try {
      return await request('page.describe', { tabId: params.tabId, ref: params.ref, selector: params.selector }, DIAGNOSTIC_TIMEOUT_MS)
    } catch {
      // A failed describe must not turn a read-only diagnostic into a hard
      // failure: the action itself will report the useful error.
      return undefined
    }
  }

  async function guardedCall(method, params) {
    const target = TARGETED.has(method) ? await describeTarget(params) : undefined
    const origin = target?.url || params.url || ''
    const permission = origin ? state.getPermission(origin).mode : 'ask'

    if (STATE_CHANGING.has(method) && permission === 'block') {
      state.audit({ method, origin, decision: 'blocked', ref: params.ref, url: params.url })
      throw bridgeError(ERROR_CODES.BLOCKED_SITE, 'the user blocked this site: ' + origin)
    }

    const risk = classifyAction({ method, params, target, origin, permission })
    const needsConfirm = STATE_CHANGING.has(method) && (risk.level === 'high' || (risk.level === 'medium' && permission !== 'allow'))

    if (needsConfirm) {
      const label = target?.name || params.url || params.key || 'action'
      const decision = await requestConfirmation({
        summary: method.replace('page.', '') + ': ' + String(label).slice(0, 120) + (risk.reasons.length ? ' (' + risk.reasons.join('; ') + ')' : ''),
        origin,
        risk: risk.level,
        reasons: risk.reasons,
        ref: params.ref,
      })
      if (decision !== 'allow') {
        state.audit({ method, origin, risk: risk.level, decision: 'denied', ref: params.ref })
        throw bridgeError(
          ERROR_CODES.NEEDS_CONFIRM,
          decision === 'timeout' ? 'the confirmation timed out; the action was not performed' : 'the user denied this action',
        )
      }
      state.audit({ method, origin, risk: risk.level, decision: 'confirmed', ref: params.ref })
    } else {
      const sensitive = method === 'page.type'
      state.audit({ method, origin, risk: risk.level, decision: 'auto', ref: params.ref, url: params.url, text: sensitive ? params.text : undefined, sensitive })
    }

    return request(method, params, Number(params.timeoutMs) || REQUEST_TIMEOUT_MS)
  }

  async function call(method, params = {}) {
    if (state.paused.get() && method !== 'agent.stop' && method !== 'status') {
      throw bridgeError(ERROR_CODES.PAUSED, 'the user stopped the agent; resume from the side panel first')
    }
    const checked = validateParams(method, params)
    if (!checked.ok) throw bridgeError(checked.error.code, checked.error.message)

    if (method === 'agent.stop') {
      state.paused.set(true)
      send(client, { type: 'event', event: 'stop' })
      return { paused: true }
    }
    if (method === 'status') {
      const extensionStatus = client ? await request('status', {}, DIAGNOSTIC_TIMEOUT_MS).catch(() => null) : null
      return { ...status(), extensionStatus }
    }
    return guardedCall(method, checked.value)
  }

  function onMessage(socket, raw) {
    let message
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }
    if (!message || typeof message !== 'object') return

    if (message.type === 'hello') {
      const viaCode = typeof message.code === 'string' && state.verifyPairCode(message.code) !== null
      const viaToken = typeof message.token === 'string' && safeEqual(message.token, state.token)
      if (!viaCode && !viaToken) {
        const now = Date.now()
        pairAttempts = pairAttempts.filter((at) => now - at < PAIR_WINDOW_MS)
        pairAttempts.push(now)
        logger.warn('browser extension failed to pair')
        socket.close(pairAttempts.length > PAIR_MAX_ATTEMPTS ? 4408 : 4401)
        return
      }
      if (client && client !== socket) send(client, { type: 'event', event: 'replaced' })
      client = socket
      socket.ext = message.ext || null
      socket.claimedAt = Date.now()
      send(socket, { type: 'hello', ok: true, token: viaCode ? state.token : undefined, sessionId: crypto.randomBytes(8).toString('hex') })
      logger.info('browser extension connected ' + JSON.stringify(message.ext || {}))
      return
    }

    if (message.type === 'res') {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.ok) waiter.resolve(message.data || {})
      else waiter.reject(bridgeError(message.error?.code || ERROR_CODES.EXTENSION_ERROR, message.error?.message || 'extension error'))
      return
    }

    if (message.type === 'event') {
      if (message.event === 'confirm.answer' && confirmations.has(message.data?.id)) {
        const waiter = confirmations.get(message.data.id)
        confirmations.delete(message.data.id)
        clearTimeout(waiter.timer)
        waiter.resolve(message.data.allow ? 'allow' : 'deny')
        return
      }
      for (const listener of listeners) {
        try {
          listener(message)
        } catch {
          /* one bad listener never breaks the bridge */
        }
      }
      return
    }

    if (message.type === 'pong') {
      socket.lastPongAt = Date.now()
    }
  }

  async function start() {
    server = http.createServer((req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })
    wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
      if (!req.url || !req.url.startsWith('/ext')) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (raw) => onMessage(ws, raw))
        ws.on('close', () => {
          if (client === ws) client = null
        })
        ws.on('error', () => {})
      })
    })

    await new Promise((resolve, reject) => {
      const tryListen = (candidate) => {
        const onError = (error) => {
          if (error.code === 'EADDRINUSE' && candidate < port + 10) tryListen(candidate + 1)
          else reject(error)
        }
        server.once('error', onError)
        server.listen(candidate, host, () => {
          server.removeListener('error', onError)
          boundPort = candidate
          resolve()
        })
      }
      tryListen(port)
    })

    logger.info('browser bridge listening on ' + host + ':' + boundPort)
    return { port: boundPort }
  }

  async function stop() {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(bridgeError(ERROR_CODES.NOT_CONNECTED, 'the bridge stopped'))
    }
    pending.clear()
    for (const waiter of confirmations.values()) {
      clearTimeout(waiter.timer)
      waiter.resolve('deny')
    }
    confirmations.clear()
    if (client) client.close(1001)
    client = null
    if (wss) wss.close()
    if (server) await new Promise((resolve) => server.close(resolve))
  }

  function status() {
    return {
      connected: Boolean(client),
      port: boundPort,
      paused: state.paused.get(),
      extension: client?.ext || null,
      pairCode: state.pairCode,
      permissions: state.listPermissions(),
    }
  }

  return {
    get port() {
      return boundPort
    },
    start,
    stop,
    call,
    status,
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

module.exports = { createBridge, STATE_CHANGING, TARGETED, CONFIRM_TIMEOUT_MS, REQUEST_TIMEOUT_MS }
