'use strict'

/**
 * Entry point of the copied DeepSeek Harness.
 *
 * Three things happen here:
 *   1. the copy gets its own DSH home (profiles, sessions, storages) and its own
 *      Electron userData, so the original installation is never touched and the
 *      two apps can keep separate settings. A `portable.txt` beside the exe
 *      moves all of it into `<exe folder>/andrey-data` instead, and a machine
 *      without any profile first gets the shipped starting profile;
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
const { resolveDataRoot, ensureProfileSeed } = require('./portable.cjs')

// A `portable.txt` beside the executable keeps every byte of state inside the
// program folder; without it the app uses its own %APPDATA% directory.
const { root, portable } = resolveDataRoot({
  appData: app.getPath('appData'),
  exeDir: path.dirname(app.getPath('exe')),
})
if (portable) process.env.ANDREY_PORTABLE = '1'
if (!process.env.ANDREY_DATA_ROOT) process.env.ANDREY_DATA_ROOT = root
if (!process.env.DSH_HOME) process.env.DSH_HOME = path.join(root, 'dsh-home')
app.setPath('userData', path.join(root, 'desktop'))

// A fresh machine has no profile, and the host would initialize one with an
// empty patch layer: no freePi provider, so no way to add a freePi account.
// The shipped seed has to be in place before the host reads the profile.
try {
  ensureProfileSeed({ dshHome: process.env.DSH_HOME })
} catch {
  /* the host boots on whatever profile exists */
}

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

// The bundled compaction backend condenses a 200k window at ~126k; freePi
// models are 200k, so the fork moves its trigger to 190k. Same best-effort rule.
try {
  const { applyCompactionProfileSync } = require('./compaction-profile.cjs')
  applyCompactionProfileSync({
    profilePath: path.join(process.env.DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml'),
  })
} catch {
  /* boot continues on the profile as it is */
}

// The in-browser agent is an MCP server the host mounts as `browser`. Its entry
// has to be in the profile before the host reads plugins, and every boot rewrites
// the file from the host's own state, so this runs here rather than at install.
try {
  const { applyBrowserProfileSync } = require('./browser-profile.cjs')
  applyBrowserProfileSync({
    profilePath: path.join(process.env.DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml'),
    mcpServerPath: path.join(__dirname, 'browser', 'mcp-server.cjs'),
    dataRoot: root,
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
let route = null
if (!process.env.ANDREY_FREEBUFF_ROUTE_DISABLED) {
  try {
    route = require('./freebuff-route.cjs').start({ dataRoot: root }).catch(() => null)
  } catch {
    /* the host boots without the route */
  }
}

module.exports = import('../main.js').then((main) => {
  // Their UI owns the windows; we only attach to whatever it creates. A failure
  // here costs a caption, never the app.
  //
  // The renderer's URLs follow the port the route actually bound: when 39147 is
  // taken the route moves to 39148, and a renderer locked to the default would
  // silently lose limits, accounts, ads and the design canvas.
  try {
    const inject = require('./ui-inject.cjs')
    if (route !== null) {
      route
        .then((started) => inject.install(app, { apiBase: started?.base }))
        .catch(() => inject.install(app))
    } else {
      inject.install(app)
    }
  } catch {
    /* the host runs without our additions */
  }
  return main
})