'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { maybeCompressBody, shrinkImagesToLimit, IMAGE_NOTICE } = require('../context-compress.cjs')

const imageUrl = (bytes) => `data:image/png;base64,${'A'.repeat(bytes)}`

function requestWith(images) {
  return {
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: [{ type: 'text', text: 'look at these' }, ...images] },
    ],
  }
}

test('a body inside the byte limit is forwarded unchanged', () => {
  const raw = Buffer.from(JSON.stringify(requestWith([{ type: 'image_url', image_url: { url: imageUrl(1000) } }])))
  const result = maybeCompressBody(raw)
  assert.equal(result.changed, false)
  assert.equal(result.buffer, raw)
  assert.equal(result.imagesDropped, 0)
})

test('the oldest image is dropped until the body fits the cap', () => {
  const raw = Buffer.from(JSON.stringify(requestWith([
    { type: 'image_url', image_url: { url: imageUrl(400_000) } },
    { type: 'image_url', image_url: { url: imageUrl(400_000) } },
  ])))

  const result = maybeCompressBody(raw, { maxBodyBytes: 500_000 })
  assert.equal(result.changed, true)
  assert.equal(result.imagesDropped, 1)
  assert.ok(result.buffer.length <= 500_000)

  const body = JSON.parse(result.buffer.toString('utf8'))
  const blocks = body.messages[1].content
  assert.deepEqual(blocks[1], { type: 'text', text: IMAGE_NOTICE })
  assert.equal(typeof blocks[2].image_url.url, 'string')
})

test('both image_url shapes and bare data payloads are recognised', () => {
  const body = requestWith([
    { type: 'input_image', image_url: imageUrl(300_000) },
    { type: 'image', source: { type: 'base64', data: 'B'.repeat(300_000) } },
    { type: 'image', data: 'C'.repeat(300_000) },
  ])
  const result = shrinkImagesToLimit(body, 400_000)
  assert.equal(result.changed, true)
  assert.equal(result.droppedImages, 2)
  assert.ok(result.bytesAfter <= 400_000)
})

test('a body with no images is left to the token budget', () => {
  const body = { messages: [{ role: 'user', content: 'x'.repeat(2000) }] }
  const result = shrinkImagesToLimit(body, 100_000)
  assert.equal(result.changed, false)
  assert.equal(result.droppedImages, 0)
  assert.equal(result.bytesAfter, result.bytesBefore)
})
