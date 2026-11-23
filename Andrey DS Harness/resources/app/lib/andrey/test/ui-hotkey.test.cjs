'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { makeContext, runIn } = require('./dom-fixture.cjs')
const inject = require('../ui-inject.cjs')

test('Ctrl+Shift+D toggles the design panel exactly once', () => {
  const { ctx, listeners } = makeContext()
  runIn(ctx, inject.rendererScript(), 'ui-bundle.js')

  let toggles = 0
  ctx.AndreyDesign = { toggle: () => { toggles += 1 } }
  const event = {
    ctrlKey: true,
    shiftKey: true,
    key: 'd',
    preventDefault() {},
    stopPropagation() {},
  }
  for (const listener of listeners.filter((entry) => entry.type === 'keydown')) listener.fn(event)

  assert.equal(toggles, 1, 'one shortcut press must toggle once, not twice')
})

test('the shortcut survives a Cyrillic layout (Ctrl+Shift switches it)', () => {
  const { ctx, listeners } = makeContext()
  runIn(ctx, inject.rendererScript(), 'ui-bundle.js')

  let toggles = 0
  ctx.AndreyDesign = { toggle: () => { toggles += 1 } }
  const event = {
    ctrlKey: true,
    shiftKey: true,
    key: 'в',
    code: 'KeyD',
    preventDefault() {},
    stopPropagation() {},
  }
  for (const listener of listeners.filter((entry) => entry.type === 'keydown')) listener.fn(event)
  assert.equal(toggles, 1, 'the physical key, not the layout letter, must decide')
})
