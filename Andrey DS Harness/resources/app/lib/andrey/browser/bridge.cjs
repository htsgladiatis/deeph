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
  onControl = null,
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
        resolve({ decision: 'timeout' })
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

  /** The tab's current URL, for when a describe could not answer. */
  async function tabUrl(params) {
    try {
      const data = await request('tabs.list', {}, DIAGNOSTIC_TIMEOUT_MS)
      const found = (data?.tabs || []).find((tab) => tab.tabId === params.tabId)
      return found?.url || ''
    } catch {
      return ''
    }
  }

  async function guardedCall(method, params) {
    const target = TARGETED.has(method) ? await describeTarget(params) : undefined
    // A stale ref makes the describe fail, and an empty origin would then count
    // as a new site: the agent would get a confirmation for every click it aimed
    // at a slightly wrong ref. The tab itself knows where it is, so ask it.
    const origin = target?.url || params.url || (params.tabId ? await tabUrl(params) : '')
    const permission = origin ? state.getPermission(origin).mode : 'ask'

    if (STATE_CHANGING.has(method) && permission === 'block') {
      state.audit({ method, origin, decision: 'blocked', ref: params.ref, url: params.url })
      throw bridgeError(ERROR_CODES.BLOCKED_SITE, 'the user blocked this site: ' + origin)
    }

    const risk = classifyAction({ method, params, target, origin, permission })
    const needsConfirm = STATE_CHANGING.has(method) && (risk.level === 'high' || (risk.level === 'medium' && permission !== 'allow'))

    if (needsConfirm) {
      const label = target?.name || params.url || params.key || 'action'
      const answer = await requestConfirmation({
        summary: method.replace('page.', '') + ': ' + String(label).slice(0, 120) + (risk.reasons.length ? ' (' + risk.reasons.join('; ') + ')' : ''),
        origin,
        risk: risk.level,
        reasons: risk.reasons,
        ref: params.ref,
      })
      if (answer.decision !== 'allow') {
        state.audit({ method, origin, risk: risk.level, decision: 'denied', ref: params.ref })
        const why =
          answer.decision === 'timeout'
            ? 'the confirmation timed out; the action was not performed'
            : answer.reason === 'panel-closed'
              ? 'the side panel of the extension is closed, so the confirmation could not be shown; open it and repeat the action'
              : 'the user denied this action'
        throw bridgeError(ERROR_CODES.NEEDS_CONFIRM, why)
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
      // The side panel is a second place the user can press "continue". Its
      // resume has to clear this side of the pause too, or the panel shows a
      // running agent while every call still fails with PAUSED.
      if (message.event === 'resumed') state.paused.set(false)
      if (message.event === 'confirm.answer' && confirmations.has(message.data?.id)) {
        const waiter = confirmations.get(message.data.id)
        confirmations.delete(message.data.id)
        clearTimeout(waiter.timer)
        waiter.resolve({ decision: message.data.allow ? 'allow' : 'deny', reason: message.data.reason || '' })
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
    // The app's own UI reaches the bridge through this endpoint: it is the
    // process that holds the state, and the renderer runs on a dsh-app:// origin
    // that cannot speak WebSocket to loopback. The shared token is the only
    // credential, and a browser will not attach a custom header cross-site.
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-bridge-token',
      'access-control-max-age': '600',
    }
    server = http.createServer((req, res) => {
      if (req.url && req.url.startsWith('/control') && req.method === 'OPTIONS') {
        res.writeHead(204, cors)
        res.end()
        return
      }
      // Port discovery for the app UI: cheap, unauthenticated, and leaks nothing
      // beyond "a bridge is listening here".
      if (req.url && req.url === '/control/ping' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', ...cors })
        res.end(JSON.stringify({ ok: true, name: 'andrey-browser' }))
        return
      }
      if (req.method === 'POST' && req.url && req.url.startsWith('/control')) {
        if (!onControl || !safeEqual(req.headers['x-bridge-token'] || '', state.token)) {
          res.writeHead(403, { 'content-type': 'application/json', ...cors })
          res.end(JSON.stringify({ ok: false, error: 'forbidden' }))
          return
        }
        const chunks = []
        req.on('data', (chunk) => {
          chunks.push(chunk)
          if (Buffer.concat(chunks).length > 65536) req.destroy()
        })
        req.on('end', async () => {
          let body = {}
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          } catch {
            res.writeHead(400, { 'content-type': 'application/json', ...cors })
            res.end(JSON.stringify({ ok: false, error: 'bad-json' }))
            return
          }
          try {
            const data = await onControl(String(body.action || ''), body)
            res.writeHead(200, { 'content-type': 'application/json', ...cors })
            res.end(JSON.stringify({ ok: true, data }))
          } catch (error) {
            res.writeHead(error?.status || 500, { 'content-type': 'application/json', ...cors })
            res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }))
          }
        })
        return
      }
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

  /** Resume on both sides: this process and the browser extension. */
  function resume() {
    state.paused.set(false)
    send(client, { type: 'event', event: 'resume' })
    return { paused: false }
  }

  async function stop() {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(bridgeError(ERROR_CODES.NOT_CONNECTED, 'the bridge stopped'))
    }
    pending.clear()
    for (const waiter of confirmations.values()) {
      clearTimeout(waiter.timer)
      waiter.resolve({ decision: 'deny', reason: 'bridge-stopped' })
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
    resume,
    status,
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

module.exports = { createBridge, STATE_CHANGING, TARGETED, CONFIRM_TIMEOUT_MS, REQUEST_TIMEOUT_MS }
