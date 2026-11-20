'use strict'

/**
 * Bound how long the harness waits on a Freebuff turn and how often it repeats
 * one.
 *
 * A Freebuff answer is a whole CLI run: a queued request can wait fifteen
 * minutes for the account's slot, the CLI then starts its TUI and walks the
 * model picker, and only after that does the first token reach the transcript.
 * The provider default is five minutes of stream silence, so a slow start is
 * reported as a timeout — and the default retry policy answers a timeout by
 * starting another run, up to five times, each one spending an hour.
 *
 * Only those two keys are written, and only when the profile does not already
 * say the same. The profile is read when the host registers providers, so this
 * has to run at boot, before `main.js` is imported.
 */

const fs = require('node:fs')

const { runtimeRequire } = require('./pi-profile.cjs')

/** Covers the queue wait plus a whole run's hard limit. */
const IDLE_TIMEOUT_MS = 1_800_000
/** One repeat at most: a retry here is a second CLI run, not a cheap request. */
const MAX_RETRIES = 1

function applyFreebuffProfileSync({ profilePath } = {}) {
  try {
    if (!fs.existsSync(profilePath)) return { ok: false, error: 'profile-missing' }

    const YAML = runtimeRequire('yaml')
    const doc = YAML.parse(fs.readFileSync(profilePath, 'utf8'))
    const entry = Array.isArray(doc) ? doc.find((item) => item && item.id === 'llm-pi-ai') : null
    const provider = entry?.config?.providers?.freebuff
    if (provider === null || typeof provider !== 'object') return { ok: false, error: 'freebuff-missing' }

    let changed = false
    if (!(Number(provider.streamIdleTimeoutMs) >= IDLE_TIMEOUT_MS)) {
      provider.streamIdleTimeoutMs = IDLE_TIMEOUT_MS
      changed = true
    }

    const policy = provider.retryPolicy
    // `always` is an explicit request for unlimited retries; leave it alone.
    const bounded = policy === undefined
      || (policy?.mode === 'normal' && Number(policy?.maxRetries ?? MAX_RETRIES + 1) > MAX_RETRIES)
    if (bounded) {
      provider.retryPolicy = { ...(policy ?? {}), mode: 'normal', maxRetries: MAX_RETRIES }
      changed = true
    }

    if (!changed) return { ok: true, changed: false }
    fs.writeFileSync(profilePath, YAML.stringify(doc))
    return { ok: true, changed: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

module.exports = {
  applyFreebuffProfileSync,
  IDLE_TIMEOUT_MS,
  MAX_RETRIES,
}
