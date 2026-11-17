'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * Saved identities per provider.
 *
 * Each profile owns its own credential home, so two accounts never share a
 * token, a session file or a Freebuff CLI config. Switching is an explicit user
 * action from the composer — nothing rotates accounts on rate limits.
 *
 * The `default` profile keeps the legacy locations (the app's agent home) so an
 * existing install keeps its login and chats after the upgrade.
 */
function createProfiles({ userData, defaultHome, file = null } = {}) {
  const storeFile = file ?? path.join(userData, 'profiles.json')
  const defaultProfile = {
    pi: [{ id: 'default', label: 'Default', home: defaultHome }],
    freebuff: [{ id: 'default', label: 'Default', appHome: defaultHome, userHome: null }],
  }

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
      const active = parsed?.active ?? {}
      const accounts = parsed?.accounts ?? {}
      return {
        version: 1,
        active: {
          pi: typeof active.pi === 'string' ? active.pi : 'default',
          freebuff: typeof active.freebuff === 'string' ? active.freebuff : 'default',
        },
        accounts: {
          pi: Array.isArray(accounts.pi) && accounts.pi.length > 0 ? accounts.pi : defaultProfile.pi,
          freebuff: Array.isArray(accounts.freebuff) && accounts.freebuff.length > 0
            ? accounts.freebuff
            : defaultProfile.freebuff,
        },
      }
    } catch {
      return { version: 1, active: { pi: 'default', freebuff: 'default' }, accounts: defaultProfile }
    }
  }

  function write(state) {
    try {
      fs.mkdirSync(path.dirname(storeFile), { recursive: true })
      fs.writeFileSync(storeFile, `${JSON.stringify(state, null, 2)}\n`)
    } catch {
      // A missing store only loses the profile list, never a session.
    }
  }

  function ensure() {
    const state = read()
    write(state)
    return state
  }

  function activeId(provider) {
    return read().active[provider] ?? 'default'
  }

  function find(provider, id) {
    return read().accounts[provider].find((account) => account.id === id) ?? null
  }

  function active(provider) {
    const state = read()
    return state.accounts[provider].find((account) => account.id === state.active[provider])
      ?? state.accounts[provider][0]
  }

  /** pi needs the agent home; Freebuff needs both our app home and a CLI home. */
  function context(provider) {
    const account = active(provider)
    if (provider === 'pi') {
      return { id: account.id, home: account.home, agentDir: path.join(account.home, '.pi', 'agent') }
    }
    return { id: account.id, appHome: account.appHome, userHome: account.userHome ?? null }
  }

  function list() {
    const state = read()
    return {
      active: { ...state.active },
      accounts: {
        pi: state.accounts.pi.map((account) => ({ id: account.id, label: account.label })),
        freebuff: state.accounts.freebuff.map((account) => ({ id: account.id, label: account.label })),
      },
    }
  }

  function add(provider, label) {
    if (provider !== 'pi' && provider !== 'freebuff') return { ok: false, error: 'invalid-provider' }
    const state = read()
    const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const fallback = `Account ${state.accounts[provider].length + 1}`
    if (provider === 'pi') {
      const home = path.join(userData, 'profiles', 'pi', id, 'agent-home')
      state.accounts.pi.push({ id, label: label || fallback, home })
    } else {
      const root = path.join(userData, 'profiles', 'freebuff', id)
      state.accounts.freebuff.push({
        id,
        label: label || fallback,
        appHome: root,
        userHome: path.join(root, 'cli-home'),
      })
    }
    state.active[provider] = id
    write(state)
    return { ok: true, id, ...list() }
  }

  function activate(provider, id) {
    if (provider !== 'pi' && provider !== 'freebuff') return { ok: false, error: 'invalid-provider' }
    const state = read()
    if (!state.accounts[provider].some((account) => account.id === id)) {
      return { ok: false, error: 'unknown-account' }
    }
    state.active[provider] = id
    write(state)
    return { ok: true, ...list() }
  }

  function rename(provider, id, label) {
    if (provider !== 'pi' && provider !== 'freebuff') return { ok: false, error: 'invalid-provider' }
    const clean = typeof label === 'string' ? label.trim().slice(0, 60) : ''
    if (!clean) return { ok: false, error: 'invalid-label' }
    const state = read()
    const account = state.accounts[provider].find((entry) => entry.id === id)
    if (!account) return { ok: false, error: 'unknown-account' }
    account.label = clean
    write(state)
    return { ok: true, ...list() }
  }

  function remove(provider, id) {
    if (provider !== 'pi' && provider !== 'freebuff') return { ok: false, error: 'invalid-provider' }
    const state = read()
    const accounts = state.accounts[provider]
    if (accounts.length <= 1) return { ok: false, error: 'last-account' }
    const index = accounts.findIndex((account) => account.id === id)
    if (index < 0) return { ok: false, error: 'unknown-account' }
    accounts.splice(index, 1)
    if (state.active[provider] === id) state.active[provider] = accounts[0].id
    write(state)
    return { ok: true, ...list() }
  }

  return { read: ensure, list, add, activate, remove, rename, active, activeId, find, context, file: storeFile }
}

/** The email embedded in a free-pi JWT, if the server put one there. */
function emailFromToken(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof payload?.email === 'string' ? payload.email : null
  } catch {
    return null
  }
}

module.exports = { createProfiles, emailFromToken }
