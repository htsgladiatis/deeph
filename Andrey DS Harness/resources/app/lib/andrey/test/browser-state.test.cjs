'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { openState, originOf } = require('../browser/state.cjs')

function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrey-browser-'))
  return { dir, state: openState({ dir }) }
}

test('the token and the pair code are created once and survive a restart', () => {
  const { dir, state } = tempState()
  const { token, pairCode } = state
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.match(pairCode, /^[0-9]{6}$/)

  const again = openState({ dir })
  assert.equal(again.token, token)
  assert.equal(again.pairCode, pairCode)
  assert.equal(again.verifyPairCode(pairCode), token)
  assert.equal(again.verifyPairCode('000000'), null)
})

test('the state file is written with owner-only permissions', () => {
  const { state } = tempState()
  const mode = fs.statSync(state.file).mode & 0o777
  if (process.platform !== 'win32') assert.equal(mode, 0o600)
  assert.equal(JSON.parse(fs.readFileSync(state.file, 'utf8')).token, state.token)
})

test('origins are normalized and permissions persist', () => {
  const { state } = tempState()
  assert.equal(originOf('https://Example.com/inbox?x=1'), 'https://example.com')
  assert.equal(originOf('file:///C:/Windows'), null)
  assert.equal(originOf('nonsense'), null)

  state.setPermission('https://Example.com/inbox?x=1', 'allow')
  assert.deepEqual(state.getPermission('https://example.com/other'), { mode: 'allow' })
  assert.deepEqual(state.getPermission('https://unknown.test/'), { mode: 'ask' })
  assert.throws(() => state.setPermission('https://x.test/', 'yolo'), /mode/)
  assert.throws(() => state.setPermission('file:///C:/x', 'allow'), /http/)
  assert.deepEqual(state.listPermissions(), [{ origin: 'https://example.com', mode: 'allow' }])

  state.clearPermission('https://example.com/whatever')
  assert.deepEqual(state.getPermission('https://example.com/'), { mode: 'ask' })
})

test('the audit trail is capped and masks sensitive text', () => {
  const { state } = tempState()
  state.audit({ method: 'page.type', origin: 'https://a.test', risk: 'high', decision: 'confirmed', text: 'hunter2', sensitive: true })
  const rows = state.readAudit(10)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].text, '***')
  assert.equal(rows[0].method, 'page.type')
  assert.ok(Date.parse(rows[0].ts) > 0)

  for (let i = 0; i < 2100; i += 1) state.audit({ method: 'page.snapshot', origin: 'https://a.test' })
  assert.ok(state.readAudit(5000).length <= 2000)
})

test('the pause flag survives a restart', () => {
  const { dir, state } = tempState()
  state.paused.set(true)
  assert.equal(openState({ dir }).paused.get(), true)
})

test('a corrupt state file is rebuilt instead of crashing the server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrey-browser-'))
  fs.writeFileSync(path.join(dir, 'state.json'), '{not json')
  const state = openState({ dir })
  assert.match(state.token, /^[0-9a-f]{64}$/)
})
