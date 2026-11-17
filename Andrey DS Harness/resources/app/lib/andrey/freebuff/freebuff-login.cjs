'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Freebuff (codebuff.com) CLI login.
 *
 * The web page's `auth_flow` / `auth_attempt` / `onboard` parameters are
 * internal to the website — the CLI protocol never sees them. What the server
 * actually implements (verified live against freebuff.com):
 *
 *   POST /api/auth/cli/code    { fingerprintId }
 *     -> { fingerprintId, fingerprintHash, loginUrl, expiresAt, expiresInMs }
 *
 *   GET  /api/auth/cli/status?fingerprintId=..&fingerprintHash=..&expiresAt=..
 *     -> 200 { user: { id, email, authToken, ... } }
 *     -> 401 { error: 'Authentication failed' }   (still pending, or consumed)
 *
 * The code is single-use: once `status` returns a user, the same code is dead.
 * Nothing here is signed; the device key is only used later by
 * /api/v1/freebuff/session and /session/admission.
 */

const DEFAULT_BASE_URL = 'https://freebuff.com'

function freebuffDir(home) {
  return path.join(home, '.freebuff')
}

function devicePath(home) {
  return path.join(freebuffDir(home), 'device.json')
}

function credentialsPath(home) {
  return path.join(freebuffDir(home), 'credentials.json')
}

/**
 * The server only returns `fingerprintHash` once, in the `code` response, and it
 * cannot be recomputed from `fingerprintId`. Persist the pending flow so a
 * restart (or a later status poll) still has the full triple.
 */
function pendingPath(home) {
  return path.join(freebuffDir(home), 'pending-login.json')
}

function savePending({ home, flow }) {
  const file = pendingPath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(flow, null, 2)}\n`, { mode: 0o600 })
}

function readPending({ home }) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pendingPath(home), 'utf8'))
    return typeof parsed?.fingerprintHash === 'string' ? parsed : null
  } catch {
    return null
  }
}

function clearPending({ home }) {
  try {
    fs.rmSync(pendingPath(home), { force: true })
  } catch {
    // Nothing pending.
  }
}

/**
 * A stable per-install fingerprint. Reusing one id across launches is the
 * honest behaviour: the server ties the account to this device, and churning a
 * new id per run is exactly the evasion we do not do.
 */
function loadFingerprintId({ home }) {
  const file = devicePath(home)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof parsed.fingerprintId === 'string' && parsed.fingerprintId.length >= 8) {
      return parsed.fingerprintId
    }
  } catch {
    // First run, or a damaged file: regenerate below.
  }
  const fingerprintId = crypto.randomUUID()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ fingerprintId }, null, 2)}\n`, { mode: 0o600 })
  return fingerprintId
}

async function startLogin({ home, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch }) {
  const fingerprintId = loadFingerprintId({ home })
  const res = await fetchImpl(new URL('/api/auth/cli/code', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fingerprintId }),
  })
  if (!res.ok) throw new Error(`login start failed: HTTP ${res.status}`)
  const body = await res.json()
  if (!body?.loginUrl || !body?.fingerprintHash) {
    throw new Error(`unexpected login start response: ${JSON.stringify(body).slice(0, 200)}`)
  }
  const flow = {
    fingerprintId: body.fingerprintId ?? fingerprintId,
    fingerprintHash: body.fingerprintHash,
    loginUrl: body.loginUrl,
    expiresAt: body.expiresAt,
    expiresInMs: body.expiresInMs ?? null,
    createdAt: Date.now(),
  }
  if (home) savePending({ home, flow })
  return flow
}

async function checkStatus({ baseUrl = DEFAULT_BASE_URL, fingerprintId, fingerprintHash, expiresAt, fetchImpl = fetch }) {
  const url = new URL('/api/auth/cli/status', baseUrl)
  url.searchParams.set('fingerprintId', fingerprintId)
  url.searchParams.set('fingerprintHash', fingerprintHash)
  url.searchParams.set('expiresAt', String(expiresAt))
  const res = await fetchImpl(url)
  const body = await res.json().catch(() => ({}))
  if (res.status === 200 && body?.user?.authToken) {
    return { done: true, token: body.user.authToken, user: body.user }
  }
  // 401 covers both "not approved yet" and "code already consumed"; polling
  // simply retries until the deadline.
  return { done: false, status: res.status, error: body?.error ?? null }
}

async function pollLogin({
  baseUrl = DEFAULT_BASE_URL,
  fingerprintId,
  fingerprintHash,
  expiresAt,
  intervalMs = 5000,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  deadlineMs = 3_600_000,
  onPending,
}) {
  const deadline = Math.min(Date.now() + deadlineMs, Number(expiresAt) || Infinity)
  let networkFailures = 0
  while (Date.now() < deadline) {
    try {
      const result = await checkStatus({ baseUrl, fingerprintId, fingerprintHash, expiresAt, fetchImpl })
      networkFailures = 0
      if (result.done) return result
      onPending?.(result)
    } catch {
      if (++networkFailures >= 6) throw new Error('login status poll failed: network unreachable')
    }
    await sleep(intervalMs)
  }
  throw new Error('login deadline exceeded')
}

function saveToken({ home, token, user }) {
  const file = credentialsPath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const payload = {
    token,
    email: user?.email ?? null,
    userId: user?.id ?? null,
    savedAt: new Date().toISOString(),
  }
  const { protectObject } = require('./secret.cjs')
  fs.writeFileSync(file, `${JSON.stringify(protectObject(payload), null, 2)}\n`, { mode: 0o600 })
  return file
}

function readToken({ home }) {
  try {
    const { unprotectObject } = require('./secret.cjs')
    const parsed = unprotectObject(JSON.parse(fs.readFileSync(credentialsPath(home), 'utf8')))
    return typeof parsed?.token === 'string' && parsed.token.length > 0 ? parsed : null
  } catch {
    return null
  }
}

function clearToken({ home }) {
  try {
    fs.rmSync(credentialsPath(home), { force: true })
  } catch {
    // Already signed out.
  }
}

async function loginFlow({ home, baseUrl, fetchImpl = fetch, sleep, onLoginUrl, onPending, deadlineMs }) {
  const start = await startLogin({ home, baseUrl, fetchImpl })
  onLoginUrl?.(start)
  const result = await pollLogin({ ...start, baseUrl, fetchImpl, sleep, onPending, deadlineMs })
  saveToken({ home, token: result.token, user: result.user })
  clearPending({ home })
  return result
}

module.exports = {
  startLogin,
  checkStatus,
  pollLogin,
  loginFlow,
  saveToken,
  readToken,
  clearToken,
  loadFingerprintId,
  savePending,
  readPending,
  clearPending,
  credentialsPath,
  devicePath,
  pendingPath,
}
