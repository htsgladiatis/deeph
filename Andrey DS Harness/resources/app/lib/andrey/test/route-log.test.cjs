'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { appendLog } = require('../route-log.cjs')

test('the route log rotates at the size cap and keeps valid JSON lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrey-route-log-'))
  const file = path.join(dir, 'freebuff-route.log')
  for (let i = 0; i < 40; i += 1) appendLog(file, JSON.stringify({ i, pad: 'x'.repeat(200) }), 2_000)

  assert.ok(fs.statSync(file).size <= 2_000, 'the live file stays under the cap')
  assert.ok(fs.existsSync(file + '.1'), 'the previous file survives as .1')
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.ok(lines.length > 0)
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))
})
