'use strict'

/**
 * The local llama.cpp server behind the profile's `local-lmstudio` route.
 *
 * The server runs in router mode: one process holds a preset table of models
 * and loads the one a request names, unloading the previous model when the
 * window (or the GPU) would not hold both. So picking another local model in
 * the harness picker "just works" — the first request pays the load, later ones
 * are already warm.
 *
 * It lives exactly as long as the host: `start()` spawns it while the app boots
 * and `stop()` kills the whole process tree on quit, children included, so
 * closing the harness never leaves a 2-3 GB model server behind. A crash of the
 * host can still orphan it, so the pid is written to disk and the next start
 * kills that stale tree before spawning a fresh one.
 *
 * ANDREY_LOCAL_LLAMA_DISABLED=1 keeps the profile route down without touching
 * the app.
 */

const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PORT = 1234
const HOME = os.homedir()
const BACKEND = path.join(HOME, '.lmstudio', 'extensions', 'backends', 'llama.cpp-win-x86_64-nvidia-cuda12-avx2-2.80.1')
const VENDOR = path.join(HOME, '.lmstudio', 'extensions', 'backends', 'vendor', 'win-llama-cuda12-vendor-v2')
const STATE = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-local-llm')
const CONTEXT = '40960'

/** Preset table: section name is the model id the harness sends. */
const MODELS = [
  {
    id: 'huihui-qwen3.5-2b-abliterated',
    model: path.join(HOME, '.lmstudio', 'models', 'mradermacher', 'Huihui-Qwen3.5-2B-abliterated-GGUF', 'Huihui-Qwen3.5-2B-abliterated.Q5_K_S.gguf'),
    mmproj: path.join(HOME, '.lmstudio', 'models', 'mradermacher', 'Huihui-Qwen3.5-2B-abliterated-GGUF', 'Huihui-Qwen3.5-2B-abliterated.mmproj-f16.gguf'),
  },
  {
    id: 'huihui-qwen3.5-4b-abliterated',
    model: path.join(HOME, '.lmstudio', 'models', 'mradermacher', 'Huihui-Qwen3.5-4B-abliterated-GGUF', 'Huihui-Qwen3.5-4B-abliterated.IQ4_XS.gguf'),
    mmproj: path.join(HOME, '.lmstudio', 'models', 'mradermacher', 'Huihui-Qwen3.5-4B-abliterated-GGUF', 'Huihui-Qwen3.5-4B-abliterated.mmproj-f16.gguf'),
  },
  {
    id: 'lfm3-omni-2b-abliterated-heretic-v2-i1',
    model: path.join(HOME, '.lmstudio', 'models', 'mradermacher', 'lfm3-omni-2b-abliterated-heretic-v2-i1-GGUF', 'lfm3-omni-2b-abliterated-heretic-v2.i1-Q6_K.gguf'),
    mmproj: '',
  },
]

let child = null
const noop = () => {}
const ensureState = () => fs.mkdirSync(STATE, { recursive: true })
const pidPath = () => path.join(STATE, 'server.pid')
const logPath = () => path.join(STATE, 'server.log')
const iniPath = () => path.join(STATE, 'models.ini')

/** The preset file the router reads; one section per model. */
function presetTable() {
  return MODELS.map((entry) => {
    const lines = ['[' + entry.id + ']', 'model = ' + entry.model]
    if (entry.mmproj !== '') lines.push('mmproj = ' + entry.mmproj)
    lines.push('ctx-size = ' + CONTEXT, 'parallel = 1', 'n-gpu-layers = 999', 'jinja = true')
    // The 2B burns its whole answer on reasoning; these routes are plain chat
    // and agent models, so thinking stays off.
    lines.push('chat-template-kwargs = {"enable_thinking":false}')
    return lines.join('\n')
  }).join('\n\n') + '\n'
}

/** Whether a pid still exists, without touching its state. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPid() {
  try {
    return Number.parseInt(fs.readFileSync(pidPath(), 'utf8').trim(), 10) || 0
  } catch {
    return 0
  }
}

function forgetPid() {
  try {
    fs.rmSync(pidPath(), { force: true })
  } catch {
    /* nothing to clean */
  }
}

/**
 * Kill a server and the per-model children the router spawned under it.
 * `process.kill` would leave those children orphaned on Windows.
 */
function killTree(pid, log) {
  if (!alive(pid)) return forgetPid()
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    log('local-llama: killed server tree pid ' + pid)
  } catch (error) {
    log('local-llama: kill failed for pid ' + pid + ': ' + String(error?.message ?? error))
  }
  forgetPid()
}

/**
 * Start the router for the app's lifetime.
 * @param log - logger used for the few failures worth reporting.
 * @returns the child process, or null when nothing was started.
 */
function start(log = noop) {
  if (!fs.existsSync(BACKEND)) {
    log('local-llama: backend missing, the route stays down')
    return null
  }
  killTree(readPid(), log)
  ensureState()
  try {
    fs.writeFileSync(iniPath(), presetTable())
  } catch (error) {
    log('local-llama: cannot write the preset table: ' + String(error?.message ?? error))
    return null
  }
  const out = fs.openSync(logPath(), 'a')
  const args = [
    '--models-preset', iniPath(),
    '--models-max', '1',
    '--host', '127.0.0.1',
    '--port', String(PORT),
    '--no-webui',
  ]
  try {
    child = spawn(path.join(BACKEND, 'llama-server.exe'), args, {
      cwd: BACKEND,
      windowsHide: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, PATH: VENDOR + ';' + (process.env.PATH ?? '') },
    })
  } catch (error) {
    log('local-llama: spawn failed: ' + String(error?.message ?? error))
    return null
  } finally {
    try {
      fs.closeSync(out)
    } catch {
      /* already closed */
    }
  }
  child.on('error', (error) => log('local-llama: ' + String(error?.message ?? error)))
  child.on('exit', (code) => {
    forgetPid()
    log('local-llama: server exited (' + code + ')')
  })
  child.unref()
  fs.writeFileSync(pidPath(), String(child.pid))
  log('local-llama: router on port ' + PORT + ' with ' + MODELS.length + ' presets (pid ' + child.pid + ')')
  return child
}

/** Kill the router and its model processes; safe to call more than once. */
function stop(log = noop) {
  const pid = child?.pid ?? readPid()
  child = null
  killTree(pid, log)
}

module.exports = { start, stop, PORT }
