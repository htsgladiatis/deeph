'use strict'

/**
 * freePi's ad API, spoken the way free-pi's own client does.
 *
 * The free tier is paid for by ads that are actually displayed, so the server
 * pauses free completions with `403 ads_required` until it sees a view:
 *
 *   GET  /ads/next?slot=banner|inline   → 200 creative, or 204 "no ad"
 *   POST /ads/impression                → only after a real, visible view
 *
 * The route (`freebuff-route.cjs`) exposes both over loopback and the renderer
 * (`ui-renderer.js`) renders the banner and measures it. Nothing in this module
 * can prove a view, so an impression is only ever posted by a caller that has
 * one — see `postImpression`'s contract.
 */

const { arch } = require('node:os')

const BASE_URL = 'https://api.freepi.ai'
const REQUEST_TIMEOUT_MS = 6000

const SLOTS = new Set(['banner', 'inline'])
const TRIGGERS = new Set(['launch', 'user_message', 'turn_end'])

/** Short, bounded text for a creative field; strips control characters. */
function cleanText(value, max = 200) {
  if (typeof value !== 'string') return ''
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function isHttpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/** Only the fields the banner needs, with every string bounded and sanitized. */
function normalizeAd(body) {
  if (!body || typeof body !== 'object') return null
  const adId = typeof body.ad_id === 'string' ? body.ad_id.trim() : ''
  const clickToken = typeof body.click_token === 'string' ? body.click_token.trim() : ''
  const clickUrl = typeof body.click_url === 'string' ? body.click_url.trim() : ''
  const creative = body.creative && typeof body.creative === 'object' ? body.creative : {}
  if (!adId || !clickToken || !isHttpsUrl(clickUrl)) return null

  const headline = cleanText(creative.headline, 120)
  if (!headline) return null

  return {
    ad_id: adId.slice(0, 200),
    click_token: clickToken.slice(0, 500),
    click_url: clickUrl.slice(0, 2000),
    source: body.source === 'gravity' ? 'gravity' : 'own',
    imp_url: isHttpsUrl(body.imp_url) ? body.imp_url.slice(0, 2000) : null,
    creative: {
      headline,
      body: cleanText(creative.body, 240),
      cta: cleanText(creative.cta, 40),
      accent: cleanText(creative.accent, 24),
      brand_name: cleanText(creative.brand_name, 60),
      icon_url: isHttpsUrl(creative.icon_url) ? creative.icon_url.slice(0, 2000) : null,
    },
  }
}

function localeHeaders() {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions()
    return {
      ...(resolved.timeZone ? { 'x-client-timezone': resolved.timeZone } : {}),
      ...(resolved.locale ? { 'x-client-locale': resolved.locale } : {}),
    }
  } catch {
    return {}
  }
}

function headersFor({ token, trigger, clientVersion }) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...(clientVersion ? { 'x-client-version': clientVersion } : {}),
    'x-client-os': process.platform,
    'x-client-arch': arch(),
    ...localeHeaders(),
    ...(TRIGGERS.has(trigger) ? { 'x-ad-trigger': trigger } : {}),
  }
}

/**
 * Ask for the next creative.
 *
 * @returns `{ ok: true, ad }`, `{ ok: true, ad: null }` when the server has
 * nothing to show (204), or `{ ok: false, error }`.
 */
async function fetchAd({ token, slot = 'banner', trigger, clientVersion, fetchImpl = fetch } = {}) {
  if (typeof token !== 'string' || token === '') return { ok: false, error: 'login-required' }
  if (!SLOTS.has(slot)) return { ok: false, error: 'invalid-slot' }
  try {
    const url = new URL('/ads/next', BASE_URL)
    url.searchParams.set('slot', slot)
    const res = await fetchImpl(url, {
      headers: headersFor({ token, trigger, clientVersion }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (res.status === 204) return { ok: true, ad: null }
    if (!res.ok) return { ok: false, error: `http-${res.status}` }
    const body = await res.json().catch(() => null)
    return { ok: true, ad: normalizeAd(body) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * Report a displayed ad.
 *
 * `viewable` is the renderer's own measurement of the rendered banner; this
 * module cannot verify it and must not be called without one.
 */
async function postImpression({ token, ad, viewable, fetchImpl = fetch } = {}) {
  if (typeof token !== 'string' || token === '') return { ok: false, error: 'login-required' }
  if (viewable !== true) return { ok: false, error: 'not-viewable' }
  const adId = typeof ad?.ad_id === 'string' ? ad.ad_id : ''
  const clickToken = typeof ad?.click_token === 'string' ? ad.click_token : ''
  if (!adId || !clickToken) return { ok: false, error: 'invalid-ad' }

  let impFired = false
  if (ad.source === 'gravity' && isHttpsUrl(ad.imp_url)) {
    try {
      Promise.resolve(fetchImpl(ad.imp_url, { method: 'GET', signal: AbortSignal.timeout(3000) })).catch(() => {})
      impFired = true
    } catch {
      /* the pixel is optional */
    }
  }

  try {
    const res = await fetchImpl(new URL('/ads/impression', BASE_URL), {
      method: 'POST',
      headers: headersFor({ token }),
      body: JSON.stringify({ ad_id: adId, click_token: clickToken, ...(impFired ? { imp_fired: true } : {}) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, error: `http-${res.status}` }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

module.exports = { fetchAd, postImpression, normalizeAd, isHttpsUrl, BASE_URL, SLOTS, TRIGGERS }
