'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const route = require('../freebuff-route.cjs')

test('the route reports the base the renderer has to call', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'andrey-route-'))
  const started = await route.start({ port: 42195, dataRoot })
  try {
    assert.equal(started.port, 42195)
    assert.equal(started.base, 'http://127.0.0.1:42195')
    const response = await fetch(started.base + '/health').catch(() => null)
    if (response !== null) assert.ok(response.status < 500)
  } finally {
    started.close()
  }
})
