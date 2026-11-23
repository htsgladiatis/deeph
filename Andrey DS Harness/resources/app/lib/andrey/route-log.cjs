'use strict'

/**
 * Append one JSON line to the route log, rotating it once it outgrows a cap.
 *
 * The route writes a line per request, per retry and per failed CLI screen, and
 * it appends synchronously on the request path. Left alone the file grows for
 * months and every run pays for a bigger write; keeping the live file under a
 * cap plus one previous file is enough history to diagnose a run.
 */

const fs = require('node:fs')

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

/** @returns {boolean} whether the line was written. */
function appendLog(file, line, maxBytes = DEFAULT_MAX_BYTES) {
  const text = line.endsWith('\n') ? line : line + '\n'
  try {
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      /* no log yet */
    }
    if (maxBytes > 0 && size > 0 && size + text.length > maxBytes) {
      try {
        fs.rmSync(file + '.1', { force: true })
        fs.renameSync(file, file + '.1')
      } catch {
        /* rotation is best effort: a locked file must not lose the line */
      }
    }
    fs.appendFileSync(file, text)
    return true
  } catch {
    return false
  }
}

module.exports = { appendLog, DEFAULT_MAX_BYTES }
