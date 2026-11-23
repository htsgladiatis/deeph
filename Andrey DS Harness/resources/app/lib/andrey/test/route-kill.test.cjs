'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

process.env.ANDREY_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'andrey-kill-'))

const route = require('../freebuff-route.cjs')

test('killCli settles only after the child process is gone', async () => {
  let exited = false
  const calls = []
  const fakeExecFile = (file, args, options, done) => {
    calls.push(file)
    setTimeout(() => {
      exited = true
      done(null)
    }, 80)
  }
  const killCli = route.makeKillCli(fakeExecFile)

  let settled = false
  const pending = killCli('C:\\tmp\\scratch').then(() => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(settled, false, 'the slot must not be released while the CLI may still hold its lock')
  await pending
  assert.equal(settled, true)
  assert.equal(exited, true)
  assert.equal(calls.length, 1)
})

test('a failed kill resolves instead of rejecting the run', async () => {
  const killCli = route.makeKillCli((file, args, options, done) => done(new Error('powershell exploded')))
  await assert.doesNotReject(() => killCli('C:\\tmp\\scratch'))
})
