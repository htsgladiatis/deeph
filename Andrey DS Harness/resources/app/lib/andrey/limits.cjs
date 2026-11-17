'use strict'

/**
 * What is left of today's allowance on both providers, for the composer's
 * limits plate.
 *
 * Both numbers come from the providers' own endpoints, with the active
 * account's token — the same calls their CLIs make for `/usage`:
 *
 *   freePi    GET https://api.freepi.ai/me
 *             remaining_credits_today / allowance_credits / refill_at
 *   Freebuff  GET https://www.codebuff.com/api/v1/freebuff/session
 *             freebucks.daily.remaining / limit / resetAt
 *
 * Nothing is cached on disk: both are cheap and a stale number is worse than a
 * spinner. A provider that is signed out or unreachable reports its own error
 * and never breaks the other.
 */

const PI_BASE = 'https://api.freepi.ai'
const FREEBUFF_BASE = 'https://www.codebuff.com'
const TIMEOUT_MS = 8000
const FREEBUFF_TIMEOUT_MS = 20000

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

async function fetchPiLimits({ token, fetchImpl = fetch }) {
  if (typeof token !== 'string' || token === '') return { ok: false, error: 'login-required' }
  try {
    const res = await fetchImpl(`${PI_BASE}/me`, {
      headers: { authorization: `Bearer ${token}`, 'x-client-version': '0.6.21' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, error: `http-${res.status}` }
    const body = await res.json()
    return {
      ok: true,
      remaining: numberOrNull(body?.remaining_credits_today),
      allowance: numberOrNull(body?.allowance_credits),
      remainingUsd: numberOrNull(body?.remaining_usd_today),
      capUsd: numberOrNull(body?.cap_usd_today),
      resetAt: typeof body?.refill_at === 'string' ? body.refill_at : null,
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

async function fetchFreebuffLimits({ token, fetchImpl = fetch, attempts = 2 }) {
  if (typeof token !== 'string' || token === '') return { ok: false, error: 'login-required' }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetchImpl(`${FREEBUFF_BASE}/api/v1/freebuff/session`, {
        headers: { authorization: `Bearer ${token}`, 'x-freebuff-client': 'desktop' },
        signal: AbortSignal.timeout(FREEBUFF_TIMEOUT_MS),
      })
      if (!res.ok) {
        if (attempt === attempts) return { ok: false, error: `http-${res.status}` }
        continue
      }
      const body = await res.json()
      const daily = body?.freebucks?.daily ?? {}
      const wallet = body?.freebucks?.wallet ?? {}
      return {
        ok: true,
        remaining: numberOrNull(daily.remaining),
        allowance: numberOrNull(daily.limit),
        balance: numberOrNull(wallet.balance),
        tier: typeof body?.accessTier === 'string' ? body.accessTier : null,
        status: typeof body?.status === 'string' ? body.status : null,
        resetAt: typeof daily.resetAt === 'string' ? daily.resetAt : null,
      }
    } catch (error) {
      if (attempt === attempts) return { ok: false, error: String(error?.message ?? error) }
    }
  }
  return { ok: false, error: 'unreachable' }
}

/**
 * Both providers at once, with the active account named on each.
 * @returns `{ pi, freebuff }`, each either a limit snapshot or `{ ok: false }`.
 */
async function collectLimits({ store, fetchImpl = fetch }) {
  const piAccount = store.profiles.context('pi')
  const fbAccount = store.profiles.context('freebuff')

  const [pi, freebuff] = await Promise.all([
    fetchPiLimits({ token: store.piToken(piAccount), fetchImpl }),
    (async () => {
      const { readToken } = require('./freebuff/freebuff-login.cjs')
      const token = readToken({ home: fbAccount.appHome })
      return fetchFreebuffLimits({ token: token?.token ?? token, fetchImpl })
    })(),
  ])

  return {
    pi: { ...pi, account: piAccount.id, label: piAccount.label },
    freebuff: { ...freebuff, account: fbAccount.id, label: fbAccount.label },
  }
}

module.exports = { collectLimits, fetchPiLimits, fetchFreebuffLimits }
