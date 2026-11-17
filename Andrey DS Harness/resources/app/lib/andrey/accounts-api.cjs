'use strict'

/**
 * The account surface the settings panel talks to.
 *
 * Everything the CLI (`_integr/accounts.cjs`) can do is reachable over loopback
 * too, so the panel needs no privileges of its own: list, add, sign in again,
 * switch, remove. Adding is also signing in — both providers use a device flow,
 * which means the host has to show a link, wait for approval and then store the
 * token. That wait runs in the background here: the request returns the link at
 * once, and the panel polls {@link listAccounts} until the account turns
 * `loggedIn`.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const PI_BASE = 'https://api.freepi.ai'

/** In-flight device logins: `provider` → `{ accountId, url, state, error }`. */
const pending = new Map()

function systemHome() {
  const accountHome = path.join('C:', path.sep, 'Users', require('node:os').userInfo().username)
  const candidates = [process.env.ANDREY_SYSTEM_HOME, process.env.USERPROFILE, process.env.HOME, accountHome]
    .filter((candidate) => typeof candidate === 'string' && candidate !== '')
  for (const candidate of candidates) {
    if (path.basename(candidate).toLowerCase() === 'agent-home') continue
    if (fs.existsSync(path.join(candidate, '.config', 'manicode', 'freebuff.exe'))) return candidate
  }
  return accountHome
}

/** Hand a URL to the desktop's default browser. Failure is not fatal: the panel shows it too. */
function openExternally(url) {
  try {
    const command = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]]
    spawn(command[0], command[1], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    /* the link is still on screen */
  }
}

/** The account list as the panel renders it, with any in-flight login marked. */
function listAccounts({ store }) {
  const result = { pi: store.describe('pi'), freebuff: store.describe('freebuff'), pending: {} }
  for (const [provider, flow] of pending) {
    result.pending[provider] = { accountId: flow.accountId, state: flow.state, url: flow.url, error: flow.error ?? null }
  }
  return result
}

/**
 * Start the device flow for one account and finish it in the background.
 *
 * The store is re-created inside the flow: the token can arrive minutes after the
 * request that started it, and the accounts file may have changed meanwhile.
 */
async function startLogin({ provider, accountId, store, dataRoot, log = () => {}, openBrowser = true }) {
  const { createStore } = require('./accounts.cjs')
  const account = store.profiles.find(provider, accountId)
  if (!account) return { ok: false, error: 'unknown-account' }

  const current = pending.get(provider)
  if (current && current.accountId === accountId && current.state === 'waiting') {
    return { ok: true, accountId, url: current.url, alreadyRunning: true }
  }

  if (provider === 'pi') {
    const piLogin = require('./accounts/login.cjs')
    const flow = await piLogin.startDeviceLogin({ baseUrl: PI_BASE })
    const url = flow.verificationUriComplete ?? flow.verificationUri
    pending.set(provider, { accountId, url, state: 'waiting' })

    piLogin.pollForToken({
      baseUrl: PI_BASE,
      sessionId: flow.sessionId,
      interval: flow.interval ?? 5,
      deadlineMs: 15 * 60 * 1000,
    }).then(async ({ token }) => {
      piLogin.saveToken({ home: account.home, token })
      pending.delete(provider)
      log('info', 'accounts:pi-login', { accountId, ok: true })
      // The active account's token has to reach the profile as well.
      try {
        const { applyActivePiAccount } = require('./pi-profile.cjs')
        await applyActivePiAccount({
          store: createStore({ dataRoot }),
          profilePath: path.join(dataRoot, 'dsh-home', 'profiles', 'desktop', 'cordis.patch.yml'),
        })
      } catch {
        /* the next boot applies it */
      }
    }).catch((error) => {
      pending.set(provider, { accountId, url, state: 'failed', error: String(error?.message ?? error) })
      log('error', 'accounts:pi-login', { accountId, error: String(error?.message ?? error) })
    })

    if (openBrowser) openExternally(url)
    return { ok: true, accountId, url, userCode: flow.userCode }
  }

  const fbLogin = require('./freebuff/freebuff-login.cjs')
  const { syncCliCredentials } = require('./freebuff/freebuff-cli.cjs')
  const flow = await fbLogin.startLogin({ home: account.appHome })
  pending.set(provider, { accountId, url: flow.loginUrl, state: 'waiting' })

  fbLogin.pollLogin({
    ...flow,
    intervalMs: 4000,
    deadlineMs: 60 * 60 * 1000,
  }).then((result) => {
    fbLogin.saveToken({ home: account.appHome, token: result.token, user: result.user })
    syncCliCredentials({
      home: account.appHome,
      userHome: account.userHome ?? systemHome(),
      force: true,
    })
    pending.delete(provider)
    log('info', 'accounts:freebuff-login', { accountId, ok: true })
  }).catch((error) => {
    pending.set(provider, { accountId, url: flow.loginUrl, state: 'failed', error: String(error?.message ?? error) })
    log('error', 'accounts:freebuff-login', { accountId, error: String(error?.message ?? error) })
  })

  if (openBrowser) openExternally(flow.loginUrl)
  return { ok: true, accountId, url: flow.loginUrl }
}

/** Add an account and immediately start its sign-in. */
async function addAccount({ provider, label, store, dataRoot, log, openBrowser = true }) {
  if (provider !== 'pi' && provider !== 'freebuff') return { ok: false, error: 'invalid-provider' }
  const added = store.profiles.add(provider, label)
  if (!added.ok) return added

  const { createStore } = require('./accounts.cjs')
  const login = await startLogin({
    provider,
    accountId: added.id,
    store: createStore({ dataRoot }),
    dataRoot,
    log,
    openBrowser,
  })
  return { ...login, id: added.id }
}

/**
 * Make an account active.
 *
 * Both providers are read per request by the local route, so a switch takes
 * effect on the next message: nothing needs a restart, and the open chat keeps
 * its history.
 */
async function switchAccount({ provider, accountId, store, dataRoot, log }) {
  const result = store.profiles.activate(provider, accountId)
  if (!result.ok) return result

  if (provider === 'pi') {
    const { createStore } = require('./accounts.cjs')
    const { applyActivePiAccount } = require('./pi-profile.cjs')
    const applied = await applyActivePiAccount({
      store: createStore({ dataRoot }),
      profilePath: path.join(dataRoot, 'dsh-home', 'profiles', 'desktop', 'cordis.patch.yml'),
      log,
    })
    return { ok: true, needsRestart: false, profileApplied: applied.ok, error: applied.ok ? null : applied.error }
  }
  return { ok: true, needsRestart: false }
}

function removeAccount({ provider, accountId, store }) {
  const result = store.profiles.remove(provider, accountId)
  if (result.ok && pending.get(provider)?.accountId === accountId) pending.delete(provider)
  return result
}

module.exports = {
  listAccounts,
  addAccount,
  startLogin,
  switchAccount,
  removeAccount,
  openExternally,
}
