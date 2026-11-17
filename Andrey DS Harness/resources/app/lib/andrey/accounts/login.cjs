'use strict'

const fs = require('node:fs')
const path = require('node:path')

const CONSENT_VERSION = '4'

async function postJson(fetchImpl, url, body, headers = {}) {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function startDeviceLogin({ baseUrl, fetchImpl = fetch }) {
  const res = await postJson(fetchImpl, new URL('/auth/github/device', baseUrl), {})
  if (!res.ok) throw new Error(`device flow start failed: HTTP ${res.status}`)
  const body = await res.json()
  return {
    sessionId: body.session_id,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete: body.verification_uri_complete ?? null,
    interval: body.interval ?? 5,
    expiresIn: body.expires_in ?? null,
  }
}

async function submitConsent({ baseUrl, sessionId, consentVersion = CONSENT_VERSION, fetchImpl = fetch }) {
  await postJson(fetchImpl, new URL('/auth/consent', baseUrl), { session_id: sessionId, consent_version: consentVersion })
}

/**
 * Poll until a token is issued. `consent_required` is answered with one consent
 * submission (the version is pinned to the value shipped in free-pi-cli) and
 * polling continues — the server records consent, the next poll succeeds.
 */
async function pollForToken({ baseUrl, sessionId, interval, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), deadlineMs = 180_000, onConsentRequired }) {
  const deadline = Date.now() + deadlineMs
  let consentTried = false
  let networkFailures = 0
  while (Date.now() < deadline) {
    let res
    try {
      res = await postJson(fetchImpl, new URL('/auth/token', baseUrl), { session_id: sessionId })
      networkFailures = 0
    } catch {
      if (++networkFailures >= 6) throw new Error('token poll failed: network unreachable')
      await sleep(Math.max(interval, 5) * 1000)
      continue
    }
    const body = await res.json().catch(() => ({}))
    if (res.status === 403 && body.code === 'consent_required') {
      if (!consentTried) {
        consentTried = true
        onConsentRequired?.({ message: body.message })
        await submitConsent({ baseUrl, sessionId, fetchImpl })
      }
      await sleep(Math.max(interval, 5) * 1000)
      continue
    }
    if (res.status === 403 && body.code === 'denied') throw new Error('login denied')
    if (res.status === 410 || body.code === 'expired') throw new Error('device code expired')
    if (!res.ok) throw new Error(`token poll failed: HTTP ${res.status}`)
    if (body.status === 'pending') {
      await sleep(Math.max(body.retry_after ?? 0, interval, 5) * 1000)
      continue
    }
    if (body.token) return { token: body.token }
    throw new Error(`unexpected token poll response: ${JSON.stringify(body).slice(0, 200)}`)
  }
  throw new Error('login deadline exceeded')
}

function credentialsPath(home) {
  return path.join(home, '.free-pi', 'agent', 'credentials.json')
}

function saveToken({ home, token }) {
  const file = credentialsPath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const { protectObject } = require('./secret.cjs')
  fs.writeFileSync(file, JSON.stringify(protectObject({ token })), { mode: 0o600 })
}

function readToken({ home }) {
  try {
    const { unprotectObject } = require('./secret.cjs')
    const parsed = unprotectObject(JSON.parse(fs.readFileSync(credentialsPath(home), 'utf8')))
    return typeof parsed?.token === 'string' && parsed.token.length > 0 ? parsed.token : null
  } catch {
    return null
  }
}

/**
 * Sign out: remove only the stored credential. Agent sessions, the trust list
 * and extension state stay on disk, so signing back in restores the same home
 * instead of silently wiping the user's work.
 */
function clearToken({ home }) {
  try {
    fs.rmSync(credentialsPath(home), { force: true })
  } catch {
    // A missing file is already signed out.
  }
}

module.exports = { startDeviceLogin, pollForToken, submitConsent, saveToken, readToken, clearToken, CONSENT_VERSION }
