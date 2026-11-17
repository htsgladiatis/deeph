'use strict'

/**
 * One pseudo-terminal running a child process.
 *
 * Deliberately free of Electron imports so it can be unit-tested with a fake
 * spawn implementation: it only needs an object shaped like node-pty's
 * `IPty` ({ pid, write, resize, kill, onData, onExit }).
 */

const { EventEmitter } = require('node:events')

/**
 * @param {object} options
 * @param {string} options.file
 * @param {string[]} options.args
 * @param {string} options.cwd
 * @param {Record<string, string>} [options.env]
 * @param {number} [options.cols]
 * @param {number} [options.rows]
 * @param {(file: string, args: string[], opts: object) => any} options.spawn
 * @param {{ onData?: (chunk: string) => void, onExit?: (event: { code: number|null, signal?: number }) => void }} [handlers]
 */
function createPtySession(options, handlers = {}) {
  const {
    file,
    args = [],
    cwd,
    env = process.env,
    cols = 100,
    rows = 30,
    spawn,
  } = options

  if (typeof spawn !== 'function') {
    throw new TypeError('createPtySession requires a spawn function')
  }

  const pty = spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
    useConpty: process.platform === 'win32',
  })

  let exited = false
  let dataDisposable
  let exitDisposable

  if (typeof pty.onData === 'function') {
    dataDisposable = pty.onData((chunk) => {
      if (exited) return
      if (typeof handlers.onData === 'function') handlers.onData(chunk)
    })
  } else if (typeof pty.on === 'function') {
    const onData = (chunk) => {
      if (!exited && typeof handlers.onData === 'function') handlers.onData(chunk)
    }
    pty.on('data', onData)
    dataDisposable = { dispose: () => pty.off('data', onData) }
  }

  const handleExit = (event) => {
    if (exited) return
    exited = true
    if (typeof handlers.onExit === 'function') {
      handlers.onExit({ code: event?.exitCode ?? event?.code ?? null, signal: event?.signal })
    }
  }

  if (typeof pty.onExit === 'function') {
    exitDisposable = pty.onExit(handleExit)
  } else if (typeof pty.on === 'function') {
    const onExit = (event) => handleExit(event)
    pty.on('exit', onExit)
    exitDisposable = { dispose: () => pty.off('exit', onExit) }
  }

  const session = {
    id: options.id || null,
    pid: pty.pid ?? null,
    get exited() {
      return exited
    },
    write(data) {
      if (exited) return false
      try {
        pty.write(data)
        return true
      } catch {
        return false
      }
    },
    resize(nextCols, nextRows) {
      if (exited) return false
      try {
        pty.resize(Math.max(1, Math.floor(nextCols)), Math.max(1, Math.floor(nextRows)))
        return true
      } catch {
        return false
      }
    },
    kill(signal) {
      if (exited) return
      // Windows: node-pty's kill() forks conpty_console_list_agent, which fails
      // with "AttachConsole failed" once the child is gone and prints a stack
      // trace from the forked process. Closing the sockets is what actually
      // frees the handles, so on Windows dispose owns the shutdown.
      if (process.platform === 'win32') {
        releaseHandles(pty)
        return
      }
      try {
        pty.kill(signal)
      } catch {
        /* the process may already be gone */
      }
    },
    dispose() {
      exited = true
      try {
        dataDisposable?.dispose?.()
        exitDisposable?.dispose?.()
      } catch {
        /* disposables are best-effort */
      }
      releaseHandles(pty)
    },
  }

  return session
}

/**
 * node-pty's ConPTY backend keeps its in/out sockets open after the child exits,
 * which pins the Node event loop even though the agent is gone. On Windows the
 * public kill() path also fails with "AttachConsole failed" because the console
 * list agent cannot attach to a finished process. Closing the agent's sockets
 * directly is the only reliable release, so do it explicitly and defensively:
 * every member of node-pty's internals is optional here.
 */
function releaseHandles(pty) {
  const agent = pty?._agent
  const closers = agent ? [agent._inSocket, agent._outSocket] : []
  for (const socket of closers) {
    try {
      socket.readable = false
      socket.destroy?.()
    } catch {
      /* socket already gone */
    }
  }
  try {
    agent?._conoutSocketWorker?.dispose?.()
  } catch {
    /* worker already gone */
  }
  try {
    pty._socket?.destroy?.()
  } catch {
    /* socket already gone */
  }
}

/** Real node-pty spawn, loaded lazily so tests never touch the native module. */
function realSpawn(file, args, opts) {
  // eslint-disable-next-line global-require
  const nodePty = require('node-pty')
  return nodePty.spawn(file, args, opts)
}

module.exports = { createPtySession, realSpawn, releaseHandles }
