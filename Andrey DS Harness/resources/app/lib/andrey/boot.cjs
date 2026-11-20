'use strict'

/**
 * Entry point of the copied DeepSeek Harness.
 *
 * Three things happen here:
 *   1. the copy gets its own DSH home (profiles, sessions, storages) and its own
 *      Electron userData, so the original installation is never touched and the
 *      two apps can keep separate settings;
 *   2. the `freepi` provider is repointed at the local route and its model list
 *      is refreshed from the active account. The token itself is resolved per
 *      request by the route, so a switched account needs no restart;
 *   3. the Freebuff route starts on loopback: the official CLI has no HTTP API,
 *      so `freebuff-route.cjs` hosts it and speaks OpenAI chat-completions for
 *      the profile's `freebuff` provider;
 *   4. our own renderer additions (the version caption under the logo, provider
 *      highlighting, limits, the accounts page) are injected after their UI
 *      mounts — see `ui-inject.cjs` for why it is not a plugin;
 *   5. their untouched `lib/main.js` is imported exactly as before.
 *
 * No window, menu, tray or tray item is added: the host app is the app.
 */

const path = require('node:path')
const { app } = require('electron')

const root = path.join(app.getPath('appData'), 'andrey-ds-harness')

if (!process.env.DSH_HOME) process.env.DSH_HOME = path.join(root, 'dsh-home')
app.setPath('userData', path.join(root, 'desktop'))

// A switched freePi account is a changed bearer token in the provider entry.
// Synchronous, no network, best effort: a missing profile or an unreadable store
// must never stop the app from booting.
try {
  const { createStore } = require('./accounts.cjs')
  const { applyActivePiAccountSync } = require('./pi-profile.cjs')
  applyActivePiAccountSync({
    store: createStore({ dataRoot: root }),
    profilePath: path.join(process.env.DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml'),
  })
} catch {
  /* boot continues on the profile as it is */
}

// Freebuff turns are CLI runs measured in minutes, so their provider entry gets
// a stream timeout that outlives the queue and a retry count that starts no
// second run. Same best-effort rule as above.
try {
  const { applyFreebuffProfileSync } = require('./freebuff-profile.cjs')
  applyFreebuffProfileSync({
    profilePath: path.join(process.env.DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml'),
  })
} catch {
  /* boot continues on the profile as it is */
}

// The route is optional: a missing CLI or a busy port must never keep the host
// from booting. Failures land in freebuff-route.log.
//
// pi-ai rejects a provider route that names no key, even for a loopback route,
// so the profile points `apiKeyEnv` here at a placeholder that the local route
// never checks.
if (!process.env.FREEBUFF_LOCAL_KEY) process.env.FREEBUFF_LOCAL_KEY = 'freebuff-local'
// freePi now goes through its own loopback route too: the token is resolved per
// request, so only the credential-ref placeholder has to exist.
if (!process.env.FREEPI_LOCAL_KEY) process.env.FREEPI_LOCAL_KEY = 'freepi-local'
if (!process.env.ANDREY_FREEBUFF_ROUTE_DISABLED) {
  try {
    require('./freebuff-route.cjs').start({ dataRoot: root }).catch(() => {})
  } catch {
    /* the host boots without the route */
  }
}

module.exports = import('../main.js').then((main) => {
  // Their UI owns the windows; we only attach to whatever it creates. A failure
  // here costs a caption, never the app.
  try {
    require('./ui-inject.cjs').install(app)
  } catch {
    /* the host runs without our additions */
  }
  return main
})
