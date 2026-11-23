'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { readToken } = require('./freebuff-login.cjs')

/**
 * The official Freebuff CLI, hosted inside a terminal pty.
 *
 * Freebuff has no headless mode: `freebuff --help` exposes only `login`,
 * `doctor`, `--continue`, `--cwd` and `--trust-agents`, and the server rejects
 * direct API use (`403 free_mode_cli_required`). The sanctioned client is the
 * TUI itself, so this module only locates that binary and hands it the token we
 * already obtained through `freebuff-login.cjs`.
 *
 * The CLI keeps its credentials in its own config dir (`~/.config/manicode`).
 * We read our token from the app's agent home and mirror it there, keeping a
 * one-time backup of whatever the user had before so nothing is silently lost.
 */

function userHomePath({ env = process.env } = {}) {
  return env.USERPROFILE || env.HOME || os.homedir()
}

function cliConfigDir({ userHome = userHomePath() } = {}) {
  return path.join(userHome, '.config', 'manicode')
}

function cliCredentialsPath(options = {}) {
  return path.join(cliConfigDir(options), 'credentials.json')
}

function projectsDir(options = {}) {
  return path.join(cliConfigDir(options), 'projects')
}

/** The folder name the CLI files a project under: the basename of its cwd. */
function projectChatsDir({ cwd, userHome } = {}) {
  if (typeof cwd !== 'string' || !cwd) return null
  return path.join(projectsDir({ userHome }), path.basename(cwd), 'chats')
}

/**
 * The newest stored conversation for this folder, or null. The CLI files chats
 * as `projects/<basename>/chats/<iso-timestamp>/`; that timestamp is the id
 * `--continue <id>` expects (a bare `--continue` starts a new chat instead).
 */
function latestChatId({ cwd, userHome } = {}) {
  const dir = projectChatsDir({ cwd, userHome })
  if (!dir) return null
  try {
    const ids = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => fs.existsSync(path.join(dir, entry.name, 'chat-messages.json')))
      .map((entry) => entry.name)
      .sort()
    return ids.at(-1) ?? null
  } catch {
    return null
  }
}

function hasProjectChats({ cwd, userHome } = {}) {
  return latestChatId({ cwd, userHome }) !== null
}

function binName(platform = process.platform) {
  return platform === 'win32' ? 'freebuff.exe' : 'freebuff'
}

/**
 * Resolution order: FREEBUFF_CLI_ENTRY, the copy shipped in this fork, the
 * CLI's own config dir (where its launcher unpacks the binary), then PATH.
 * A fresh clone therefore needs no separate CLI install. Returns an absolute
 * path or null.
 */
function resolveFreebuffBin({ env = process.env, platform = process.platform, userHome } = {}) {
  const override = env.FREEBUFF_CLI_ENTRY
  if (typeof override === 'string' && override && fs.existsSync(override)) return override

  // Pinned CLI shipped with the app: the exact binary the route was verified
  // against, so a machine with no ~/.config/manicode install still works.
  const shipped = path.join(__dirname, 'bin', binName(platform))
  if (fs.existsSync(shipped)) return shipped

  const bundled = path.join(cliConfigDir({ userHome: userHome ?? userHomePath({ env }) }), binName(platform))
  if (fs.existsSync(bundled)) return bundled

  const pathValue = env.PATH ?? env.Path ?? ''
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, binName(platform))
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function readCliCredentials(options = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cliCredentialsPath(options), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Mirror the app's Freebuff token into the CLI's credentials file.
 * Returns `{ ok: true }`, or `{ ok: false, error }` without touching the disk.
 */
function systemHome({ env = process.env } = {}) {
  return env.USERPROFILE || env.HOME || os.homedir()
}

function syncCliCredentials({ home, userHome, force = false } = {}) {
  const token = readToken({ home })
  if (!token?.token) return { ok: false, error: 'login-required' }

  const file = cliCredentialsPath({ userHome })
  const current = readCliCredentials({ userHome })
  const entry = current.default && typeof current.default === 'object' ? current.default : {}
  const already = entry.authToken === token.token && entry.email === token.email
  if (already && !force) return { ok: true, file, unchanged: true }

  const backup = `${file}.freepi-backup`
  try {
    if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup)
  } catch {
    // A backup that cannot be written must not block a working session.
  }

  const next = {
    ...current,
    default: {
      ...entry,
      id: token.userId ?? entry.id,
      email: token.email ?? entry.email,
      name: entry.name ?? (token.email ? String(token.email).split('@')[0] : 'freebuff'),
      authToken: token.token,
    },
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
  } catch (err) {
    return { ok: false, error: 'write-failed', detail: String(err?.message ?? err) }
  }
  return { ok: true, file }
}

/**
 * What the renderer needs to decide whether the Freebuff view can start.
 * `loggedIn` is about our own login; `cliFound` is about the binary.
 */
function status({ home, userHome, env, platform } = {}) {
  const token = readToken({ home })
  // The binary lives in the system install; only the config dir is per-profile.
  const bin = resolveFreebuffBin({ env, platform, userHome: systemHome({ env }) })
  return {
    ok: true,
    loggedIn: Boolean(token?.token),
    email: token?.email ?? null,
    cliFound: Boolean(bin),
    binPath: bin,
  }
}

/**
 * The command a pty should run. Kept separate from the registry so the registry
 * stays free of Freebuff details and tests can assert the argv.
 */
function sessionCommand({ cwd, home, userHome, env, platform, resume = false } = {}) {
  if (typeof cwd !== 'string' || !cwd) return { ok: false, error: 'invalid-cwd' }
  const synced = syncCliCredentials({ home, userHome })
  if (!synced.ok) return synced
  const bin = resolveFreebuffBin({ env, platform, userHome: systemHome({ env }) })
  if (!bin) return { ok: false, error: 'cli-not-found' }

  const args = ['--cwd', cwd]
  if (resume) {
    const chatId = latestChatId({ cwd, userHome })
    if (chatId) args.push('--continue', chatId)
  }

  const base = env ?? process.env
  const profileEnv = userHome
    ? { USERPROFILE: userHome, HOME: userHome, XDG_CONFIG_HOME: path.join(userHome, '.config') }
    : {}
  return {
    ok: true,
    file: bin,
    args,
    env: {
      ...base,
      ...profileEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FREEBUFF_NO_AUTO_UPDATE: '1',
    },
  }
}

module.exports = {
  cliConfigDir,
  cliCredentialsPath,
  projectsDir,
  projectChatsDir,
  latestChatId,
  hasProjectChats,
  readCliCredentials,
  resolveFreebuffBin,
  syncCliCredentials,
  status,
  sessionCommand,
}
