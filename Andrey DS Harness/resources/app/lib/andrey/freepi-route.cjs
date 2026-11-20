'use strict'

/**
 * freePi over the local route.
 *
 * freePi is normally reached straight from the profile: the active token is
 * written into `cordis.patch.yml` at boot, so switching an account needs a
 * restart and the provider keeps whatever token it read once.
 *
 * The server, however, allows exactly one in-flight request per account
 * (`429 {code:"concurrent"}`) and keeps up to four CLI session slots per
 * account (`concurrent_session`, released by `POST /session/reset`). A harness
 * that fires retries directly at it walks into both: the retry collides with
 * the request the server still counts, the turn ends in an error, and the
 * account switch only takes effect on the next start.
 *
 * So the provider points at `http://127.0.0.1:39147/freepi/v1` instead and this
 * module does three things the direct route cannot:
 *
 *  1. resolves the *active* account on every request — a switch applies to the
 *     next message, with no restart and no token baked into the profile;
 *  2. serializes requests, because the server allows one at a time;
 *  3. waits out `concurrent` and clears a stuck `concurrent_session` with the
 *     documented reset, then retries instead of ending the turn.
 *
 * Everything else is a straight pass-through: the body, the stream and the
 * upstream errors reach their original caller untouched.
 */

const { maybeCompressBody } = require('./context-compress.cjs')

const BASE_URL = 'https://api.freepi.ai'
const CLIENT_VERSION = '0.6.22'
const REQUEST_TIMEOUT_MS = 180_000
const RESET_TIMEOUT_MS = 10_000
const CONCURRENT_RETRIES = 6
const SESSION_RETRIES = 2

/** One request at a time per account, the server's own rule. */
let queue = Promise.resolve()

function serialize(task) {
  const run = queue.then(task, task)
  queue = run.then(() => undefined, () => undefined)
  return run
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function tokenFor(dataRoot) {
  const { createStore } = require('./accounts.cjs')
  const store = createStore({ dataRoot })
  const account = store.profiles.context('pi')
  return { account, token: store.piToken(account) }
}

function upstreamHeaders(token, extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    'x-client-version': CLIENT_VERSION,
    'user-agent': 'andrey-ds-harness',
    ...extra,
  }
}

/** Reset a session slot the previous run left occupied. Best effort. */
async function resetSession(token, log) {
  try {
    const res = await fetch(`${BASE_URL}/session/reset`, {
      method: 'POST',
      headers: upstreamHeaders(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(RESET_TIMEOUT_MS),
    })
    log('info', 'freepi:session-reset', { status: res.status })
    return res.ok
  } catch (error) {
    log('warn', 'freepi:session-reset-failed', { error: String(error?.message ?? error) })
    return false
  }
}

/** The upstream error body, when it names a code worth reacting to. */
function errorCode(text) {
  try {
    const parsed = JSON.parse(text)
    return typeof parsed?.code === 'string' ? parsed.code : null
  } catch {
    return null
  }
}

function sendJson(res, status, payload) {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/**
 * `GET /freepi/v1/models` — what the active account can serve.
 *
 * The profile carries the same list (it is what the picker shows), so this is
 * only used by surfaces that ask the route directly.
 */
async function handleModels(res, dataRoot, log) {
  const { token } = tokenFor(dataRoot)
  if (!token) {
    sendJson(res, 200, { object: 'list', data: [] })
    return
  }
  try {
    const res0 = await fetch(`${BASE_URL}/client-version`, {
      headers: upstreamHeaders(token),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res0.ok) throw new Error(`http-${res0.status}`)
    const body = await res0.json()
    const data = (body?.models ?? [])
      .filter((model) => model && model.id && model.section !== 'defense')
      .map((model) => ({ id: model.id, object: 'model', owned_by: 'freepi' }))
    sendJson(res, 200, { object: 'list', data })
  } catch (error) {
    log('warn', 'freepi:models-failed', { error: String(error?.message ?? error) })
    sendJson(res, 200, { object: 'list', data: [] })
  }
}

/**
 * `POST /freepi/v1/chat/completions` — serialize, retry the two server gates,
 * then stream the upstream response through unchanged.
 */
function handleChat(req, res, { dataRoot, log }) {
  return readBody(req).then((rawBuffer) => serialize(async () => {
    // A long session must not usher the whole history into the upstream and
    // fly into a context-length error. Trim to the configured token budget;
    // on the common path this returns the very same buffer, unchanged.
    const compressed = maybeCompressBody(rawBuffer, { log })
    const buffer = compressed.buffer
    if (compressed.changed) {
      log('info', 'freepi:context-compressed', {
        originalTokens: compressed.originalTokens,
        finalTokens: compressed.finalTokens,
        removed: compressed.removed,
      })
    }

    const { account, token } = tokenFor(dataRoot)
    if (!token) {
      sendJson(res, 401, {
        error: { message: `freePi account ${account.id} is not signed in`, code: 'login-required' },
      })
      return
    }

    let concurrentRetries = 0
    let sessionRetries = 0

    for (;;) {
      let upstream
      try {
        upstream = await fetch(`${BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: upstreamHeaders(token, {
            'content-type': req.headers['content-type'] ?? 'application/json',
            ...(typeof req.headers.accept === 'string' ? { accept: req.headers.accept } : {}),
          }),
          body: buffer,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (error) {
        log('error', 'freepi:transport-failed', { error: String(error?.message ?? error) })
        sendJson(res, 502, { error: { message: String(error?.message ?? error), code: 'transport' } })
        return
      }

      if (upstream.ok) {
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
          'cache-control': 'no-store',
        })
        if (upstream.body === null) {
          res.end()
          return
        }
        const reader = upstream.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            res.write(Buffer.from(value))
          }
        } catch (error) {
          log('error', 'freepi:stream-broken', { error: String(error?.message ?? error) })
        } finally {
          try { await reader.cancel() } catch { /* already closed */ }
          res.end()
        }
        return
      }

      // An error body is small and has to be inspected before deciding.
      const text = await upstream.text().catch(() => '')
      const code = errorCode(text)

      if (code === 'concurrent' && concurrentRetries < CONCURRENT_RETRIES) {
        concurrentRetries += 1
        const waitMs = 1200 * concurrentRetries
        log('info', 'freepi:concurrent-retry', { attempt: concurrentRetries, waitMs })
        await sleep(waitMs)
        continue
      }

      if (code === 'concurrent_session' && sessionRetries < SESSION_RETRIES) {
        sessionRetries += 1
        log('info', 'freepi:concurrent-session', { attempt: sessionRetries, account: account.id })
        await resetSession(token, log)
        await sleep(1500)
        continue
      }

      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      })
      res.end(text)
      return
    }
  })).catch((error) => {
    log('error', 'freepi:chat-failed', { error: String(error?.message ?? error) })
    sendJson(res, 400, { error: { message: String(error?.message ?? error) } })
  })
}

async function handle(req, res, ctx) {
  const path = ctx.url.pathname
  if (req.method === 'GET' && path === '/freepi/v1/models') {
    await handleModels(res, ctx.dataRoot, ctx.log)
    return
  }
  if (req.method === 'POST' && path === '/freepi/v1/chat/completions') {
    await handleChat(req, res, ctx)
    return
  }
  sendJson(res, 404, { error: { message: 'not found' } })
}

module.exports = { handle, BASE_URL, CLIENT_VERSION }
