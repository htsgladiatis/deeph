'use strict'

/**
 * Page actions over the Chrome DevTools Protocol.
 *
 * Everything here goes through `chrome.debugger`, which is the only way an
 * extension can drive the user's ordinary, logged-in Chrome (Chrome 136+
 * ignores --remote-debugging-port for the default profile). Input is dispatched
 * as real CDP input events, not as synthetic `element.click()` calls, so React
 * and other frameworks react the same way they would to a human.
 */

;(function () {
  const attached = new Set()
  const consoleBuffers = new Map()

  class ActionError extends Error {
    constructor(code, message) {
      super(message)
      this.code = code
    }
  }

  function fail(code, message) {
    throw new ActionError(code, message)
  }

  function cdp(tabId, method, params) {
    return chrome.debugger.sendCommand({ tabId }, method, params || {})
  }

  async function attach(tabId) {
    if (attached.has(tabId)) return
    try {
      await chrome.debugger.attach({ tabId }, '1.3')
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      if (!/already attached/i.test(message)) {
        fail('EXTENSION_ERROR', 'cannot attach to the tab: ' + message)
      }
    }
    attached.add(tabId)
    await cdp(tabId, 'Page.enable').catch(() => {})
    await cdp(tabId, 'Runtime.enable').catch(() => {})
    await cdp(tabId, 'DOM.enable').catch(() => {})
  }

  async function detach(tabId) {
    attached.delete(tabId)
    consoleBuffers.delete(tabId)
    await chrome.debugger.detach({ tabId }).catch(() => {})
  }

  async function evaluate(tabId, expression) {
    const result = await cdp(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: false,
    })
    if (result && result.exceptionDetails) {
      const detail = result.exceptionDetails
      const text = detail.exception && detail.exception.description ? detail.exception.description : detail.text
      fail('EXTENSION_ERROR', 'page evaluation failed: ' + String(text || 'unknown error'))
    }
    return result && result.result ? result.result.value : undefined
  }

  /** Resolve ref/selector inside the page, scroll it into view, return its box. */
  async function boxOf(tabId, params) {
    const ref = params && params.ref !== undefined ? String(params.ref) : ''
    const selector = params && typeof params.selector === 'string' ? params.selector : ''
    const lookup =
      ref !== ''
        ? 'var el = (window.__andreyEls || [])[' + (Number(ref) - 1) + ']; if (!el || !el.isConnected) return { ok: false, error: "stale ref ' + ref.replace(/[^0-9]/g, '') + '" };'
        : selector !== ''
          ? 'var el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return { ok: false, error: "no element matches the selector" };'
          : 'return { ok: false, error: "ref or selector is required" };'

    const script =
      '(() => {' +
      lookup +
      'if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(true); else el.scrollIntoView({ block: "center", inline: "center" });' +
      'var r = el.getBoundingClientRect();' +
      'var style = window.getComputedStyle(el);' +
      'return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, visible: style.visibility !== "hidden" && style.display !== "none" };' +
      '})()'

    const box = await evaluate(tabId, script)
    if (!box || !box.ok) fail('NO_ELEMENT', (box && box.error) || 'element not found')
    return box
  }

  const KEY_CODES = {
    Enter: { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r' },
    Escape: { windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' },
    Tab: { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' },
    Backspace: { windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' },
    Delete: { windowsVirtualKeyCode: 46, code: 'Delete', key: 'Delete' },
    ArrowUp: { windowsVirtualKeyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
    ArrowDown: { windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
    ArrowLeft: { windowsVirtualKeyCode: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
    ArrowRight: { windowsVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight' },
    Space: { windowsVirtualKeyCode: 32, code: 'Space', key: ' ' },
    PageUp: { windowsVirtualKeyCode: 33, code: 'PageUp', key: 'PageUp' },
    PageDown: { windowsVirtualKeyCode: 34, code: 'PageDown', key: 'PageDown' },
    Home: { windowsVirtualKeyCode: 36, code: 'Home', key: 'Home' },
    End: { windowsVirtualKeyCode: 35, code: 'End', key: 'End' },
  }

  async function keyEvent(tabId, key) {
    const spec = KEY_CODES[key] || { key, text: key }
    const base = {
      key: spec.key,
      code: spec.code || '',
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
    }
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: spec.text ? 'keyDown' : 'rawKeyDown', ...base, text: spec.text })
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  /**
   * Show the user where the agent is about to act.
   *
   * The whole point of driving the real browser is that the person watches the
   * work; CDP input events move no visible cursor, so a click would otherwise
   * happen off-screen from their point of view. A frame plus a dot, faded out
   * after the action, is the cheapest honest answer.
   */
  async function flash(tabId, params, verb) {
    const ref = params && params.ref !== undefined ? String(params.ref) : ''
    const selector = params && typeof params.selector === 'string' ? params.selector : ''
    if (ref === '' && selector === '') return
    const lookup =
      ref !== ''
        ? 'var el = (window.__andreyEls || [])[' + (Number(ref) - 1) + '];'
        : 'var el = document.querySelector(' + JSON.stringify(selector) + ');'
    const script =
      '(() => {' +
      lookup +
      'if (!el) return false;' +
      'var r = el.getBoundingClientRect();' +
      'var name = (el.innerText || el.getAttribute("aria-label") || el.value || el.getAttribute("placeholder") || el.tagName || "").replace(/\s+/g, " ").trim().slice(0, 40);' +
      'var old = document.getElementById("__andrey_act_box__"); if (old) old.remove();' +
      'var box = document.createElement("div"); box.id = "__andrey_act_box__";' +
      'box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #2b6cf6;border-radius:5px;box-shadow:0 0 0 4px rgba(43,108,246,0.18),0 0 18px rgba(43,108,246,0.35);transition:opacity .4s ease;";' +
      'box.style.left = Math.max(0, r.left - 3) + "px"; box.style.top = Math.max(0, r.top - 3) + "px";' +
      'box.style.width = (r.width + 6) + "px"; box.style.height = (r.height + 6) + "px";' +
      'var dot = document.createElement("div");' +
      'dot.style.cssText = "position:fixed;width:10px;height:10px;border-radius:50%;background:#2b6cf6;box-shadow:0 0 8px rgba(43,108,246,0.6);pointer-events:none;z-index:2147483647;transition:opacity .4s ease;";' +
      'dot.style.left = (r.left + r.width / 2 - 5) + "px"; dot.style.top = (r.top + r.height / 2 - 5) + "px";' +
      'var tag = document.createElement("div"); tag.id = "__andrey_act_tag__";' +
      'tag.textContent = ' + JSON.stringify(verb) + ' + (name ? " · " + name : "");' +
      'tag.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;font:11px/1.3 system-ui,sans-serif;background:#2b6cf6;color:#fff;padding:2px 6px;border-radius:5px;opacity:.95;transition:opacity .4s ease;";' +
      'tag.style.left = Math.max(0, r.left) + "px"; tag.style.top = Math.max(0, r.top - 20) + "px";' +
      'document.documentElement.appendChild(box); document.documentElement.appendChild(dot); document.documentElement.appendChild(tag);' +
      'setTimeout(function () {' +
      '  box.style.opacity = "0"; dot.style.opacity = "0"; tag.style.opacity = "0";' +
      '  setTimeout(function () { box.remove(); dot.remove(); tag.remove(); }, 450);' +
      '}, 700);' +
      'return true;' +
      '})()'
    try {
      await evaluate(tabId, script)
    } catch {
      // The frame is a courtesy, never a reason for the action to fail.
    }
  }

  async function click(tabId, params) {
    const box = await boxOf(tabId, params)
    const button = params.button === 'right' ? 'right' : params.button === 'middle' ? 'middle' : 'left'
    const clickCount = Number(params.clickCount) > 0 ? Math.min(Number(params.clickCount), 3) : 1
    const point = { x: Math.round(box.x), y: Math.round(box.y) }
    await flash(tabId, params, 'клик')
    await new Promise((resolve) => setTimeout(resolve, 140))
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' })
    for (let count = 1; count <= clickCount; count += 1) {
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, clickCount: count })
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount: count })
    }
    const url = await evaluate(tabId, 'location.href').catch(() => '')
    return { clicked: { ref: params.ref, selector: params.selector, x: point.x, y: point.y }, url }
  }

  async function focusField(tabId, params, clearFirst) {
    const ref = params && params.ref !== undefined ? String(params.ref) : ''
    const selector = params && typeof params.selector === 'string' ? params.selector : ''
    const target =
      ref !== ''
        ? 'var el = (window.__andreyEls || [])[' + (Number(ref) - 1) + ']; if (!el || !el.isConnected) return { ok: false, error: "stale ref" };'
        : selector !== ''
          ? 'var el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return { ok: false, error: "no element matches the selector" };'
          : 'return { ok: false, error: "a ref or selector is required to focus a field" };'

    const script =
      '(() => {' +
      target +
      'el.scrollIntoView({ block: "center" });' +
      'try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }' +
      (clearFirst ? 'if (typeof el.select === "function" && el.value) el.select(); else if (el.isContentEditable) document.execCommand("selectAll", false, null);' : '') +
      'var r = el.getBoundingClientRect();' +
      'return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase(), editable: Boolean(el.isContentEditable || /^(input|textarea)$/i.test(el.tagName)) };' +
      '})()'

    const state = await evaluate(tabId, script)
    if (!state || !state.ok) fail('NO_ELEMENT', (state && state.error) || 'field not found')
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(state.x), y: Math.round(state.y), button: 'left', clickCount: 1 }).catch(() => {})
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(state.x), y: Math.round(state.y), button: 'left', clickCount: 1 }).catch(() => {})
    if (!state.editable) fail('EXTENSION_ERROR', 'the target is not an editable field')
    return state
  }

  async function type(tabId, params) {
    const text = String(params.text == null ? '' : params.text)
    await flash(tabId, params, 'ввод')
    await focusField(tabId, params, Boolean(params.clearFirst))
    if (text !== '') await cdp(tabId, 'Input.insertText', { text })
    if (params.submit) await keyEvent(tabId, 'Enter')
    return { typed: text.length, submitted: Boolean(params.submit), url: await evaluate(tabId, 'location.href').catch(() => '') }
  }

  async function press(tabId, params) {
    if (params.ref !== undefined || params.selector) await focusField(tabId, params, false)
    await keyEvent(tabId, String(params.key || 'Enter'))
    return { pressed: String(params.key || 'Enter'), url: await evaluate(tabId, 'location.href').catch(() => '') }
  }

  async function scroll(tabId, params) {
    if (params.toRef !== undefined) {
      const box = await boxOf(tabId, { ref: params.toRef })
      return { scrolledTo: params.toRef, y: box.y }
    }
    const delta = Number(params.deltaY) || 600
    const height = await evaluate(tabId, 'window.innerHeight').catch(() => 800)
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 200,
      y: Math.max(100, Math.round((Number(height) || 800) / 2)),
      deltaX: 0,
      deltaY: delta,
    })
    const scrollY = await evaluate(tabId, 'Math.round(window.scrollY)').catch(() => 0)
    return { deltaY: delta, scrollY }
  }

  async function waitForLoad(tabId, timeoutMs) {
    const deadline = Date.now() + (Number(timeoutMs) || 30000)
    for (;;) {
      const state = await evaluate(tabId, 'document.readyState').catch(() => 'loading')
      if (state === 'complete') return true
      if (Date.now() > deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  async function navigate(tabId, params) {
    const url = String(params.url || '')
    if (!/^https?:\/\//i.test(url)) fail('BAD_PARAMS', 'only http(s) URLs can be opened')
    await cdp(tabId, 'Page.navigate', { url })
    const loaded = await waitForLoad(tabId, params.timeoutMs)
    const finalUrl = await evaluate(tabId, 'location.href').catch(() => url)
    return { url: finalUrl, loaded }
  }

  async function wait(tabId, params) {
    const ms = Number(params.ms) || 0
    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 60000)))
      const url = await evaluate(tabId, 'location.href').catch(() => '')
      return { waited: ms, url }
    }
    const until = String(params.until || '')
    if (!until) return { waited: 0 }
    const deadline = Date.now() + (Number(params.timeoutMs) || 15000)
    const probe =
      '(() => { try { if (document.querySelector(' + JSON.stringify(until) + ')) return true; } catch (e) {} return (document.body ? document.body.innerText : "").includes(' + JSON.stringify(until) + '); })()'
    for (;;) {
      const found = await evaluate(tabId, probe).catch(() => false)
      if (found) return { found: true, until }
      if (Date.now() > deadline) fail('TIMEOUT', 'the condition did not appear in time: ' + until)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  async function extract(tabId, params) {
    const format = String(params.format || 'text')
    const scope = params.selector ? 'document.querySelector(' + JSON.stringify(String(params.selector)) + ')' : 'document.body'
    const script =
      '(() => {' +
      'var root = ' + scope + '; if (!root) return { ok: false, error: "selector does not match" };' +
      'if (' + JSON.stringify(format) + ' === "links") {' +
      '  var links = Array.prototype.slice.call(root.querySelectorAll("a[href]"), 0, 300).map(function (a) { return { text: (a.innerText || a.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 200), href: a.href }; });' +
      '  return { ok: true, url: location.href, text: root.innerText, links: links };' +
      '}' +
      'var text = root.innerText || root.textContent || "";' +
      'if (' + JSON.stringify(format) + ' === "markdown") {' +
      '  var parts = []; root.querySelectorAll("h1,h2,h3,h4,p,li,pre,blockquote").forEach(function (node) {' +
      '    var tag = node.tagName.toLowerCase(); var value = (node.innerText || "").replace(/\\s+/g, " ").trim(); if (!value) return;' +
      '    if (tag === "h1") parts.push("# " + value); else if (tag === "h2") parts.push("## " + value); else if (tag === "h3") parts.push("### " + value);' +
      '    else if (tag === "li") parts.push("- " + value); else if (tag === "pre") parts.push("    " + value); else if (tag === "blockquote") parts.push("> " + value); else parts.push(value);' +
      '  }); text = parts.join("\\n");' +
      '}' +
      'return { ok: true, url: location.href, text: String(text).trim() };' +
      '})()'
    const result = await evaluate(tabId, script)
    if (!result || !result.ok) fail('NO_ELEMENT', (result && result.error) || 'nothing to extract')
    return { url: result.url, text: result.text, links: result.links }
  }

  async function upload(tabId, params) {
    const paths = Array.isArray(params.paths) ? params.paths.map(String) : []
    if (paths.length === 0) fail('BAD_PARAMS', 'paths must not be empty')
    const ref = params.ref
    if (ref === undefined || ref === null) fail('BAD_PARAMS', 'upload needs a ref')
    const marked = await evaluate(
      tabId,
      '(() => { var el = (window.__andreyEls || [])[' + (Number(ref) - 1) + ']; if (!el || !el.isConnected) return false; el.setAttribute("data-andrey-upload", "1"); return el.tagName.toLowerCase() === "input" && el.type === "file"; })()',
    )
    if (marked !== true) fail('EXTENSION_ERROR', 'the element is not a file input')
    const document_ = await cdp(tabId, 'DOM.getDocument', { depth: 1 })
    const found = await cdp(tabId, 'DOM.querySelector', { nodeId: document_.root.nodeId, selector: '[data-andrey-upload="1"]' })
    if (!found || !found.nodeId) fail('NO_ELEMENT', 'the file input disappeared')
    await cdp(tabId, 'DOM.setFileInputFiles', { nodeId: found.nodeId, files: paths })
    await evaluate(tabId, '(() => { var el = document.querySelector("[data-andrey-upload]"); if (el) { el.removeAttribute("data-andrey-upload"); el.dispatchEvent(new Event("change", { bubbles: true })); } return true; })()').catch(() => {})
    return { files: paths.length }
  }

  async function screenshot(tabId, params) {
    const result = await cdp(tabId, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: Boolean(params.fullPage),
    })
    return { mimeType: 'image/png', data: result.data }
  }

  async function snapshot(tabId, params) {
    await evaluate(tabId, '1')
    const options = { interactive: params.interactive !== false, limit: Number(params.maxChars) > 0 ? 2000 : 600 }
    const source = self.AndreySnapshot.expression(options)
    const data = await evaluate(tabId, source)
    return data || { url: '', title: '', nodes: [] }
  }

  async function describe(tabId, params) {
    const ref = params.ref !== undefined ? String(params.ref) : ''
    const selector = typeof params.selector === 'string' ? params.selector : ''
    const target =
      ref !== ''
        ? 'var el = (window.__andreyEls || [])[' + (Number(ref) - 1) + ']; if (!el || !el.isConnected) return { ok: false, error: "stale ref" };'
        : selector !== ''
          ? 'var el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return { ok: false, error: "no element matches the selector" };'
          : 'var el = document.activeElement; if (!el) return { ok: false, error: "no focused element" };'
    const script =
      '(() => {' +
      target +
      'var name = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.innerText || el.value || "";' +
      'return { ok: true, url: location.href, title: document.title, role: el.getAttribute("role") || el.tagName.toLowerCase(), name: String(name).replace(/\\s+/g, " ").trim().slice(0, 160), tag: el.tagName.toLowerCase(), type: (el.type || "").toLowerCase(), fieldLabel: String((el.labels && el.labels[0] ? el.labels[0].innerText : "") || "").slice(0, 80) };' +
      '})()'
    const data = await evaluate(tabId, script)
    if (!data || !data.ok) fail('STALE_REF', (data && data.error) || 'element not found')
    return data
  }

  async function consoleEntries(tabId, params) {
    const rows = consoleBuffers.get(tabId) || []
    const limit = Math.max(1, Math.min(Number(params.limit) || 50, 200))
    return { url: await evaluate(tabId, 'location.href').catch(() => ''), entries: rows.slice(-limit) }
  }

  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (!source || typeof source.tabId !== 'number') return
    if (method !== 'Runtime.consoleAPICalled' && method !== 'Runtime.exceptionThrown' && method !== 'Log.entryAdded') return
    const rows = consoleBuffers.get(source.tabId) || []
    let row = null
    try {
      if (method === 'Runtime.consoleAPICalled') {
        row = {
          level: params.type || 'log',
          text: (params.args || []).map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type || '')).join(' ').slice(0, 1000),
        }
      } else if (method === 'Runtime.exceptionThrown') {
        const detail = params.exceptionDetails || {}
        row = { level: 'error', text: String((detail.exception && detail.exception.description) || detail.text || 'exception').slice(0, 1000) }
      } else {
        row = { level: params.entry.level || 'info', text: String(params.entry.text || '').slice(0, 1000) }
      }
    } catch {
      row = null
    }
    if (!row) return
    rows.push({ ts: new Date().toISOString(), ...row })
    consoleBuffers.set(source.tabId, rows.slice(-200))
  })

  chrome.debugger.onDetach.addListener((source) => {
    if (source && typeof source.tabId === 'number') attached.delete(source.tabId)
  })

  self.AndreyActions = {
    attach,
    detach,
    cdp,
    evaluate,
    snapshot,
    describe,
    click,
    type,
    press,
    scroll,
    navigate,
    wait,
    extract,
    upload,
    screenshot,
    consoleEntries,
    isAttached: (tabId) => attached.has(tabId),
  }
})()
