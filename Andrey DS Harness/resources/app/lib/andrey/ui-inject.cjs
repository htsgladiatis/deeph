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

const VERSION_LABEL = 'Andrey Version 0.2'
const SCRIPT_FILE = path.join(__dirname, 'ui-renderer.js')
const PET_FILE = path.join(__dirname, 'pet.js')
const DESIGN_DIR = path.join(__dirname, 'design')
const DESIGN_SCRIPTS = ['ops.js', 'canvas.js', 'panel.js']

let cached = null

/** @returns the script text, read once per process. */
function rendererScript() {
  if (cached === null) {
    const design = DESIGN_SCRIPTS
      .map((name) => fs.readFileSync(path.join(DESIGN_DIR, name), 'utf8'))
      .join('\n;\n')
    const css = fs.readFileSync(path.join(DESIGN_DIR, 'panel.css'), 'utf8')
    const style = `(() => { const node = document.createElement('style'); node.id = 'andrey-design-style'; node.textContent = ${JSON.stringify(css)}; document.head.appendChild(node); })();`
    cached = [style, design, fs.readFileSync(SCRIPT_FILE, 'utf8'), fs.readFileSync(PET_FILE, 'utf8')].join('\n;\n')
  }
  return cached
}

/** Attach to one window, now and after every reload. */
function attach(win) {
  const run = () => {
    try {
      win.webContents.executeJavaScript(rendererScript(), true).catch(() => {})
    } catch {
      /* the window may already be gone */
    }
  }
  win.webContents.on('did-finish-load', run)
  if (!win.webContents.isLoading()) run()
}

/** Wire the additions to the app: existing windows and every new one. */
function install(app) {
  try {
    for (const win of app.getAllWindows?.() ?? []) attach(win)
    app.on('browser-window-created', (_event, win) => attach(win))
  } catch {
    /* the host runs without our additions */
  }
}

module.exports = { install, rendererScript, VERSION_LABEL }
