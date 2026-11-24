'use strict'

/**
 * The contract between the MCP server (bridge) and the browser extension.
 *
 * Every call the model can make crosses this file twice: once when the tool
 * handler validates its arguments, once when the bridge rejects anything the
 * schema does not describe. Whitelists only: a method that is not listed here
 * cannot reach the extension, and a parameter that is not described is dropped
 * before it does.
 */

const PROTOCOL_VERSION = '0.1.0'

const ERROR_CODES = {
  BAD_PARAMS: 'BAD_PARAMS',
  NOT_CONNECTED: 'NOT_CONNECTED',
  NO_SUCH_TAB: 'NO_SUCH_TAB',
  TAB_NOT_OWNED: 'TAB_NOT_OWNED',
  NO_ELEMENT: 'NO_ELEMENT',
  STALE_REF: 'STALE_REF',
  BLOCKED_SITE: 'BLOCKED_SITE',
  NEEDS_CONFIRM: 'NEEDS_CONFIRM',
  PAUSED: 'PAUSED',
  TIMEOUT: 'TIMEOUT',
  EXTENSION_ERROR: 'EXTENSION_ERROR',
}

/** method -> { params: { name: 'string'|'number'|'boolean'|'string[]' }, required: [] } */
const METHODS = {
  status: { params: {}, required: [] },
  'tabs.list': { params: {}, required: [] },
  'tabs.open': { params: { url: 'string', active: 'boolean' }, required: ['url'] },
  'tabs.close': { params: { tabId: 'number' }, required: ['tabId'] },
  'tabs.focus': { params: { tabId: 'number' }, required: ['tabId'] },
  'page.snapshot': { params: { tabId: 'number', interactive: 'boolean', maxChars: 'number' }, required: [] },
  'page.screenshot': { params: { tabId: 'number', fullPage: 'boolean' }, required: [] },
  'page.describe': { params: { tabId: 'number', ref: 'string', selector: 'string' }, required: [] },
  'page.click': { params: { tabId: 'number', ref: 'string', selector: 'string', button: 'string', clickCount: 'number' }, required: [] },
  'page.type': { params: { tabId: 'number', ref: 'string', selector: 'string', text: 'string', submit: 'boolean', clearFirst: 'boolean', human: 'boolean' }, required: ['text'] },
  'page.press': { params: { tabId: 'number', key: 'string', ref: 'string' }, required: ['key'] },
  'page.scroll': { params: { tabId: 'number', deltaY: 'number', toRef: 'string' }, required: [] },
  'page.navigate': { params: { tabId: 'number', url: 'string', timeoutMs: 'number' }, required: ['url'] },
  'page.wait': { params: { tabId: 'number', ms: 'number', until: 'string', timeoutMs: 'number' }, required: [] },
  'page.extract': { params: { tabId: 'number', format: 'string', selector: 'string' }, required: ['format'] },
  'page.upload': { params: { tabId: 'number', ref: 'string', paths: 'string[]' }, required: ['ref', 'paths'] },
  'page.console': { params: { tabId: 'number', limit: 'number' }, required: [] },
  'agent.stop': { params: {}, required: [] },
}

const TARGETED = new Set(['page.click', 'page.describe', 'page.type', 'page.press'])

function typeOk(kind, value) {
  if (kind === 'string[]') return Array.isArray(value) && value.every((item) => typeof item === 'string')
  return typeof value === kind
}

/**
 * Validate one call and return a fresh object with only the described keys.
 * Unknown keys are dropped rather than rejected: models add noise like
 * `tabId: null`, and failing on it would cost a turn without protecting anything.
 */
function validateParams(method, params) {
  const spec = METHODS[method]
  if (!spec) return { ok: false, error: { code: ERROR_CODES.BAD_PARAMS, message: 'unknown method: ' + method } }

  const input = params && typeof params === 'object' && !Array.isArray(params) ? params : {}
  const value = {}
  for (const [key, kind] of Object.entries(spec.params)) {
    if (input[key] === undefined || input[key] === null) continue
    if (!typeOk(kind, input[key])) {
      return { ok: false, error: { code: ERROR_CODES.BAD_PARAMS, message: method + '.' + key + ' expects ' + kind } }
    }
    value[key] = input[key]
  }

  for (const key of spec.required) {
    if (value[key] === undefined) {
      return { ok: false, error: { code: ERROR_CODES.BAD_PARAMS, message: method + ' requires ' + key } }
    }
  }

  if (TARGETED.has(method)) {
    if (value.ref !== undefined && value.selector !== undefined) {
      return { ok: false, error: { code: ERROR_CODES.BAD_PARAMS, message: 'pass either ref or selector, not both' } }
    }
    if (method !== 'page.type' && method !== 'page.press' && value.ref === undefined && value.selector === undefined) {
      return { ok: false, error: { code: ERROR_CODES.BAD_PARAMS, message: 'ref or selector is required' } }
    }
  }

  return { ok: true, value }
}

module.exports = { PROTOCOL_VERSION, ERROR_CODES, METHODS, TARGETED, validateParams }
