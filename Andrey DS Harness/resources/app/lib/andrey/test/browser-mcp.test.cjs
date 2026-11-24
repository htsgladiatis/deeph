'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createMcpServer, PROTOCOL_VERSION } = require('../browser/mcp.cjs')

const fakeTools = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Returns its argument.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    async handler(args) {
      if (args.text === 'boom') {
        const error = new Error('kaboom')
        error.code = 'PAUSED'
        throw error
      }
      return { content: [{ type: 'text', text: String(args.text ?? '') }] }
    },
  },
]

test('initialize negotiates the protocol and lists the server', async () => {
  const server = createMcpServer({ tools: fakeTools, name: 'browser', version: '0.1.0' })
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(response.result.protocolVersion, PROTOCOL_VERSION)
  assert.equal(response.result.serverInfo.name, 'browser')
  assert.ok(response.result.capabilities.tools)
})

test('initialize echoes a requested supported version and falls back otherwise', async () => {
  const server = createMcpServer({ tools: fakeTools })
  const older = await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  assert.equal(older.result.protocolVersion, '2024-11-05')
  const junk = await server.handle({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
  assert.equal(junk.result.protocolVersion, PROTOCOL_VERSION)
})

test('tools/list publishes titles and input schemas', async () => {
  const server = createMcpServer({ tools: fakeTools })
  const response = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })
  assert.equal(response.result.tools.length, 1)
  assert.equal(response.result.tools[0].name, 'echo')
  assert.equal(response.result.tools[0].inputSchema.type, 'object')
})

test('tools/call returns content and converts a thrown tool error into isError', async () => {
  const server = createMcpServer({ tools: fakeTools })
  const ok = await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } })
  assert.equal(ok.result.content[0].text, 'hi')
  const bad = await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'echo', arguments: { text: 'boom' } } })
  assert.equal(bad.result.isError, true)
  assert.match(bad.result.content[0].text, /\(PAUSED\)/)
})

test('an unknown tool and an unknown method are protocol errors', async () => {
  const server = createMcpServer({ tools: fakeTools })
  const tool = await server.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope' } })
  assert.equal(tool.error.code, -32601)
  const method = await server.handle({ jsonrpc: '2.0', id: 8, method: 'resources/list', params: {} })
  assert.equal(method.error.code, -32601)
})

test('notifications produce no response and ping answers', async () => {
  const server = createMcpServer({ tools: fakeTools })
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), null)
  const pong = await server.handle({ jsonrpc: '2.0', id: 9, method: 'ping' })
  assert.deepEqual(pong.result, {})
})
