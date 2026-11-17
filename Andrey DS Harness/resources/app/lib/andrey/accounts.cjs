'use strict'

/**
 * Saved identities for both providers, on top of free-pi's own store.
 *
 * `accounts/profiles.cjs` is free-pi's code unchanged: it owns the JSON layout,
 * the per-profile credential homes and the rule that the `default` profile
 * keeps the legacy location. This module only supplies *this* copy's answers to
 * the two questions that module asks — where the store lives, and where the
 * legacy home is — plus the identity lookups the CLI needs to show who is who.
 *
 * Two accounts never share a token:
 *   pi        home/.free-pi/agent/credentials.json
 *   freebuff  appHome/.freebuff/credentials.json  +  userHome as the CLI's home
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createProfiles, emailFromToken } = require('./accounts/profiles.cjs')
const piLogin = require('./accounts/login.cjs')
const { readToken: readFreebuffToken } = require('./freebuff/freebuff-login.cjs')

/** Windows account home; USERPROFILE can point into an agent profile instead. */
function systemHome() {
  const accountHome = path.join('C:', path.sep, 'Users', os.userInfo().username)
  const candidates = [process.env.ANDREY_SYSTEM_HOME, process.env.USERPROFILE, process.env.HOME, accountHome]
    .filter((candidate) => typeof candidate === 'string' && candidate !== '')
  for (const candidate of candidates) {
    if (path.basename(candidate).toLowerCase() === 'agent-home') continue
    if (fs.existsSync(path.join(candidate, '.config', 'manicode', 'freebuff.exe'))) return candidate
  }
  return accountHome
}

function dataRoot() {
  return process.env.ANDREY_DATA_ROOT || path.join(systemHome(), 'AppData', 'Roaming', 'andrey-ds-harness')
}

/**
 * The store for this copy.
 *
 * `accounts.json`, not free-pi's `profiles.json`: that file may already exist in
 * this folder from an earlier experiment and points at FreePi Desktop's homes,
 * which this copy must not borrow tokens from.
 */
function createStore(options = {}) {
  const root = options.dataRoot ?? dataRoot()
  const profiles = createProfiles({
    userData: root,
    defaultHome: path.join(root, 'agent-home'),
    file: options.file ?? path.join(root, 'accounts.json'),
  })

  function piToken(account) {
    return piLogin.readToken({ home: account.home })
  }

  /** What the CLI prints: id, label, whether a token exists and whose it is. */
  function describe(provider) {
    const state = profiles.read()
    const accounts = state.accounts[provider]
    return accounts.map((account) => {
      if (provider === 'pi') {
        const token = piToken(account)
        return {
          id: account.id,
          label: account.label,
          home: account.home,
          active: state.active.pi === account.id,
          loggedIn: Boolean(token),
          email: emailFromToken(token),
        }
      }
      const token = readFreebuffToken({ home: account.appHome })
      return {
        id: account.id,
        label: account.label,
        home: account.appHome,
        cliHome: account.userHome ?? null,
        active: state.active.freebuff === account.id,
        loggedIn: Boolean(token?.token),
        email: token?.email ?? null,
      }
    })
  }

  return { profiles, root, describe, piToken, file: profiles.file }
}

module.exports = { createStore, systemHome, dataRoot, emailFromToken }
