'use strict'

/**
 * Freebuff provider route for the copied DeepSeek Harness.
 *
 * Freebuff exposes no HTTP API (`403 free_mode_cli_required`); the official CLI
 * is the sanctioned client. Everything that talks to that CLI is free-pi's own
 * code, vendored unchanged under ./freebuff/:
 *
 *   freebuff-cli.cjs     binary lookup, credentials mirror, chat dirs
 *   freebuff-chat.cjs    chat-messages.json normalisation
 *   freebuff-models.cjs  `/model` picker card parsing
 *   pty-session.cjs      pty wrapper with Windows handle release
 *
 * This file only translates: one OpenAI chat-completions request becomes one
 * CLI run, and the transcript the CLI writes becomes the assistant answer.
 *
 * Three things differ from free-pi's window, all forced by the CLI being a TUI:
 *
 *   1. the picker is read from a rendered terminal (@xterm/headless), not from
 *      the raw ANSI stream — redraws interleave frames and card parsing against
 *      the stream picks up half-drawn rows;
 *   2. every keystroke waits for the screen to change. A fixed sleep either
 *      reads a stale frame or lets two arrow keys coalesce, which makes a walk
 *      skip models silently;
 *   3. only the conversation is typed into the CLI. The harness sends its own
 *      multi-thousand-character system prompt and tool catalog with every turn;
 *      Freebuff has its own, so forwarding ours would be both wrong and far
 *      beyond what a TUI input line can take.
 *
 * A run reports progress from the CLI's own transcript while it is written, so
 * a streamed answer arrives as it grows instead of after the whole turn. Runs
 * are also serialised per account: the CLI treats a peer's lock file as a live
 * session, so two overlapping runs stall each other with "holding queued
 * messages until rejoin".
 *
 *   GET  /v1/models
 *   POST /v1/chat/completions   (stream and non-stream)
 */

const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')

const { createPtySession } = require('./freebuff/pty-session.cjs')
const { cliConfigDir, projectChatsDir, sessionCommand, status: cliStatus } = require('./freebuff/freebuff-cli.cjs')
const { normalizeMessage } = require('./freebuff/freebuff-chat.cjs')
const { parsePicker } = require('./freebuff/freebuff-models.cjs')

// node-pty and @xterm/headless ship in the bundled runtime tree, not next to
// this file; loaded on first use so importing this module stays cheap.
const RUNTIME = process.env.ANDREY_DSH_RUNTIME || path.resolve(__dirname, '..', '..', 'dsh')
let nodePty = null
let TerminalCtor = null
function runtime() {
  if (nodePty === null) nodePty = require(path.join(RUNTIME, 'node_modules', 'node-pty'))
  if (TerminalCtor === null) TerminalCtor = require(path.join(RUNTIME, 'node_modules', '@xterm', 'headless')).Terminal
  return { nodePty, TerminalCtor }
}

const COLS = 120
const ROWS = 40
const PORT = 39147

/** A run's hard limit. A cut run still yields whatever the CLI already wrote. */
const RUN_TIMEOUT_MS = Number(process.env.FREEBUFF_RUN_TIMEOUT_MS) || 600_000
/** How long a request may wait for the account's current run to finish. */
const QUEUE_TIMEOUT_MS = Number(process.env.FREEBUFF_QUEUE_TIMEOUT_MS) || 900_000
/** Characters of conversation text forwarded to the CLI, newest turns first. */
const PROMPT_CHARS = Math.max(2_000, Number(process.env.FREEBUFF_PROMPT_CHARS) || 24_000)
/** Characters of the harness system prompt kept as a preamble (0 disables it). */
const SYSTEM_CHARS = Math.max(0, Number(process.env.FREEBUFF_SYSTEM_CHARS) || 4_000)

/**
 * A failure that another attempt cannot fix.
 *
 * Every freebuff attempt is a full CLI run, and some screens (an exhausted
 * hour, a spend confirmation) spend hours just by being confirmed. Reporting
 * these as 409 keeps the harness from retrying them five times, which its
 * policy does for a 5xx.
 */
class BlockedError extends Error {
  constructor(message, status = 409) {
    super(message)
    this.name = 'BlockedError'
    this.status = status
  }
}

/**
 * Screens that will never turn into an answer on their own.
 *
 * The CLI draws these instead of an input line. Entering them blindly either
 * buys the hour or waits ten minutes for a transcript that never appears, so
 * they are reported for what they are. Call this only while no transcript
 * exists yet: the running answer is drawn on the same screen, and an answer
 * that merely mentions hours must not end its own turn.
 */
function blockedScreen(flat) {
  if (/not enough hours|out of hours/i.test(flat)) return 'freebuff has no hours left for this account'
  if (/session (is )?over|holding queued messages/i.test(flat)) return 'freebuff session ended; rejoin in the CLI'
  if (/(confirm|approve)[^.]{0,80}(hours|wallet|balance)/i.test(flat)) return 'freebuff asks to confirm spending hours'
  return null
}

/** Model names last read from the picker; `/v1/models` serves these. */
let modelCache = []

function systemHome() {
  const accountHome = path.join('C:', path.sep, 'Users', os.userInfo().username)
  const candidates = [process.env.ANDREY_SYSTEM_HOME, process.env.USERPROFILE, process.env.HOME, accountHome]
    .filter((candidate) => typeof candidate === 'string' && candidate !== '')
  for (const candidate of candidates) {
    if (path.basename(candidate).toLowerCase() === 'agent-home') continue
    if (fs.existsSync(path.join(candidate, '.config', 'manicode', 'freebuff.exe'))) return candidate
  }
  return candidates[0] ?? os.homedir()
}

/**
 * The account the next run belongs to, read fresh every time.
 *
 * Switching a Freebuff account is just a change of this active id, so the route
 * picks it up on the next request — no restart, unlike freePi, whose token is
 * baked into the profile.
 */
function activeAccount() {
  const { createStore } = require('./accounts.cjs')
  const store = createStore({ dataRoot: dataRoot() })
  const account = store.profiles.context('freebuff')
  return {
    id: account.id,
    appHome: account.appHome,
    cliHome: account.userHome ?? null,
    store,
  }
}

function dataRoot() {
  return process.env.ANDREY_DATA_ROOT || path.join(systemHome(), 'AppData', 'Roaming', 'andrey-ds-harness')
}

