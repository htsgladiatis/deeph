'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { makeContext, runIn } = require('./dom-fixture.cjs')
const inject = require('../ui-inject.cjs')

test('a throwing segment does not stop the segments after it', () => {
  const { ctx } = makeContext()
  runIn(ctx, inject.bundle(['throw new Error("segment A exploded")', 'globalThis.__afterThrow = "ran"']), 'bundle.js')
  assert.equal(ctx.__afterThrow, 'ran')
})

test('the bundle carries the live api base, not a hardcoded port', () => {
  const { ctx } = makeContext()
  runIn(ctx, inject.rendererScript({ apiBase: 'http://127.0.0.1:41999' }), 'bundle.js')
  assert.equal(ctx.__ANDREY_API_BASE__, 'http://127.0.0.1:41999')
})

test('the real bundle still assembles', () => {
  assert.ok(inject.rendererScript().length > 100_000)
})
