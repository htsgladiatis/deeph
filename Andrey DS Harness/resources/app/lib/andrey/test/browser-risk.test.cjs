'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { classifyAction, isHighRiskOrigin } = require('../browser/risk.cjs')

test('reading, scrolling and waiting are low risk', () => {
  assert.equal(classifyAction({ method: 'page.snapshot', params: {}, origin: 'https://example.com' }).level, 'low')
  assert.equal(classifyAction({ method: 'page.scroll', params: { deltaY: 500 }, origin: 'https://example.com' }).level, 'low')
  assert.equal(classifyAction({ method: 'page.wait', params: { ms: 100 }, origin: 'https://example.com' }).level, 'low')
})

test('typing into an ordinary form is medium, payment and password fields are high', () => {
  const email = { role: 'textbox', name: 'Email', tag: 'input', type: 'email', fieldLabel: 'Email' }
  assert.equal(classifyAction({ method: 'page.type', params: { text: 'a@b.c' }, target: email, origin: 'https://shop.test' }).level, 'medium')

  const card = { role: 'textbox', name: 'Card number', tag: 'input', type: 'text', fieldLabel: 'Card number' }
  const cardRisk = classifyAction({ method: 'page.type', params: { text: '4242' }, target: card, origin: 'https://shop.test' })
  assert.equal(cardRisk.level, 'high')
  assert.match(cardRisk.reasons.join(' '), /payment/i)

  const password = { role: 'textbox', name: 'Пароль', tag: 'input', type: 'password' }
  assert.equal(classifyAction({ method: 'page.type', params: { text: 'x' }, target: password, origin: 'https://shop.test' }).level, 'high')
})

test('destructive buttons are high risk', () => {
  for (const label of ['Оплатить', 'Delete account', 'Отправить', 'Subscribe', 'Перевести', 'Checkout']) {
    const result = classifyAction({ method: 'page.click', params: {}, target: { role: 'button', name: label, tag: 'button' }, origin: 'https://shop.test' })
    assert.equal(result.level, 'high', label)
  }
})

test('banking origins, uploads and non-http URLs are high risk', () => {
  assert.equal(isHighRiskOrigin('https://sberbank.ru/login'), true)
  assert.equal(isHighRiskOrigin('https://example.com'), false)
  assert.equal(classifyAction({ method: 'page.click', params: {}, target: { role: 'link', name: 'Вход' }, origin: 'https://sberbank.ru/login' }).level, 'high')
  assert.equal(classifyAction({ method: 'page.upload', params: { paths: ['C:/a.txt'] }, origin: 'https://mail.test' }).level, 'high')
  assert.equal(classifyAction({ method: 'page.navigate', params: { url: 'file:///C:/Windows' }, origin: 'https://x.test' }).level, 'high')
})

test('links on an allowed site are low, the first action on a new site is medium', () => {
  const link = { role: 'link', name: 'Каталог', tag: 'a' }
  assert.equal(classifyAction({ method: 'page.click', params: {}, target: link, origin: 'https://shop.test', permission: 'allow' }).level, 'low')
  assert.equal(classifyAction({ method: 'page.click', params: {}, target: link, origin: 'https://new.test', permission: 'ask' }).level, 'medium')
})
