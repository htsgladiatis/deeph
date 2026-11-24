'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { openState } = require('../browser/state.cjs')
const { createBridge } = require('../browser/bridge.cjs')
const { runtimeRequire } = require('../pi-profile.cjs')

const WebSocket = runtimeRequire('ws')

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrey-bridge-'))
  return { state: openState({ dir }), logger: { info() {}, warn() {}, error() {} } }
}

async function connect(bridge, hello) {
  const ws = new WebSocket('ws://127.0.0.1:' + bridge.port + '/ext')
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  ws.send(JSON.stringify(hello))
  const first = await new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(String(raw)))))
  return { ws, first }
}

const answer = (ws, id, data) => ws.send(JSON.stringify({ type: 'res', id, ok: true, data }))

test('the pair code exchanges for a token, then the token connects', async () => {
  const { state } = setup()
  const bridge = createBridge({ state })
  await bridge.start()
  try {
    const first = await connect(bridge, { type: 'hello', code: state.pairCode, ext: { version: '0.1.0' } })
    assert.equal(first.first.ok, true)
    assert.equal(first.first.token, state.token)
    first.ws.close()

    const second = await connect(bridge, { type: 'hello', token: state.token })
    assert.equal(second.first.ok, true)
    second.ws.close()
  } finally {
    await bridge.stop()
  }
})

test('a wrong token closes the socket', async () => {
  const { state } = setup()
  const bridge = createBridge({ state })
  await bridge.start()
  try {
    const ws = new WebSocket('ws://127.0.0.1:' + bridge.port + '/ext')
    await new Promise((resolve) => ws.once('open', resolve))
    ws.send(JSON.stringify({ type: 'hello', token: 'x'.repeat(64) }))
    const code = await new Promise((resolve) => ws.once('close', (value) => resolve(value)))
    assert.equal(code, 4401)
  } finally {
    await bridge.stop()
  }
})

test('a call without an extension fails with NOT_CONNECTED', async () => {
  const { state } = setup()
  const bridge = createBridge({ state })
  await bridge.start()
  try {
    await assert.rejects(bridge.call('tabs.list', {}), (error) => error.code === 'NOT_CONNECTED')
  } finally {
    await bridge.stop()
  }
})

test('a call is forwarded to the extension and its data returned', async () => {
  const { state } = setup()
  const bridge = createBridge({ state })
  await bridge.start()
  try {
    const { ws } = await connect(bridge, { type: 'hello', code: state.pairCode })
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (message.type === 'req' && message.method === 'tabs.list') {
        answer(ws, message.id, { tabs: [{ tabId: 1, url: 'https://a.test' }], currentTabId: 1 })
      }
    })
    const data = await bridge.call('tabs.list', {})
    assert.equal(data.tabs[0].tabId, 1)
    ws.close()
  } finally {
    await bridge.stop()
  }
})

test('a high-risk action asks for confirmation and honours a denial', async () => {
  const { state } = setup()
  const bridge = createBridge({ state })
  await bridge.start()
  try {
    const { ws } = await connect(bridge, { type: 'hello', code: state.pairCode })
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (message.type === 'req' && message.method === 'page.describe') {
        answer(ws, message.id, { url: 'https://shop.test', role: 'button', name: 'Оплатить', tag: 'button' })
      }
      if (message.type === 'req' && message.method === 'page.click') {
        answer(ws, message.id, { url: 'https://shop.test', clicked: { ref: '1' } })
      }
      if (message.type === 'event' && message.event === 'confirm.request') {
        ws.send(JSON.stringify({ type: 'event', event: 'confirm.answer', data: { id: message.data.id, allow: false } }))
      }
    })
    await assert.rejects(bridge.call('page.click', { ref: '1' }, { timeoutMs: 5000 }), (error) => error.code === 'NEEDS_CONFIRM')
    assert.equal(state.readAudit(10).at(-1).decision, 'denied')
    ws.close()
  } finally {
    await bridge.stop()
  }
})

test('a confirmed high-risk action runs and is audited as confirmed', async () => {
  const { state } = setup()
  const bridge = createBridge({ state })
  await bridge.start()
  try {
    const { ws } = await connect(bridge, { type: 'hello', code: state.pairCode })
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (message.type === 'req' && message.method === 'page.describe') {
        answer(ws, message.id, { url: 'https://shop.test', role: 'button', name: 'Оплатить', tag: 'button' })
      }
      if (message.type === 'req' && message.method === 'page.click') {
        answer(ws, message.id, { url: 'https://shop.test', clicked: { ref: '1' } })
      }
      if (message.type === 'event' && message.event === 'confirm.request') {
        ws.send(JSON.stringify({ type: 'event', event: 'confirm.answer', data: { id: message.data.id, allow: true } }))
      }
    })
    const data = await bridge.call('page.click', { ref: '1' }, { timeoutMs: 5000 })
    assert.equal(data.clicked.ref, '1')
    assert.equal(state.readAudit(10).at(-1).decision, 'confirmed')
    ws.close()
  } finally {
    await bridge.stop()
  }
})

test('a blocked origin is refused and audited', async () => {
  const { state } = setup()
  state.setPermission('https://evil.test', 'block')
  const bridge = createBridge({ state })
  await bridge.start()
  try {
    const { ws } = await connect(bridge, { type: 'hello', code: state.pairCode })
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (message.type === 'req' && message.method === 'page.describe') {
        answer(ws, message.id, { url: 'https://evil.test/x', role: 'button', name: 'Send', tag: 'button' })
      }
    })
    await assert.rejects(bridge.call('page.click', { ref: '1' }), (error) => error.code === 'BLOCKED_SITE')
    assert.equal(state.readAudit(10).at(-1).decision, 'blocked')
    ws.close()
  } finally {
    await bridge.stop()
  }
})

test('paused blocks calls until the user resumes', async () => {
  const { state } = setup()
  const bridge = createBridge({ state })
  await bridge.start()
  try {
    state.paused.set(true)
    await assert.rejects(bridge.call('tabs.list', {}), (error) => error.code === 'PAUSED')
    const stopped = await bridge.call('agent.stop', {})
    assert.equal(stopped.paused, true)
  } finally {
    await bridge.stop()
  }
})

test('a new extension replaces the old one', async () => {
  const { state } = setup()
  const bridge = createBridge({ state })
  await bridge.start()
  try {
    const first = await connect(bridge, { type: 'hello', token: state.token })
    const replaced = new Promise((resolve) => first.ws.once('message', (raw) => resolve(JSON.parse(String(raw)))))
    const second = await connect(bridge, { type: 'hello', token: state.token })
    assert.equal(second.first.ok, true)
    assert.equal((await replaced).event, 'replaced')
    first.ws.close()
    second.ws.close()
  } finally {
    await bridge.stop()
  }
})
