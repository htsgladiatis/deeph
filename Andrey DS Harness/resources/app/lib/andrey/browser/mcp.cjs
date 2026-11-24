'use strict'

/**
 * A minimal MCP server over stdio.
 *
 * The bundled runtime ships no MCP SDK, so this speaks the wire protocol the
 * host expects and nothing else: JSON-RPC 2.0, one object per line, initialize /
 * ping / tools/list / tools/call. Unit-agnostic on purpose - it is fed parsed
 * messages, which keeps the protocol testable without spawning a process.
 */

const PROTOCOL_VERSION = '2025-06-18'
const SUPPORTED_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05'])

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })

function createMcpServer({ tools, name = 'browser', version = '0.1.0', logger = { info() {}, error() {} } }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  function describe() {
    return tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))
  }

  async function callTool(name, args) {
    const tool = byName.get(name)
    if (!tool) return rpcError(null, -32601, 'unknown tool: ' + name)
    try {
      const result = await tool.handler(args && typeof args === 'object' ? args : {})
      return rpcResult(null, result)
    } catch (error) {
      const code = error?.code ? '(' + error.code + ') ' : ''
      logger.error('browser tool ' + name + ' failed: ' + String(error?.message || error))
      return rpcResult(null, { content: [{ type: 'text', text: code + String(error?.message || error) }], isError: true })
    }
  }

  /** Handle one parsed JSON-RPC message; a notification resolves to null. */
  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return rpcError(null, -32600, 'invalid request')
    const id = message.id
    const isNotification = id === undefined || id === null
    const method = String(message.method || '')
    const params = message.params && typeof message.params === 'object' ? message.params : {}

    if (method === 'initialize') {
      const requested = String(params.protocolVersion || '')
      const protocolVersion = SUPPORTED_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name, version },
      })
    }
    if (method === 'ping') return rpcResult(id, {})
    if (method === 'tools/list') return rpcResult(id, { tools: describe() })

    if (method === 'tools/call') {
      const result = await callTool(String(params.name || ''), params.arguments)
      if (result.error) return { ...result, id }
      return { ...result, id }
    }

    if (method.startsWith('notifications/')) return null
    if (isNotification) return null
    logger.error('unknown MCP method: ' + method)
    return rpcError(id, -32601, 'method not found: ' + method)
  }

  return { handle, describe, PROTOCOL_VERSION }
}

module.exports = { createMcpServer, PROTOCOL_VERSION, SUPPORTED_VERSIONS }
