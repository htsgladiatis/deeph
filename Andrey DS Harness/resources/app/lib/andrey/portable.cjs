'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * Portable distribution support.
 *
 * A `portable.txt` file next to the executable turns the program folder into
 * the data root: sessions, settings and accounts live in `andrey-data` inside
 * it, so the whole thing can be moved to another disk or machine and keeps its
 * state. Without the marker nothing changes: `%APPDATA%\\andrey-ds-harness`.
 */

const PORTABLE_MARKER = 'portable.txt'
const PORTABLE_DATA_DIR = 'andrey-data'
const SEED_DIR = path.join(__dirname, 'profile-seed')
const SEED_FILES = ['cordis.yml', 'package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml']

/**
 * Where this run keeps its data.
 * @param {{ appData?: string, exeDir?: string, env?: Record<string, string|undefined> }} options
 */
function resolveDataRoot({ appData, exeDir, env } = {}) {
  const environment = env || process.env
  if (exeDir && fs.existsSync(path.join(exeDir, PORTABLE_MARKER))) {
    return { root: path.join(exeDir, PORTABLE_DATA_DIR), portable: true }
  }
  if (environment.ANDREY_DATA_ROOT) return { root: environment.ANDREY_DATA_ROOT, portable: false }
  return { root: path.join(appData || '', 'andrey-ds-harness'), portable: false }
}

function profilePatchPath(dshHome) {
  return path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml')
}

/**
 * Install the shipped starting profile when this machine has none yet.
 *
 * A fresh install has no profile, and the host would initialize it with an
 * empty `[]` patch layer: no `llm-pi-ai` entry, so no freePi and no Freebuff
 * provider and the accounts panel has nothing to add an account to. Writing
 * the seed before the host reads the profile fixes that on the first launch.
 * An existing user patch is never replaced as long as it already carries the
 * providers; only a missing or providerless one is seeded.
 */
function ensureProfileSeed({ dshHome, seedDir } = {}) {
  try {
    if (!dshHome) return { ok: false, error: 'missing-dsh-home' }
    const seed = seedDir || SEED_DIR
    const patchPath = profilePatchPath(dshHome)
    if (fs.existsSync(patchPath)) {
      const text = fs.readFileSync(patchPath, 'utf8')
      if (text.includes('freepi')) return { ok: true, created: false }
    }
    const target = path.dirname(patchPath)
    fs.mkdirSync(target, { recursive: true })
    let copied = 0
    for (const name of SEED_FILES) {
      const from = path.join(seed, name)
      if (!fs.existsSync(from)) continue
      const to = path.join(target, name)
      if (name !== 'cordis.patch.yml' && fs.existsSync(to)) continue
      fs.copyFileSync(from, to)
      copied += 1
    }
    return { ok: true, created: copied > 0, copied }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
}

module.exports = {
  resolveDataRoot,
  ensureProfileSeed,
  profilePatchPath,
  PORTABLE_MARKER,
  PORTABLE_DATA_DIR,
  SEED_DIR,
  SEED_FILES,
}
