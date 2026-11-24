'use strict'

/**
 * The page-side half of a snapshot.
 *
 * `fn` is serialized into the page and evaluated there; the extension never
 * injects a content script, because a content script cannot see the DOM of a
 * page loaded before the extension and would need a reload for every install.
 * The element list is kept on `window.__andreyEls` so a later click can resolve
 * the same ref without re-scanning.
 */

function snapshotInPage(options) {
  var opts = options || {}
  var limit = opts.limit || 600
  var wantAll = opts.interactive === false
  var win = window
  var doc = document

  function visible(el) {
    var rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return false
    var style = win.getComputedStyle(el)
    if (!style || style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false
    if (rect.bottom < -2000 || rect.top > (win.innerHeight || 0) + 20000) return false
    return true
  }

  function roleOf(el) {
    var explicit = el.getAttribute('role')
    if (explicit) return explicit
    var tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'input') {
      var type = (el.type || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button') return 'button'
      return 'textbox'
    }
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return 'combobox'
    if (tag === 'summary') return 'button'
    if (el.isContentEditable) return 'textbox'
    return tag
  }

  function nameOf(el) {
    var text = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name')
    if (!text) {
      var tag = el.tagName.toLowerCase()
      var type = (el.type || '').toLowerCase()
      if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) text = el.value
      else if (tag === 'img') text = el.alt
      else text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    }
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  }

  function valueOf(el) {
    var type = (el.type || '').toLowerCase()
    if (type === 'password') return ''
    if (el.isContentEditable) return String(el.innerText || '').slice(0, 200)
    if (typeof el.value === 'string') return el.value.slice(0, 200)
    return ''
  }

  var selector = wantAll
    ? 'a,button,input,select,textarea,summary,label,[role],[tabindex],[contenteditable="true"],[onclick]'
    : 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="combobox"],[role="textbox"],[contenteditable="true"]'

  var elements = []
  var nodes = []
  var seen = new Set()
  var candidates = doc.querySelectorAll(selector)

  for (var index = 0; index < candidates.length; index += 1) {
    var el = candidates[index]
    if (seen.has(el)) continue
    seen.add(el)
    if (!visible(el)) continue
    var rect = el.getBoundingClientRect()
    elements.push(el)
    nodes.push({
      ref: String(elements.length),
      role: roleOf(el),
      name: nameOf(el),
      tag: el.tagName.toLowerCase(),
      type: (el.type || '').toLowerCase(),
      value: valueOf(el),
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      x: Math.round(rect.left + win.scrollX),
      y: Math.round(rect.top + win.scrollY),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    })
    if (nodes.length >= limit) break
  }

  win.__andreyEls = elements
  return { url: location.href, title: doc.title, nodes: nodes }
}

self.AndreySnapshot = {
  fn: snapshotInPage,
  /** The expression to evaluate in the page for a given option object. */
  expression(options) {
    return '(' + snapshotInPage.toString() + ')(' + JSON.stringify(options || {}) + ')'
  },
}
