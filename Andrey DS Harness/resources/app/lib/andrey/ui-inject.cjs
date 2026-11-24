'use strict'

/**
 * Attach our renderer additions to their windows.
 *
 * Why not a plugin: a dsh client plugin has to arrive through the profile's
 * plugin list, and in this build a newly inserted plugin package never reaches
 * the client manifest (`__DSH_BOOT__.entries` stays without it), so nothing of
 * ours would load. Why not a bundle patch: their client bundles are compiled
 * output with hashed class names, so a text patch there would be unreadable and
 * unmaintainable for no gain — this fork is frozen, but it still has to be
 * something we can repair in a minute.
 *
 * So the additions live in `ui-renderer.js` and `pet.js`, plain scripts this module reads
 * and runs in the page after every load. It is additive and idempotent: it marks
 * everything it adds and re-attaches itself if their React tree renders over it.
 *
 * Nothing here may throw into their boot: a missing caption must never cost the
 * app.
 */

const fs = require('node:fs')
const path = require('node:path')

const VERSION_LABEL = 'Andrey Version 0.5.6'
const SCRIPT_FILE = path.join(__dirname, 'ui-renderer.js')
const PET_FILE = path.join(__dirname, 'pet.js')
const DESIGN_DIR = path.join(__dirname, 'design')
const DESIGN_SCRIPTS = ['ops.js', 'canvas.js', 'panel.js']
/** The port the route binds when nothing else holds it. */
const DEFAULT_API_BASE = 'http://127.0.0.1:39147'

let cached = null

/**
 * Join classic scripts so one broken segment cannot take the rest down.
 *
 * The pieces are independent — a caption, the design canvas, the pet — and share
 * only `window`. Concatenated plainly, one throw (a DOM change in an upstream
 * build) skipped every later segment, so a broken badge also cost the design
 * panel and the pet, with a single error in the page console. Each segment now
 * runs in its own `try` and reports what failed.
 */
function bundle(segments) {
  return segments
    .map((source) => `try {\n${source}\n} catch (error) { console.error('[andrey] segment failed', error) }`)
    .join('\n;\n')
}

/** The static part of the bundle, read once per process. */
function body() {
  if (cached === null) {
    const css = fs.readFileSync(path.join(DESIGN_DIR, 'panel.css'), 'utf8')
    const style = `(() => { const node = document.createElement('style'); node.id = 'andrey-design-style'; node.textContent = ${JSON.stringify(css)}; document.head.appendChild(node); })();`
    // Each design script is its own segment too: the canvas needs ops, the panel
    // needs neither, so a break in one must not blank the other two.
    const design = DESIGN_SCRIPTS.map((name) => fs.readFileSync(path.join(DESIGN_DIR, name), 'utf8'))
    cached = bundle([style, ...design, fs.readFileSync(SCRIPT_FILE, 'utf8'), fs.readFileSync(PET_FILE, 'utf8')])
  }
  return cached
}

/**
 * The pairing token and the extension folder, read from disk on every call.
 *
 * The renderer cannot read files and cannot open a WebSocket to loopback, so the
 * only way for the browser panel to reach the bridge is an HTTP control call with
 * this token in a header. It is read fresh per page load, so rotating the token
 * takes effect on the next reload. The folder is only a path to show and copy.
 */
function browserGlobals() {
  const extensionDir = path.join(__dirname, 'browser', 'extension')
  try {
    const root = process.env.ANDREY_DATA_ROOT || path.join(process.env.APPDATA || '', 'andrey-ds-harness')
    const state = JSON.parse(fs.readFileSync(path.join(root, 'browser', 'state.json'), 'utf8'))
    const token = typeof state.token === 'string' ? state.token : ''
    return { token, extensionDir }
  } catch {
    return { token: '', extensionDir }
  }
}

/**
 * @param {{ apiBase?: string }} [options] the route's real base; the route steps
 *   to the next port when 39147 is taken, and the renderer must follow it.
 * @returns the script text.
 */
function rendererScript(options = {}) {
  const apiBase = typeof options.apiBase === 'string' && options.apiBase !== '' ? options.apiBase : DEFAULT_API_BASE
  const browser = browserGlobals()
  const globals = [
    `window.__ANDREY_API_BASE__ = ${JSON.stringify(apiBase)}`,
    `window.__ANDREY_BROWSER_TOKEN__ = ${JSON.stringify(browser.token)}`,
    `window.__ANDREY_BROWSER_EXTENSION_DIR__ = ${JSON.stringify(browser.extensionDir)}`,
  ].join(';\n')
  return `${globals};\n;\n${body()}`
}

/** Attach to one window, now and after every reload. */
function attach(win, options = {}) {
  const run = () => {
    try {
      win.webContents.executeJavaScript(rendererScript(options), true).catch(() => {})
    } catch {
      /* the window may already be gone */
    }
  }
  win.webContents.on('did-finish-load', run)
  if (!win.webContents.isLoading()) run()
}

/** Wire the additions to the app: existing windows and every new one. */
function install(app, options = {}) {
  try {
    for (const win of app.getAllWindows?.() ?? []) attach(win, options)
    app.on('browser-window-created', (_event, win) => attach(win, options))
  } catch {
    /* the host runs without our additions */
  }
}

module.exports = { install, rendererScript, bundle, VERSION_LABEL, DEFAULT_API_BASE }
