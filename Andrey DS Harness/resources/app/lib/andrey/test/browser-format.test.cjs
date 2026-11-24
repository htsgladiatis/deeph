'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { formatSnapshot, formatExtract } = require('../browser/format.cjs')

test('a snapshot prints the url, the title and the elements with refs', () => {
  const { text } = formatSnapshot({
    url: 'https://a.test',
    title: 'A',
    nodes: [
      { ref: '1', role: 'link', name: 'Каталог', x: 10, y: 20, w: 100, h: 24 },
      { ref: '2', role: 'textbox', name: 'Email', value: 'a@b.c', x: 10, y: 60, w: 200, h: 32 },
    ],
  })
  assert.match(text, /URL: https:\/\/a\.test/)
  assert.match(text, /\[1\] link "Каталог" @\(10,20\) 100x24/)
  assert.match(text, /\[2\] textbox "Email" = "a@b\.c"/)
})

test('passwords and long values are masked', () => {
  const { text } = formatSnapshot({
    url: 'https://a.test',
    title: 'A',
    nodes: [
      { ref: '1', role: 'textbox', name: 'Пароль', value: 'hunter2', type: 'password', x: 0, y: 0, w: 1, h: 1 },
      { ref: '2', role: 'textbox', name: 'Комментарий', value: 'x'.repeat(200), x: 0, y: 0, w: 1, h: 1 },
    ],
  })
  assert.doesNotMatch(text, /hunter2/)
  assert.match(text, /••••/)
  assert.match(text, /…/)
})

test('maxChars truncates and flags it', () => {
  const nodes = Array.from({ length: 500 }, (_, index) => ({ ref: String(index + 1), role: 'link', name: 'ссылка ' + index, x: index, y: index, w: 1, h: 1 }))
  const out = formatSnapshot({ url: 'https://a.test', title: 'A', nodes, maxChars: 500 })
  assert.equal(out.truncated, true)
  assert.ok(out.text.length <= 700)
  assert.match(out.text, /truncated/)
})

test('extract appends links for the links format', () => {
  const out = formatExtract({ url: 'https://a.test', format: 'links', text: 'x', links: [{ text: 'A', href: 'https://a.test/1' }] })
  assert.match(out.text, /https:\/\/a\.test\/1/)
  const plain = formatExtract({ url: 'https://a.test', format: 'text', text: 'hello' })
  assert.doesNotMatch(plain.text, /Links:/)
})
