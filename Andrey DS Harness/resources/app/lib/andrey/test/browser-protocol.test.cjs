'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { METHODS, ERROR_CODES, validateParams } = require('../browser/protocol.cjs')

test('a valid call passes and unknown keys are dropped', () => {
  const result = validateParams('page.click', { ref: '3', junk: true, tabId: null })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { ref: '3' })
})

test('an unknown method and a wrong type are rejected', () => {
  assert.equal(validateParams('page.nope', {}).error.code, ERROR_CODES.BAD_PARAMS)
  assert.equal(validateParams('tabs.close', { tabId: '7' }).error.code, ERROR_CODES.BAD_PARAMS)
  assert.equal(validateParams('page.type', {}).error.code, ERROR_CODES.BAD_PARAMS)
})

test('page.click takes a ref or a selector, not both', () => {
  assert.equal(validateParams('page.click', { selector: '#go' }).ok, true)
  assert.equal(validateParams('page.click', { ref: '1', selector: '#go' }).ok, false)
  assert.equal(validateParams('page.click', {}).ok, false)
})

test('page.upload takes an array of strings', () => {
  assert.equal(validateParams('page.upload', { ref: '2', paths: ['C:/a.txt'] }).ok, true)
  assert.equal(validateParams('page.upload', { ref: '2', paths: 'C:/a.txt' }).ok, false)
  assert.equal(validateParams('page.upload', { ref: '2', paths: [1] }).ok, false)
})

test('every schema declares required keys that it also describes', () => {
  for (const [name, spec] of Object.entries(METHODS)) {
    for (const key of spec.required) assert.ok(key in spec.params, name + '.' + key)
  }
})
