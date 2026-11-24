'use strict'

/**
 * How dangerous is one action, given where it happens and what it targets?
 *
 * The bridge asks this before it forwards anything that changes page or state.
 * The answer decides whether the side panel shows a confirmation: `low` runs,
 * `medium` runs on an explicitly allowed origin, everything else waits for the
 * user. The classifier is deliberately blunt and text-based - it is a net, not a
 * sandbox - but it covers the cases that cost real money: payment fields, bank
 * and wallet origins, destructive buttons, file uploads and non-http URLs.
 */

const HIGH_RISK_ORIGINS = [
  /(^|\.)sber(bank)?\.(ru|com)$/i,
  /(^|\.)tinkoff\.ru$/i,
  /(^|\.)alfabank\.ru$/i,
  /(^|\.)vtb\.ru$/i,
  /(^|\.)gazprombank\.ru$/i,
  /(^|\.)paypal\.com$/i,
  /(^|\.)stripe\.com$/i,
  /(^|\.)binance\.com$/i,
  /(^|\.)coinbase\.com$/i,
  /(^|\.)kraken\.com$/i,
  /(^|\.)gosuslugi\.ru$/i,
  /(^|\.)nalog\.(ru|gov)$/i,
  /(^|\.)bank\./i,
  /(^|\.)chase\.com$/i,
  /(^|\.)wellsfargo\.com$/i,
  /(^|\.)bankofamerica\.com$/i,
]

const PAYMENT_FIELD = /(card|cvv|cvc|iban|expiry|expiration|paypal|wallet|карт[аыу]?|счёт|счет|бик|инн)/i
const SECRET_FIELD = /(password|passwd|пароль|secret|api[ _-]?key|seed|mnemonic|мнемоник|private[ _-]?key|токен)/i
const DESTRUCTIVE = /(удал|delete|remove|оплат|pay\b|купить|buy|перевест|transfer|отправ|send|publish|опубликов|подписа|subscribe|заблокир|block|sign ?out|выйти|очист|reset|confirm order|place order|checkout)/i
const SAFE_SCHEME = /^https?:\/\//i

/** Calls that cannot change the page or the account: always safe to run. */
const READ_ONLY = new Set([
  'status',
  'tabs.list',
  'page.snapshot',
  'page.describe',
  'page.screenshot',
  'page.extract',
  'page.console',
  'page.scroll',
  'page.wait',
])

function hostOf(url) {
  try {
    return new URL(String(url)).hostname
  } catch {
    return ''
  }
}

function isHighRiskOrigin(origin) {
  if (!origin) return false
  const host = hostOf(origin)
  return HIGH_RISK_ORIGINS.some((pattern) => pattern.test(host))
}

function classifyAction({ method, params = {}, target, origin = '', permission = 'ask' }) {
  const reasons = []
  const label = [target?.name, target?.fieldLabel, target?.tag, target?.type].filter(Boolean).join(' ')
  const risksOrigin = isHighRiskOrigin(origin)

  if (READ_ONLY.has(method)) return { level: 'low', reasons: [] }
  if (method === 'page.upload') return { level: 'high', reasons: ['uploading a local file to a page'] }
  if (method === 'page.navigate' && params.url && !SAFE_SCHEME.test(String(params.url))) {
    return { level: 'high', reasons: ['navigation to a non-http(s) URL'] }
  }
  if (risksOrigin) reasons.push('banking or payment site')

  if (method === 'page.navigate') {
    return reasons.length ? { level: 'high', reasons } : { level: 'medium', reasons: ['navigating away from the current page'] }
  }

  if (method === 'page.type') {
    if (PAYMENT_FIELD.test(label) || PAYMENT_FIELD.test(String(target?.type || ''))) reasons.push('payment data field')
    if (SECRET_FIELD.test(label) || String(target?.type || '') === 'password') reasons.push('password or secret field')
    if (reasons.length) return { level: 'high', reasons }
    return { level: 'medium', reasons: ['typing into a form'] }
  }

  if (method === 'page.click' || method === 'page.press') {
    if (DESTRUCTIVE.test(label) || (method === 'page.press' && params.key === 'Enter' && DESTRUCTIVE.test(label))) {
      reasons.push('destructive control: ' + label.trim().slice(0, 80))
    }
  }

  if (reasons.length) return { level: 'high', reasons }
  if (permission !== 'allow') return { level: 'medium', reasons: ['first action on this site'] }
  return { level: 'low', reasons: [] }
}

module.exports = { classifyAction, isHighRiskOrigin, HIGH_RISK_ORIGINS, hostOf }
