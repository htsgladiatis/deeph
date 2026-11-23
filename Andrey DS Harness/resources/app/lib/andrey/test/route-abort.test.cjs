'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

process.env.ANDREY_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'andrey-abort-'))

const route = require('../freebuff-route.cjs')

test('a request that dies mid-body rejects instead of waiting forever', async () => {
  const request = new EventEmitter()
  request.destroyed = false
  const pending = route.readBody(request)
  request.emit('data', Buffer.from('{"prompt":'))

  await new Promise((resolve) => setTimeout(resolve, 30))
  request.emit('aborted')

  await assert.rejects(
    Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('readBody never settled')), 300))]),
    /abort|disconnect|closed/i,
  )
})

test('a queued request leaves the queue when its client disconnects', async () => {
  const queue = route.createAccountQueue()
  let releaseFirst
  const first = queue.run('acct', () => new Promise((resolve) => { releaseFirst = resolve }))
  await new Promise((resolve) => setTimeout(resolve, 20))

  let aborted = false
  let outcome = 'pending'
  const second = queue.run('acct', () => 'second-ran', { timeoutMs: 5000, isAborted: () => aborted })
  second.then((value) => { outcome = 'resolved:' + value }, (error) => { outcome = 'rejected:' + error.message })
  await new Promise((resolve) => setTimeout(resolve, 50))

  aborted = true
  await new Promise((resolve) => setTimeout(resolve, 900))

  releaseFirst('first-done')
  await first.catch(() => {})
  assert.match(outcome, /^rejected/, 'a disconnected waiter must not keep its place for the whole timeout')
})