function log(level, message, extra) {
  const { appendLog } = require('./route-log.cjs')
  appendLog(path.join(dataRoot(), 'freebuff-route.log'),
    JSON.stringify({ ts: new Date().toISOString(), level, message, ...extra }))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Junk the picker parse can produce from badge rows (`2x`, `10/17`, plan names). */
function isModelName(name) {
  if (typeof name !== 'string') return false
  const value = name.trim()
  if (value.length < 2) return false
  if (/^\d+\s*x$/i.test(value)) return false
  if (/^\d+\s*\/\s*\d+$/.test(value)) return false
  if (/^(may use data|paid plan|promotional|free|recommended|best|best value)$/i.test(value)) return false
  return /[a-z]/i.test(value)
}

/** Read the rendered terminal screen as plain text. */
function createScreen(term) {
  return () => {
    const lines = []
    for (let row = 0; row < term.buffer.active.length; row += 1) {
      lines.push(term.buffer.active.getLine(row)?.translateToString(true) ?? '')
    }
    return lines.join('\n')
  }
}

/** One-line view of the screen, for matching only.
 *
 * The TUI soft-wraps long status lines at the terminal width — the wrap lands
 * wherever the current cwd ends, and with a long account-id path it splits
 * even the literal `/model to change`. Matching must run against the flattened
 * text; parsing (the picker) keeps the raw lines.
 */
function flatScreen(screen) {
  return screen().replace(/[\s\u00b7\u2500-\u257f\u2580-\u259f\u2800-\u28ff]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s([\u2500-\u257f\u2580-\u259f\u2800-\u28ff])/g, '$1')
    .replace(/([\u2500-\u257f\u2580-\u259f\u2800-\u28ff])\s/g, '$1')
}

/**
 * End a run's CLI for good.
 *
 * `session.dispose()` only drops the pty handles — on Windows the CLI process
 * itself survives a closed console and lives on as a 100+ MB zombie holding
 * its session lock, which is how one timed-out run makes the next ones fail.
 * A run's CLI is ephemeral, so the run kills every freebuff.exe whose command
 * line carries this run's cwd — matching by command line (not by `session.pid`,
 * which is ConPTY's short-lived agent). With the default scratch cwd that path
 * is unique. When `FREEBUFF_CWD` points at a project the path is shared, so a
 * CLI the user runs manually in that same project would be killed too; the pty
 * cleanup still disposes our own child either way.
 */
function makeKillCli(execFileImpl) {
  /**
   * @returns {Promise<void>} settles once the CLI may no longer hold its lock.
   *
   * The account queue hands the slot to the next request when the run resolves,
   * and a new CLI that starts while the old one is still dying sees a live peer
   * lock and stalls on "holding queued messages". So the run must resolve after
   * this kill, not when it is merely started.
   */
  return function killCli(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return Promise.resolve()
    const filter = `Get-CimInstance Win32_Process -Filter "Name='freebuff.exe'" `
      + `| Where-Object { $_.CommandLine -like '*${cwd.replace(/'/g, "''")}*' } `
      + `| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    return new Promise((resolve) => {
      let settled = false
      const done = (error) => {
        if (settled) return
        settled = true
        if (error) log('error', 'freebuff:kill-failed', { cwd, message: String(error.message ?? error) })
        resolve()
      }
      try {
        execFileImpl('powershell', ['-NoProfile', '-Command', filter], { windowsHide: true }, done)
      } catch (error) {
        done(error)
      }
      // A wedged PowerShell must not hold the account's slot forever; the next
      // run prunes whatever lock the unkilled process left behind.
      setTimeout(() => done(new Error('killCli timed out')), 10_000).unref()
    })
  }
}

const killCli = makeKillCli(execFile)

/**
 * Wait until the TUI accepts slash commands.
 *
 * The chrome is drawn long before input is wired, so readiness is "the prompt
 * line exists and the screen stopped changing" — not the first frame that
 * happens to match. `/model` sent too early lands in the command palette and
 * the run then waits forever for an answer.
 *
 * Only the input line counts as the marker. An earlier gate also required the
 * status hint (`/model to change`, later `for history`) on the same screen, but
 * that hint is version- and key-dependent: when it was absent a perfectly ready
 * TUI looked dead for 30 s and the request failed. Screens that can never turn
 * into an input line are reported for what they are instead of timing out.
 */
async function waitForTui(screen, { timeoutMs = 30_000, isAborted, session } = {}) {
  const deadline = Date.now() + timeoutMs
  const startedAt = Date.now()
  let previous = ''
  let stableTicks = 0
  let promptSeen = false
  let trustAnswered = false
  while (Date.now() < deadline) {
    await sleep(600)
    if (isAborted?.() === true) throw new BlockedError('client disconnected', 499)
    const text = screen()
    const flat = flatScreen(screen)
    if (/Waiting for login|Press ENTER to login/i.test(flat)) throw new BlockedError('freebuff CLI is not logged in')
    if (/trust this (folder|repository)|do you trust the (agents|files)|load .*\.agents|Load and run these\?/i.test(flat)) {
      // Answer "no" explicitly instead of leaning on the Enter default: the
      // prompt is `[y/N]` today, and a release that flips the default must not
      // turn a blind Enter into "load this repository's agents".
      if (session !== undefined && trustAnswered === false) {
        trustAnswered = true
        log('info', 'freebuff:trust-skipped')
        session.write('n')
        await sleep(120)
        session.write('\r')
        await sleep(600)
        continue
      }
      throw new BlockedError('freebuff asks to trust agents in this folder')
    }
    if (/update available|new version of freebuff/i.test(flat)) throw new BlockedError('freebuff asks to update itself')
    const blocked = blockedScreen(flat)
    if (blocked !== null) throw new BlockedError(blocked)

    // The prompt text soft-wraps at the terminal width, so match the flattened
    // screen; the raw text is the fallback for a frame that is still drawing.
    const promptVisible = flat.includes('Enter a coding task') || text.includes('Enter a coding task')
    if (promptVisible) {
      promptSeen = true
      if (text === previous) {
        stableTicks += 1
        if (stableTicks >= 2) {
          log('info', 'freebuff:tui-ready', { ms: Date.now() - startedAt })
          return true
        }
      } else {
        stableTicks = 0
      }
    } else {
      stableTicks = 0
    }
    previous = text
  }
  // Keep the tail of the screen: a timeout without it is a guess.
  const stuck = previous.split('\n').filter((line) => line.trim() !== '').slice(-6).join(' / ')
  log('error', 'freebuff:tui-timeout', {
    hasPrompt: promptSeen,
    hasHistoryHint: /for history/.test(previous.replace(/\s+/g, ' ')),
    len: previous.length,
    screen: stuck.slice(0, 700),
  })
  throw new Error(`freebuff TUI did not become ready: ${stuck.slice(0, 200)}`)
}

/**
 * Open `/model`.
 *
 * A failed open is retried rather than reported: the first attempt can land in
 * the command palette while the TUI is still wiring input.
 */
async function openPicker(session, screen) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    session.write('/model')
    await sleep(150)
    session.write('\r')
    await sleep(1800)
    let state = parsePicker(screen())
    if (state.open) return state
    await sleep(900)
    state = parsePicker(screen())
    if (state.open) return state
    session.write('\x1b')
    await sleep(400)
  }
  return { open: false, entries: [], selected: null }
}

/**
 * One keystroke, settled.
 *
 * The TUI redraws asynchronously, so a fixed sleep after an arrow key either
 * reads a stale frame or lets the next key coalesce with the previous one —
 * which is how a walk silently skips models. Wait for the screen to change.
 *
 * The change has to be read from the screen text: moving the `›` marker keeps
 * the frame's length identical, and comparing lengths made every key wait out
 * the full timeout — a 30-second model pick for a 12-item list.
 */
function createKeyDriver(session, screen) {
  const press = async (key, timeoutMs = 900) => {
    const before = screen()
    session.write(key)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(50)
      if (screen() !== before) break
    }
    await sleep(120)
    return parsePicker(screen())
  }
  press.peek = () => parsePicker(screen())
  return press
}

/**
 * Walk the picker to its top, then through one full cycle.
 *
 * The list wraps, so a repeated selection marks a completed cycle. Every name
 * seen on the way is collected in picker order; `target` stops the walk and
 * confirms it with Enter.
 */
async function drivePicker(press, target) {
  let state = press.peek()
  let previous = state.selected
  for (let step = 0; step < 24; step += 1) {
    state = await press('\x1b[A')
    if (state.selected === previous) break
    previous = state.selected
  }

  const names = []
  const seen = new Set()
  let lastSelected = state.selected
  for (let step = 0; step < 32; step += 1) {
    state = press.peek()
    for (const entry of state.entries) {
      if (!isModelName(entry.name) || seen.has(entry.name)) continue
      seen.add(entry.name)
      names.push(entry.name)
    }
    if (target !== undefined && state.selected === target) {
      await press('\r', 3000)
      return { names, picked: true }
    }
    state = await press('\x1b[B')
    if (state.selected !== null && state.selected === lastSelected && names.length > 0) break
    if (state.selected !== null) lastSelected = state.selected
  }
  return { names, picked: false }
}

/** Drive the CLI picker to `wanted`; false leaves the CLI on its own default. */
async function pickModel(session, screen, wanted) {
  const opened = await openPicker(session, screen)
  if (!opened.open) return false
  if (opened.selected === wanted) {
    session.write('\r')
    await sleep(800)
    return true
  }
  const press = createKeyDriver(session, screen)

  // A target that is already on screen is a few keys away; the walk below
  // traverses the whole list first, which is only needed for off-screen names.
  const at = opened.entries.findIndex((entry) => entry.name === wanted)
  const from = opened.entries.findIndex((entry) => entry.name === opened.selected)
  if (at >= 0 && from >= 0 && at !== from) {
    const key = at > from ? '\x1b[B' : '\x1b[A'
    let state = press.peek()
    for (let step = 0; step < Math.abs(at - from); step += 1) {
      state = await press(key)
      if (state.selected === wanted) break
    }
    if (state.selected === wanted) {
      await press('\r', 3000)
      return true
    }
  }

  const { picked } = await drivePicker(press, wanted)
  if (!picked) {
    session.write('\x1b') // escape leaves the CLI's choice untouched
    await sleep(250)
  }
  return picked
}

/**
 * The conversation reaches the CLI as one message, preceded by a trimmed
 * system preamble. The tool catalog and harness plumbing in our system prompt
 * are useless to Freebuff's own agent, but the project instructions are not:
 * dropping the whole block silently changed how the agent behaved. The tail of
 * the conversation is kept because the TUI takes one message per run anyway.
 */
function messagesToPrompt(messages, limit = PROMPT_CHARS, systemLimit = SYSTEM_CHARS) {
  const system = []
  const turns = []
  for (const message of messages ?? []) {
    const content = typeof message?.content === 'string'
      ? message.content
      : Array.isArray(message?.content)
        ? message.content.map((part) => {
          if (part?.type === 'text') return part.text
          // The CLI transport is text-only. A marker keeps the model from
          // assuming the message was complete when a screenshot came with it.
          if (part?.type === 'image_url' || part?.type === 'input_image' || part?.type === 'image') return '[image omitted]'
          return ''
        }).join('\n')
        : ''
    if (content.trim() === '') continue
    if (message?.role === 'system') {
      system.push(content.trim())
      continue
    }
    turns.push({ role: message.role === 'assistant' ? 'Assistant' : 'User', content: content.trim() })
  }

  const joined = system.join('\n\n')
  const preamble = systemLimit > 0 && joined !== ''
    ? `[System]\n${joined.length > systemLimit ? `${joined.slice(0, systemLimit).trimEnd()} …` : joined}`
    : ''

  if (turns.length === 0) return preamble

  // Keep the newest turns, then restore order.
  const kept = []
  let size = 0
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    if (size + turns[at].content.length > limit && kept.length > 0) break
    kept.unshift(turns[at])
    size += turns[at].content.length
  }
  if (kept.length === 0) return preamble

  const last = kept.at(-1)
  const body = kept.length === 1 && last.role === 'User'
    ? last.content
    : kept.map((turn) => `[${turn.role}]\n${turn.content}`).join('\n\n')
  return preamble === '' ? body : `${preamble}\n\n${body}`
}

/**
 * Drop `freebuff-live-<pid>.json` locks whose owner is gone.
 *
 * The CLI takes a per-instance lock for its session handshake and treats every
 * lock file it finds as a live peer: a killed run leaves one behind, the next
 * CLI "resumes the hour a previous CLI left behind", gives up, and reports
 * `Freebuff session over; holding queued messages until rejoin` — the run then
 * never answers. Pruning dead owners is the only reliable way to recover.
 */
function pruneStaleLocks(cliHome) {
  const dir = cliConfigDir({ userHome: cliHome ?? systemHome() })
  let entries = []
  try {
    entries = fs.readdirSync(dir).filter((name) => /^freebuff-live-.*\.json$/.test(name))
  } catch {
    return 0
  }

  let removed = 0
  for (const name of entries) {
    const file = path.join(dir, name)
    let ownerPid = null
    try {
      ownerPid = JSON.parse(fs.readFileSync(file, 'utf8'))?.ownerPid ?? null
    } catch {
      /* unreadable lock: treat as stale */
    }
    let alive = false
    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      try {
        process.kill(ownerPid, 0)
        alive = true
      } catch {
        alive = false
      }
    }
    if (alive) continue
    try {
      fs.rmSync(file, { force: true })
      removed += 1
    } catch {
      /* another run may have removed it first */
    }
  }
  if (removed > 0) log('info', 'freebuff:stale-locks', { removed })
  return removed
}

/**
 * The project the CLI should work in, or null for the scratch folder.
 *
 * An OpenAI request carries no working directory, so the folder comes from
 * `FREEBUFF_CWD`. A missing or invalid path is not fatal: the run falls back to
 * the scratch folder instead of failing on a typo in the environment.
 */
function projectCwd() {
  const raw = process.env.FREEBUFF_CWD
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const resolved = path.resolve(raw.trim())
  try {
    if (fs.statSync(resolved).isDirectory()) return resolved
  } catch {
    /* fall through */
  }
  log('warn', 'freebuff:cwd-invalid', { raw })
  return null
}

/**
 * Spawn the CLI TUI; returns the session and its screen.
 *
 * Two directories: `runDir` is this run's private scratch folder and stays the
 * process cwd, so a stray file never lands in the user's project and `killCli`
 * can match this run by a path nobody else uses. `cwd` is where the agent works
 * — the project from `FREEBUFF_CWD`, or the scratch folder when it is unset.
 */
function spawnCli(cwdLabel) {
  const account = activeAccount()
  const cliHome = account.cliHome ?? undefined
  pruneStaleLocks(cliHome)

  // The vendored helpers resolve everything from `env`, and an agent shell can
  // point USERPROFILE into a profile directory; pin it to the account home that
  // actually owns the CLI binary.
  const baseEnv = { ...process.env, USERPROFILE: systemHome(), HOME: systemHome() }
  const inspect = cliStatus({ home: account.appHome, userHome: cliHome, env: baseEnv })
  if (!inspect.cliFound) throw new BlockedError('freebuff CLI not found')
  if (!inspect.loggedIn) throw new BlockedError(`freebuff account not logged in: ${account.id}`)

  const { nodePty: pty, TerminalCtor: Terminal } = runtime()
  const runDir = path.join(dataRoot(), 'freebuff-runs', account.id, cwdLabel)
  fs.mkdirSync(runDir, { recursive: true })
  const cwd = projectCwd() ?? runDir

  // free-pi's own command builder mirrors the account token into the CLI's
  // config and switches HOME/USERPROFILE for non-default accounts, which is what
  // keeps two accounts from ever sharing a CLI session or a chat folder.
  const command = sessionCommand({
    cwd,
    home: account.appHome,
    userHome: cliHome,
    env: baseEnv,
  })
  if (!command.ok) throw new BlockedError(`freebuff CLI unavailable: ${command.error}`)

  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 300 })
  const session = createPtySession({
    file: command.file,
    args: command.args,
    cwd: runDir,
    cols: COLS,
    rows: ROWS,
    env: command.env,
    spawn: (file, args, options) => pty.spawn(file, args, options),
  }, { onData: (chunk) => term.write(chunk) })

  return { session, screen: createScreen(term), cwd, cliHome, accountId: account.id }
}

/**
 * Strip bytes that would break out of a bracketed paste.
 *
 * The terminal delivers the paste payload literally, but the CLI's stdin parser
 * still scans it for the end marker: one ESC in the prompt ends the paste early
 * and every character after it arrives as a keystroke. Control characters have
 * no use in a prompt anyway, so they are dropped; tabs and newlines stay.
 */
function sanitizeForPaste(text) {
  return String(text ?? '')
    .replace(/\x1b/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

/**
 * One CLI run: pty, optional model pick, typed conversation, transcript.
 *
 * `onReady` fires once the CLI accepts input (so a stream can open its response
 * before the model starts), and `onUpdate` gets the transcript as it grows. A
 * run that hits its limit returns what was already written plus `partial: true`
 * instead of throwing the work away.
 */
async function runFreebuff({ prompt, model, timeoutMs = RUN_TIMEOUT_MS, onReady, onUpdate, isAborted }) {
  const { session, screen, cwd, cliHome, accountId } = spawnCli(Date.now().toString(36))

  // A closed request must not keep the CLI alive for ten minutes: the run is
  // serialised per account, so a discarded turn also blocks every later one.
  const ensureLive = () => {
    if (isAborted?.() === true) throw new BlockedError('client disconnected', 499)
  }

  try {
    await waitForTui(screen, { isAborted, session })

    const wanted = String(model ?? '').trim()
    if (wanted !== '') {
      const picked = await pickModel(session, screen, wanted)
      log('info', 'freebuff:model', { wanted, picked })
      if (!picked) {
        await leftOverPick(session)
        throw new BlockedError(`freebuff model not selectable: ${wanted}`)
      }
      await sleep(500)
    }

    onReady?.({ cwd, accountId })

    // The transcript lives in the CLI config of the active account. For the
    // default account that is the system home, which must be passed explicitly:
    // the vendored helpers would otherwise fall back to this process's
    // USERPROFILE, and under an agent shell that is a different directory.
    const chatsDir = projectChatsDir({ cwd, userHome: cliHome ?? systemHome() })

    // A TUI input line, not a pipe: send it in chunks so the pty buffer and the
    // terminal's own input handler both keep up. Bracketed paste does reach the
    // composer, but the CLI drops line breaks inside it (0.2.36: pasted code
    // arrives as a single line), so the prompt goes in as keystrokes with
    // newlines flattened.
    const single = sanitizeForPaste(prompt).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
    if (single.length !== prompt.trim().length) {
      log('warn', 'freebuff:prompt-flattened', { chars: prompt.length, sent: single.length })
    }
    for (let at = 0; at < single.length; at += 200) {
      ensureLive()
      if (session.write(single.slice(at, at + 200)) === false) {
        log('warn', 'freebuff:write-rejected', { at })
        throw new BlockedError('freebuff pty stopped accepting input')
      }
      await sleep(30)
    }
    await sleep(400)
    session.write('\r')

    // The prompt is keystrokes, so an overlay or a lost focus can swallow it;
    // the run then waits ten minutes for a transcript that never appears. The
    // CLI writes `chat-messages.json` as soon as it takes the message, so a
    // missing file is a reliable "not submitted" signal: press Enter again and
    // fail fast instead of hanging. Extra Enters are harmless once a turn runs.
    //
    // Acceptance is matched by content, not by folder age: the CLI creates the
    // chat folder while the TUI mounts, so a "new folder" baseline taken after
    // typing misses this run's own transcript, and in a shared project folder
    // older chats are everywhere. A chat that already holds our prompt is ours.
    const promptKey = single.slice(0, 60).replace(/\s+/g, ' ')
    const transcriptIn = () => {
      try {
        for (const id of fs.readdirSync(chatsDir).sort()) {
          const file = path.join(chatsDir, id, 'chat-messages.json')
          let raw = null
          try {
            raw = JSON.parse(fs.readFileSync(file, 'utf8'))
          } catch {
            continue // mid-write JSON
          }
          if (!Array.isArray(raw)) continue
          const taken = raw.some((message) => message?.variant === 'user'
            && typeof message?.content === 'string'
            && message.content.replace(/\s+/g, ' ').startsWith(promptKey))
          if (taken) return id
        }
        return null
      } catch {
        return null
      }
    }
    let accepted = null
    for (let attempt = 0; attempt < 3 && accepted === null; attempt += 1) {
      const until = Date.now() + 15_000
      while (Date.now() < until && accepted === null) {
        ensureLive()
        accepted = transcriptIn()
        if (accepted === null) {
          // An admission prompt replaces the input line here: the CLI took the
          // keystrokes but asks for a spend confirmation before running them.
          const blocked = blockedScreen(flatScreen(screen))
          if (blocked !== null) throw new BlockedError(blocked)
          await sleep(300)
        }
      }
      if (accepted === null) {
        log('warn', 'freebuff:prompt-retry', { attempt: attempt + 1 })
        session.write('\r')
      }
    }
    if (accepted === null) throw new Error('freebuff did not accept the prompt')

    // The CLI writes its transcript as it streams, and a message object only
    // carries `isComplete: true` once the turn really ended. free-pi's watcher
    // treats a *missing* flag as complete, which is fine for a live UI but not
    // for a blocking request: it returns a half-written reasoning block. So the
    // run reads the transcript itself and waits for the strict flag, reporting
    // what it sees on the way so a stream can render it.
    const deadline = Date.now() + timeoutMs
    let chatId = accepted
    let latest = { text: '', reasoning: '' }
    while (Date.now() < deadline) {
      ensureLive()
      if (chatId === null) {
        try {
          chatId = fs.readdirSync(chatsDir).sort().at(-1) ?? null
        } catch {
          /* the folder appears with the first prompt */
        }
      }
      if (chatId !== null) {
        const file = path.join(chatsDir, chatId, 'chat-messages.json')
        let raw = null
        try {
          raw = JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch {
          /* mid-write JSON: keep polling */
        }
        const last = Array.isArray(raw) ? raw.filter((message) => message?.variant === 'ai').at(-1) : null
        if (last !== null) {
          const message = normalizeMessage(last)
          const text = message.text ?? ''
          const reasoning = message.reasoning ?? ''

          // An agent question is a turn end, not an answer: the transcript only
          // resumes when someone types a reply. Returning the question lets the
          // user answer in the next message instead of waiting out the deadline.
          const questions = (message.asks ?? [])
            .flatMap((ask) => (ask.questions ?? []).map((entry) => entry.question))
            .filter((line) => typeof line === 'string' && line.trim() !== '')
          if (questions.length > 0) {
            const asked = questions.join('\n\n')
            // `raw` carries the question too: a stream flushes the tail from it,
            // and a question that only lives in `text` never reaches the client.
            const answer = text.trim() !== '' ? `${text.trim()}\n\n${asked}` : asked
            log('info', 'freebuff:asked', { chatId, questions: questions.length })
            return {
              text: answer,
              raw: answer,
              partial: false,
              cwd,
              chatId,
              accountId,
            }
          }

          if (text !== latest.text || reasoning !== latest.reasoning) {
            latest = { text, reasoning }
            onUpdate?.({ text, reasoning })
          }
          if (last.isComplete === true) {
            // The visible answer wins; reasoning is only a fallback for turns
            // that produced nothing else, because it is not what the model
            // answered.
            const answerText = text.trim()
            const onlyReasoning = reasoning.trim()
            const chosen = answerText !== '' ? answerText : onlyReasoning
            if (chosen === '') throw new Error('freebuff finished without an answer')
            return { text: chosen, raw: text, partial: false, cwd, chatId, accountId }
          }
        }
      }
      await sleep(400)
    }

    // Out of time: the turn is unfinished, but what the CLI wrote is still the
    // model's answer so far — better in the chat than a 502 after ten minutes.
    const answerText = latest.text.trim()
    const onlyReasoning = latest.reasoning.trim()
    const chosen = answerText !== '' ? answerText : onlyReasoning
    if (chosen === '') throw new Error('freebuff run timed out')
    log('warn', 'freebuff:partial', { chars: chosen.length, chatId })
    return { text: chosen, raw: latest.text, partial: true, reason: 'timeout', cwd, chatId, accountId }
  } finally {
    try { session.dispose() } catch { /* already gone */ }
    await killCli(cwd)
  }
}

/** Clear a picker the run left open, so disposal does not save a stray choice. */
async function leftOverPick(session) {
  try {
    session.write('\x1b')
    await sleep(200)
  } catch {
    /* the session may already be gone */
  }
}

/** Names the picker offers right now, top to bottom. */
async function listModels() {
  const { session, screen, cwd } = spawnCli('models')
  try {
    await waitForTui(screen, { session })
    const opened = await openPicker(session, screen)
    if (!opened.open) return []
    const press = createKeyDriver(session, screen)
    const { names } = await drivePicker(press)
    session.write('\x1b')
    await sleep(200)
    if (names.length > 0) modelCache = names
    return names
  } finally {
    try { session.dispose() } catch { /* already gone */ }
    killCli(cwd)
  }
}

/**
 * Token counts for the client's usage display.
 *
 * The CLI writes no token accounting anywhere we can read: the transcript has
 * text, the run state has TUI state, and `/usage` in the CLI reports credits.
 * The harness therefore used to receive zeros, which showed up as "no tokens"
 * and a zero TPS. These are estimates from the same heuristic the renderer uses
 * (~2 chars per token for Cyrillic, ~4 otherwise), and every run logs
 * `freebuff:usage-estimated` so a diagnostic never mistakes them for a
 * provider count.
 */
const CYRILLIC = /[\u0400-\u04FF]/g

function estimateTokens(text) {
  const value = String(text ?? '')
  if (value === '') return 0
  const match = value.match(CYRILLIC)
  const cyrillic = match === null ? 0 : match.length
  return Math.ceil(cyrillic / 2 + (value.length - cyrillic) / 4)
}

function usageFor({ promptTokens, answer, promptChars }) {
  // Non-stream turns send the whole answer, a stream has already sent it
  // delta by delta; both use the final text, so the count matches the display.
  const prompt = promptTokens > 0 ? promptTokens : estimateTokens(promptChars)
  const completion = estimateTokens(answer)
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  }
}

function sseChunk(id, created, model, delta, finish = null) {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false

    function cleanup() {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAbort)
      req.off('close', onAbort)
    }
    function finish(fn, value) {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }
    function onData(chunk) {
      size += chunk.length
      if (size > limit) {
        finish(reject, new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => finish(resolve, Buffer.concat(chunks).toString('utf8'))
    const onError = (error) => finish(reject, error)
    // A client that vanishes mid-body leaves no 'end'; without this the
    // handler waits on a socket that will never speak again.
    const onAbort = () => finish(reject, new Error('client disconnected before the body arrived'))

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAbort)
    req.on('close', onAbort)
  })
}

/**
 * One run at a time per account.
 *
 * The CLI takes a per-instance lock and treats any lock it finds in its config
 * dir as a live peer, so two overlapping runs of the same account stall each
 * other ("Freebuff session over; holding queued messages until rejoin"). A
 * waiting request is bounded by `QUEUE_TIMEOUT_MS` and gives its slot up if the
 * client disconnects.
 */
function createAccountQueue() {
  const states = new Map()
  const stateFor = (id) => {
    let state = states.get(id)
    if (!state) {
      state = { busy: false, waiters: [] }
      states.set(id, state)
    }
    return state
  }

  return {
    async run(accountId, task, { timeoutMs = QUEUE_TIMEOUT_MS, isAborted, onQueued } = {}) {
      const state = stateFor(accountId)
      if (!state.busy) {
        state.busy = true
      } else {
        onQueued?.(state.waiters.length + 1)
        await new Promise((resolve, reject) => {
          // The waiter used to learn about a disconnect only after being woken, so
          // a closed tab held this place for the whole queue timeout. Poll the
          // same signal the run itself uses.
          const dropSelf = () => {
            const at = state.waiters.indexOf(waiter)
            if (at >= 0) state.waiters.splice(at, 1)
          }
          const stop = () => {
            clearTimeout(timer)
            if (poll !== null) clearInterval(poll)
          }
          const waiter = {
            resolve: () => { stop(); resolve() },
            reject: (error) => { stop(); dropSelf(); reject(error) },
          }
          const timer = timeoutMs > 0 ? setTimeout(() => waiter.reject(new Error('freebuff queue timed out')), timeoutMs) : null
          const poll = typeof isAborted === 'function'
            ? setInterval(() => {
              if (isAborted() === true) waiter.reject(new Error('client disconnected'))
            }, 250)
            : null
          poll?.unref?.()
          state.waiters.push(waiter)
        })
      }

      try {
        if (isAborted?.() === true) throw new Error('client disconnected')
        return await task()
      } finally {
        const next = state.waiters.shift()
        if (next) next.resolve()
        else {
          state.busy = false
          if (states.get(accountId) === state) states.delete(accountId)
        }
      }
    },
  }
}

const accountQueue = createAccountQueue()

async function handleChat(res, body) {
  let request
  try {
    request = JSON.parse(body)
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }))
    return
  }

  const model = typeof request.model === 'string' && request.model !== '' ? request.model : (modelCache[0] ?? '')
  const stream = request.stream === true
  const prompt = messagesToPrompt(request.messages)
  // What the model actually received, for the usage estimate when the run ends.
  const promptTokens = (request.messages ?? []).reduce((sum, message) => {
    const content = message?.content
    if (typeof content === 'string') return sum + estimateTokens(content)
    if (!Array.isArray(content)) return sum + 4
    return content.reduce((inner, part) => inner + (part?.type === 'text' ? estimateTokens(part.text) : 0), sum) + 4
  }, 0)
  log('info', 'freebuff:prompt', { chars: prompt.length, messages: request.messages?.length ?? 0 })
  const id = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)

  if (prompt === '') {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'no conversation messages' } }))
    return
  }

  let headersSent = false
  let keepAlive = null
  let sentContent = ''
  let sentReasoning = ''

  const write = (chunk) => {
    try {
      if (!res.writableEnded && !res.destroyed) res.write(chunk)
    } catch {
      /* the client may be gone */
    }
  }

  // Headers open once the CLI accepts input, so a TUI that never came up still
  // reports a real 502 instead of a 200 stream that fails inside.
  const startStream = () => {
    if (headersSent) return
    headersSent = true
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    write(sseChunk(id, created, model, { role: 'assistant', content: '' }))
    keepAlive = setInterval(() => write(': keepalive\n\n'), 15_000)
    keepAlive.unref?.()
  }

  const flush = ({ text = '', reasoning = '' } = {}) => {
    if (!headersSent) return
    if (reasoning.length > sentReasoning.length && reasoning.startsWith(sentReasoning)) {
      write(sseChunk(id, created, model, { reasoning_content: reasoning.slice(sentReasoning.length) }))
      sentReasoning = reasoning
    }
    if (text.length > sentContent.length && text.startsWith(sentContent)) {
      write(sseChunk(id, created, model, { content: text.slice(sentContent.length) }))
      sentContent = text
    }
  }

  const flushFinal = (raw) => {
    if (!headersSent || typeof raw !== 'string' || raw === '' || raw === sentContent) return
    if (raw.startsWith(sentContent) || raw.trim() === sentContent.trim()) {
      if (raw.trim() === sentContent.trim()) return
      write(sseChunk(id, created, model, { content: raw.slice(sentContent.length) }))
      sentContent = raw
      return
    }
    // The transcript was rewritten rather than extended (rare): send it whole —
    // a repeated tail beats a truncated answer.
    log('warn', 'freebuff:rewrite', { sent: sentContent.length, final: raw.length })
    write(sseChunk(id, created, model, { content: raw }))
    sentContent = raw
  }

  try {
    const accountId = activeAccount().id
    log('info', 'freebuff:request', { model, stream, chars: prompt.length, accountId })
    const clientGone = () => res.destroyed === true || res.writableEnded === true

    const result = await accountQueue.run(accountId, () => runFreebuff({
      prompt,
      model,
      isAborted: clientGone,
      onReady: () => { if (stream) startStream() },
      onUpdate: (snapshot) => { if (stream) flush(snapshot) },
    }), {
      isAborted: clientGone,
      onQueued: (position) => log('info', 'freebuff:queued', { accountId, position }),
    })

    log(result.partial ? 'warn' : 'info', 'freebuff:done', {
      chars: result.text.length,
      partial: result.partial === true,
      reason: result.reason ?? null,
      cwd: result.cwd,
    })
    const finish = result.partial ? 'length' : 'stop'
    const usage = usageFor({ promptTokens, answer: result.text, promptChars: prompt })

    // The CLI reports no usage, so this event marks the numbers as computed
    // rather than received. Keep it next to `done` in the route log.
    log('info', 'freebuff:usage-estimated', {
      ...usage,
      method: 'chars/4 · cyrillic/2',
      answerChars: result.text.length,
      promptChars: prompt.length,
    })

    if (stream) {
      startStream()
      flushFinal(result.raw)
      // An OpenAI-compatible client reads usage from the final chunk with an
      // empty `choices` array (what `stream_options.include_usage` produces);
      // pi-ai parses `chunk.usage` before it looks at `choices`, so the count
      // lands even though this chunk carries no delta.
      write(`data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage,
      })}\n\n`)
      write(sseChunk(id, created, model, {}, finish))
      write('data: [DONE]\n\n')
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: finish }],
        usage,
      }))
    }
  } catch (error) {
    const message = String(error?.message ?? error)
    // 409 for states a retry cannot fix; the harness only retries 5xx.
    const status = Number.isInteger(error?.status) ? error.status : 502
    log('error', 'freebuff:failed', { message, status })
    if (headersSent) {
      // The stream is already open: an OpenAI-shaped error object is the only
      // way left to tell the client what happened.
      write(`data: ${JSON.stringify({ error: { message, type: 'provider_error' } })}\n\n`)
      write('data: [DONE]\n\n')
      if (!res.writableEnded) res.end()
    } else if (status !== 499) {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message, type: 'provider_error' } }))
    } else if (!res.writableEnded) {
      res.end()
    }
  } finally {
    if (keepAlive) clearInterval(keepAlive)
  }
}

/** Start the localhost route. Resolves once listening. */
/* ------------------------------------------------------------------------- *
 * Design canvas: document storage and the AI drawing endpoint.
 * ------------------------------------------------------------------------- */

let activePort = 0

const DESIGN_MAX_BYTES = 4 * 1024 * 1024
const DESIGN_MAX_DOCS = 50
const DESIGN_ID = /^[a-z0-9-]{1,40}$/

function designDir() {
  return path.join(dataRoot(), 'design')
}

function designPaths(idValue) {
  if (!DESIGN_ID.test(String(idValue ?? ''))) return null
  const dir = designDir()
  return { dir, file: path.join(dir, `${idValue}.json`), id: idValue }
}

function designRead(idValue) {
  const paths = designPaths(idValue)
  if (!paths) return { error: 'invalid-id' }
  try {
    const raw = fs.readFileSync(paths.file, 'utf8')
    const parsed = JSON.parse(raw)
    return { doc: parsed }
  } catch (error) {
    if (error?.code === 'ENOENT') return { error: 'not-found' }
    return { error: 'invalid-doc', detail: String(error?.message ?? error) }
  }
}

function designWrite(idValue, inputDoc) {
  const paths = designPaths(idValue)
  if (!paths) return { error: 'invalid-id' }
  let doc
  try {
    const ops = require('./design/ops.cjs')
    doc = ops.sanitizeDoc({ ...inputDoc, id: paths.id })
  } catch (error) {
    return { error: 'invalid-doc', detail: String(error?.message ?? error) }
  }
  const body = JSON.stringify(doc)
  if (Buffer.byteLength(body) > DESIGN_MAX_BYTES) return { error: 'too-large' }

  const tmp = `${paths.file}.tmp-${process.pid}`
  try {
    fs.mkdirSync(paths.dir, { recursive: true })
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, paths.file)
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    return { error: 'write-failed', detail: String(error?.message ?? error) }
  }
  designPrune()
  return { doc }
}

function designPrune() {
  try {
    const files = fs.readdirSync(designDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ name, stat: fs.statSync(path.join(designDir(), name)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    for (const entry of files.slice(DESIGN_MAX_DOCS)) {
      try { fs.rmSync(path.join(designDir(), entry.name), { force: true }) } catch { /* ignore */ }
    }
  } catch {
    /* pruning is best effort */
  }
}

function designList() {
  const dir = designDir()
  const docs = []
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const file = path.join(dir, name)
      try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
        docs.push({
          id: doc.id ?? name.replace(/\.json$/, ''),
          name: doc.name ?? 'Без названия',
          updatedAt: doc.updatedAt ?? null,
          nodes: Array.isArray(doc.nodes) ? doc.nodes.length : 0,
        })
      } catch {
        /* skip a corrupt file */
      }
    }
  } catch {
    return []
  }
  return docs.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
}

function designEnsureMain() {
  try {
    fs.mkdirSync(designDir(), { recursive: true })
    if (!fs.existsSync(path.join(designDir(), 'main.json'))) {
      const ops = require('./design/ops.cjs')
      designWrite('main', ops.emptyDoc('main'))
    }
  } catch {
    /* the first write recreates it */
  }
}

/** Model → provider, from the profile the app itself uses. */
function designModelCatalog() {
  const home = process.env.DSH_HOME
  const file = home
    ? path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
    : path.join(process.env.APPDATA ?? os.homedir(), 'andrey-ds-harness', 'dsh-home', 'profiles', 'desktop', 'cordis.patch.yml')
  const catalog = { freepi: [], freebuff: [] }
  try {
    const text = fs.readFileSync(file, 'utf8')
    let provider = null
    for (const line of text.split(/\r?\n/)) {
      const section = /^\s{6}([a-z0-9_-]+):\s*$/.exec(line)
      if (section) {
        provider = section[1] === 'freepi' || section[1] === 'freebuff' ? section[1] : null
        continue
      }
      if (!provider) continue
      const entry = /^\s*-\s*id:\s*(.+)$/.exec(line)
      if (entry) {
        const idValue = entry[1].trim().replace(/^['"]|['"]$/g, '')
        catalog[provider].push({ id: idValue, name: idValue })
        continue
      }
      const named = /^\s*name:\s*(.+)$/.exec(line)
      if (named && catalog[provider].length > 0) {
        catalog[provider][catalog[provider].length - 1].name = named[1].trim().replace(/^['"]|['"]$/g, '')
      }
    }
  } catch {
    /* empty catalog -> the caller reports no-model */
  }
  return catalog
}

function designFindProvider(model, catalog) {
  const needle = String(model ?? '').trim().toLowerCase()
  if (!needle) return null
  for (const provider of ['freepi', 'freebuff']) {
    const hit = catalog[provider].some((entry) => entry.id.toLowerCase() === needle || entry.name.toLowerCase() === needle)
    if (hit) return provider
  }
  return null
}

const DESIGN_SYSTEM = [
  'Ты — дизайнер, который правит JSON-документ канваса.',
  'Отвечай ТОЛЬКО JSON-объектом: {"ops":[...]} — без пояснений и без markdown.',
  'Допустимые операции:',
  ' {"op":"add","node":{...}} — новый узел, id можно не указывать',
  ' {"op":"update","id":"n_1","patch":{"x":10,"fill":"#fff"}}',
  ' {"op":"delete","id":"n_1"}',
  ' {"op":"clear"}',
  'Правила: координаты в пределах холста, текст по-русски, не больше 80 операций,',
  'шрифт Inter/system-ui, сетка кратна 8, контраст текста к фону ≥ 4.5:1.',
].join('\n')

function designCallModel({ port, provider, model, prompt }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: DESIGN_SYSTEM },
        { role: 'user', content: String(prompt ?? '') },
      ],
    })
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: provider === 'freepi' ? '/freepi/v1/chat/completions' : '/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 300_000,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`provider ${res.statusCode}: ${raw.slice(0, 200)}`))
          return
        }
        try {
          const parsed = JSON.parse(raw)
          const content = parsed?.choices?.[0]?.message?.content
          if (typeof content === 'string' && content.trim()) resolve(content)
          else reject(new Error('empty provider response'))
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('provider timeout')) })
    req.write(body)
    req.end()
  })
}

function designParseOps(text) {
  const cleaned = String(text ?? '')
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    return Array.isArray(parsed?.ops) ? parsed.ops : null
  } catch {
    return null
  }
}

async function handleDesign(req, res, url, cors) {
  const send = (status, body) => {
    res.writeHead(status, { ...cors, 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }

  if (req.method === 'GET' && url.pathname === '/design/docs') {
    designEnsureMain()
    send(200, { ok: true, docs: designList() })
    return
  }

  if (req.method === 'GET' && url.pathname === '/design/models') {
    const catalog = designModelCatalog()
    const models = []
    for (const provider of ['freepi', 'freebuff']) {
      for (const entry of catalog[provider]) models.push({ provider, id: entry.id, name: entry.name })
    }
    send(200, { ok: true, models })
    return
  }

  if (req.method === 'GET' && url.pathname === '/design/state') {
    const result = designRead(url.searchParams.get('id') ?? 'main')
    if (result.error) send(result.error === 'not-found' ? 404 : 400, { ok: false, error: result.error })
    else send(200, result.doc)
    return
  }

  if (req.method === 'POST' && url.pathname === '/design/state') {
    let body
    try {
      body = JSON.parse(await readBody(req, DESIGN_MAX_BYTES + 1024))
    } catch {
      send(400, { ok: false, error: 'invalid-body' })
      return
    }
    if (!body || typeof body !== 'object') {
      send(400, { ok: false, error: 'invalid-body' })
      return
    }
    const result = designWrite(body.id ?? 'main', body.doc ?? body)
    if (result.error) {
      const status = result.error === 'not-found' ? 404 : result.error === 'too-large' ? 413 : 400
      send(status, { ok: false, error: result.error, detail: result.detail })
      return
    }
    log('info', 'design:save', { id: body.id ?? 'main', nodes: result.doc.nodes.length })
    send(200, { ok: true, savedAt: new Date().toISOString() })
    return
  }

  if (req.method === 'POST' && url.pathname === '/design/docs') {
    let body
    try { body = JSON.parse(await readBody(req, 64 * 1024)) } catch {
      send(400, { ok: false, error: 'invalid-body' })
      return
    }
    if (!body || typeof body !== 'object') {
      send(400, { ok: false, error: 'invalid-body' })
      return
    }
    if (body.op === 'create') {
      const ops = require('./design/ops.cjs')
      const idValue = String(body.id ?? `doc-${Date.now().toString(36)}`).replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'doc'
      const written = designWrite(idValue, ops.emptyDoc(idValue, body.name))
      if (written.error) { send(400, { ok: false, error: written.error }); return }
      send(200, { ok: true, docs: designList() })
      return
    }
    if (body.op === 'rename') {
      const result = designRead(body.id)
      if (result.error) { send(result.error === 'not-found' ? 404 : 400, { ok: false, error: result.error }); return }
      result.doc.name = String(body.name ?? result.doc.name).slice(0, 120)
      designWrite(result.doc.id, result.doc)
      send(200, { ok: true, docs: designList() })
      return
    }
    if (body.op === 'delete') {
      const paths = designPaths(body.id)
      if (!paths) { send(400, { ok: false, error: 'invalid-id' }); return }
      try { fs.rmSync(paths.file, { force: true }) } catch { /* ignore */ }
      designEnsureMain()
      send(200, { ok: true, docs: designList() })
      return
    }
    send(400, { ok: false, error: 'invalid-body' })
    return
  }

  if (req.method === 'POST' && url.pathname === '/design/ai') {
    let body
    try { body = JSON.parse(await readBody(req, 1024 * 1024)) } catch {
      send(400, { ok: false, error: 'invalid-body' })
      return
    }
    if (!body || typeof body !== 'object' || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      send(400, { ok: false, error: 'invalid-body' })
      return
    }
    const catalog = designModelCatalog()
    const requested = typeof body.provider === 'string' && catalog[body.provider] ? body.provider : null
    const provider = requested && catalog[requested].some((entry) => entry.id === body.model || entry.name === body.model)
      ? requested
      : designFindProvider(body.model, catalog)
    if (!provider) {
      log('warn', 'design:ai', { model: body.model ?? null, error: 'no-model' })
      send(400, { ok: false, error: 'no-model' })
      return
    }
    try {
      const content = await designCallModel({
        port: activePort,
        provider,
        model: body.model,
        prompt: body.prompt,
      })
      const opsList = designParseOps(content)
      if (!opsList) {
        log('warn', 'design:ai', { model: body.model, provider, prompt: body.prompt.length, rejected: 1 })
        send(200, { ok: true, text: content.slice(0, 400), ops: [], rejected: [{ index: 0, reason: 'unparsable-response' }] })
        return
      }
      const ops = require('./design/ops.cjs')
      const applied = ops.applyOps(body.doc ?? ops.emptyDoc(), opsList)
      log('info', 'design:ai', {
        model: body.model,
        provider,
        prompt: body.prompt.length,
        ops: applied.accepted.length,
        rejected: applied.rejected.length,
      })
      send(200, {
        ok: true,
        text: content.slice(0, 400),
        ops: applied.accepted,
        rejected: applied.rejected,
      })
    } catch (error) {
      log('error', 'design:ai', { model: body.model, provider, error: String(error?.message ?? error) })
      send(400, { ok: false, error: 'provider-error', detail: String(error?.message ?? error) })
    }
    return
  }

  send(404, { ok: false, error: 'not-found' })
}
function start(options = {}) {
  if (typeof options.systemHome === 'string' && options.systemHome !== '') process.env.ANDREY_SYSTEM_HOME = options.systemHome
  if (typeof options.dataRoot === 'string' && options.dataRoot !== '') process.env.ANDREY_DATA_ROOT = options.dataRoot

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')

    // The renderer lives on `dsh-app://app/`, so every non-OpenAI endpoint we
    // serve for our own UI has to be readable cross-origin.
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store',
    }

    // freePi goes through its own translator: the profile names this route, so
    // the active account is resolved per request and the server's one-request
    // and session gates are handled here instead of ending a turn.
    if (url.pathname.startsWith('/freepi/')) {
      require('./freepi-route.cjs').handle(req, res, { url, dataRoot: dataRoot(), log }).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }))
        }
      })
      return
    }

    if (url.pathname.startsWith('/design/')) {
      handleDesign(req, res, url, cors).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500, { ...cors, 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'internal', detail: String(error?.message ?? error) }))
        }
      })
      return
    }

    if (req.method === 'OPTIONS' && (url.pathname.startsWith('/accounts') || url.pathname.startsWith('/ads'))) {
      res.writeHead(204, cors)
      res.end()
      return
    }

    // freePi's free tier is paid for by ads that are actually displayed. The
    // chat itself goes straight to api.freepi.ai, so the view has to be served
    // here: the renderer asks for a creative and reports a measured view.
    if (url.pathname === '/ads/next' || url.pathname === '/ads/impression') {
      const { createStore } = require('./accounts.cjs')
      const ads = require('./ads.cjs')
      const send = (status, payload) => {
        res.writeHead(status, { ...cors, 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      const piToken = () => {
        const store = createStore({ dataRoot: dataRoot() })
        return store.piToken(store.profiles.context('pi'))
      }

      if (url.pathname === '/ads/next' && req.method === 'GET') {
        const token = piToken()
        if (!token) {
          send(200, { ok: false, error: 'login-required', ad: null })
          return
        }
        ads.fetchAd({
          token,
          slot: url.searchParams.get('slot') ?? 'banner',
          trigger: url.searchParams.get('trigger') ?? undefined,
        })
          .then((result) => {
            if (!result.ok) log('warn', 'ads:next-failed', { error: result.error })
            send(200, { ok: result.ok, ad: result.ad ?? null, ...(result.error ? { error: result.error } : {}) })
          })
          .catch((error) => send(500, { ok: false, error: String(error?.message ?? error), ad: null }))
        return
      }

      if (url.pathname === '/ads/impression' && req.method === 'POST') {
        readBody(req, 64 * 1024).then(async (body) => {
          let input = {}
          try {
            input = JSON.parse(body || '{}')
          } catch {
            send(400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const token = piToken()
          const result = await ads.postImpression({
            token,
            viewable: true,
            ad: { ad_id: input.ad_id, click_token: input.click_token, source: input.source, imp_url: input.imp_url },
          })
          if (!result.ok) log('warn', 'ads:impression-failed', { error: result.error })
          send(200, { ok: result.ok, ...(result.error ? { error: result.error } : {}) })
        }).catch((error) => send(500, { ok: false, error: String(error?.message ?? error) }))
        return
      }

      send(404, { ok: false, error: 'not found' })
      return
    }

    if (url.pathname.startsWith('/accounts')) {
      const { createStore } = require('./accounts.cjs')
      const api = require('./accounts-api.cjs')
      const store = () => createStore({ dataRoot: dataRoot() })
      const send = (status, payload) => {
        res.writeHead(status, { ...cors, 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      const fail = (error) => send(500, { ok: false, error: String(error?.message ?? error) })

      if (req.method === 'GET' && url.pathname === '/accounts') {
        try {
          send(200, api.listAccounts({ store: store() }))
        } catch (error) {
          fail(error)
        }
        return
      }

      if (req.method === 'POST') {
        readBody(req, 64 * 1024).then(async (body) => {
          let input = {}
          try {
            input = JSON.parse(body || '{}')
          } catch {
            send(400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const provider = input.provider === 'pi' ? 'pi' : input.provider === 'freebuff' ? 'freebuff' : null
          if (provider === null) {
            send(400, { ok: false, error: 'provider must be pi or freebuff' })
            return
          }
          try {
            if (url.pathname === '/accounts/add') {
              send(200, await api.addAccount({
                provider,
                label: typeof input.label === 'string' ? input.label : undefined,
                store: store(),
                dataRoot: dataRoot(),
                log,
              }))
              return
            }
            if (url.pathname === '/accounts/login') {
              send(200, await api.startLogin({
                provider,
                accountId: String(input.id ?? ''),
                store: store(),
                dataRoot: dataRoot(),
                log,
              }))
              return
            }
            if (url.pathname === '/accounts/switch') {
              send(200, await api.switchAccount({
                provider,
                accountId: String(input.id ?? ''),
                store: store(),
                dataRoot: dataRoot(),
                log,
              }))
              return
            }
            if (url.pathname === '/accounts/remove') {
              send(200, api.removeAccount({ provider, accountId: String(input.id ?? ''), store: store() }))
              return
            }
            send(404, { ok: false, error: 'not found' })
          } catch (error) {
            fail(error)
          }
        }).catch((error) => fail(error))
        return
      }

      send(404, { ok: false, error: 'not found' })
      return
    }

    if (url.pathname === '/limits') {
      const { collectLimits } = require('./limits.cjs')
      const { createStore } = require('./accounts.cjs')
      collectLimits({ store: createStore({ dataRoot: dataRoot() }) })
        .then((payload) => {
          res.writeHead(200, {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(payload))
        })
        .catch((error) => {
          res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
          res.end(JSON.stringify({ error: String(error?.message ?? error) }))
        })
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const force = url.searchParams.get('refresh') === '1'
      const serve = (names) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list',
          data: names.map((name) => ({ id: name, object: 'model', owned_by: 'freebuff' })),
        }))
      }
      if (!force && modelCache.length > 0) {
        serve(modelCache)
        return
      }
      listModels().then(serve).catch((error) => {
        log('error', 'freebuff:models-failed', { message: String(error?.message ?? error) })
        serve(modelCache)
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      readBody(req).then((body) => handleChat(res, body)).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }))
        }
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
  })

  const wanted = Number(options.port) || PORT
  return new Promise((resolve, reject) => {
    const listen = (port, attemptsLeft) => {
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE' && attemptsLeft > 0) listen(port + 1, attemptsLeft - 1)
        else reject(error)
      })
      server.listen(port, '127.0.0.1', () => {
        activePort = server.address().port
        log('info', 'freebuff:listening', { port })
        resolve({ port, base: `http://127.0.0.1:${port}`, close: () => session_close(server) })
      })
    }
    listen(wanted, 10)
  })
}

function session_close(server) {
  server.close()
}

module.exports = { start, listModels, messagesToPrompt, sanitizeForPaste, makeKillCli, readBody, createAccountQueue, PORT }
