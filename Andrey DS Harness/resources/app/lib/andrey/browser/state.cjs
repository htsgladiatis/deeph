'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/**
 * Persistent state of the browser bridge.
 *
 * One small JSON file under the app data root holds everything that has to
 * survive a restart: the pairing token the extension keeps, the six digit code
 * the user types once, the per-origin permission table, the audit trail and the
 * pause flag. The file is written atomically (tmp + rename) and with mode 0600
 * because the token is a bearer credential for the user's browser.
 */

const MODES = new Set(['ask', 'allow', 'block'])
/**
 * The mode a site gets before the user touches the table: full access, by the
 * product decision that the agent should work on its own. Money-touching sites
 * and dangerous controls are still stopped by risk.cjs, and one click in the
 * panel pins any origin to `ask` or `block`.
 */
const DEFAULT_MODE = 'allow'
const MAX_AUDIT_ROWS = 2000

/** Reduce any URL to the origin the permission table stores, or null. */
function originOf(url) {
  try {
    const parsed = new URL(String(url))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname
  } catch {
    return ''
  }
}

function atomicWrite(file, text) {
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex')
}

function randomPairCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

function createState(file) {
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
  }

  const data = read()
  data.permissions = data.permissions && typeof data.permissions === 'object' && !Array.isArray(data.permissions) ? data.permissions : {}
  data.audit = Array.isArray(data.audit) ? data.audit : []
  data.paused = Boolean(data.paused)
  if (typeof data.token !== 'string' || !/^[0-9a-f]{64}$/.test(data.token)) data.token = randomToken()
  if (typeof data.pairCode !== 'string' || !/^[0-9]{6}$/.test(data.pairCode)) data.pairCode = randomPairCode()
  if (typeof data.createdAt !== 'string') data.createdAt = new Date().toISOString()

  const save = () => atomicWrite(file, JSON.stringify(data, null, 2))
  save()

  return {
    file,

    get token() {
      return data.token
    },

    get pairCode() {
      return data.pairCode
    },

    rotateToken() {
      data.token = randomToken()
      save()
      return data.token
    },

    /** The extension exchanges the code for the token exactly once. */
    verifyPairCode(code) {
      return String(code) === data.pairCode ? data.token : null
    },

    regeneratePairCode() {
      data.pairCode = randomPairCode()
      save()
      return data.pairCode
    },

    getPermission(origin) {
      const key = originOf(origin) || String(origin)
      const mode = data.permissions[key]
      return { mode: MODES.has(mode) ? mode : DEFAULT_MODE }
    },

    setPermission(origin, mode) {
      if (!MODES.has(mode)) throw new Error('unknown permission mode: ' + mode)
      const key = originOf(origin)
      if (!key) throw new Error('origin must be http(s): ' + origin)
      data.permissions[key] = mode
      save()
      return { origin: key, mode }
    },

    clearPermission(origin) {
      const key = originOf(origin) || String(origin)
      delete data.permissions[key]
      save()
    },

    listPermissions() {
      return Object.entries(data.permissions).map(([origin, mode]) => ({ origin, mode }))
    },

    /** Append one audit row. `sensitive` rows keep their metadata, never their text. */
    audit(entry) {
      const row = { ts: new Date().toISOString(), ...entry }
      if (row.sensitive) row.text = '***'
      data.audit.push(row)
      if (data.audit.length > MAX_AUDIT_ROWS) data.audit = data.audit.slice(-MAX_AUDIT_ROWS)
      save()
      return row
    },

    readAudit(limit = 100) {
      const size = Math.max(1, Math.min(Number(limit) || 100, MAX_AUDIT_ROWS))
      return data.audit.slice(-size)
    },

    paused: {
      get() {
        return data.paused
      },
      set(value) {
        data.paused = Boolean(value)
        save()
      },
    },
  }
}

function openState({ dir }) {
  fs.mkdirSync(dir, { recursive: true })
  return createState(path.join(dir, 'state.json'))
}

module.exports = { openState, createState, originOf, hostOf, MAX_AUDIT_ROWS, MODES }
