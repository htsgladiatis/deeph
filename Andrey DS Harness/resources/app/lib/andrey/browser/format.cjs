'use strict'

/**
 * Turn a page snapshot into the compact text a model can actually use.
 *
 * One line per interactive element, with a stable ref, the role, the accessible
 * name and the box position so the model can tell a header link from a footer
 * one. Password values never leave the page, and long values are cut: the model
 * needs to know the field is filled, not what the user typed.
 */

const MAX_NAME_CHARS = 160
const MAX_VALUE_CHARS = 80

function quote(value, limit = MAX_NAME_CHARS) {
  return '"' + String(value ?? '').replace(/\s+/g, ' ').replace(/"/g, "'").slice(0, limit) + '"'
}

function formatNode(node) {
  const head = '[' + node.ref + '] ' + (node.role || 'element') + ' ' + quote(node.name)
  const pos =
    node.x === undefined || node.y === undefined
      ? ''
      : ' @(' + Math.round(node.x) + ',' + Math.round(node.y) + ') ' + Math.round(node.w || 0) + 'x' + Math.round(node.h || 0)

  if (String(node.type || '').toLowerCase() === 'password' || /пароль|password/i.test(String(node.name || ''))) {
    return head + ' = ••••' + pos
  }
  if (node.value === undefined || node.value === null || node.value === '') return head + pos

  const raw = String(node.value).replace(/\s+/g, ' ')
  const shown = raw.length > MAX_VALUE_CHARS ? raw.slice(0, MAX_VALUE_CHARS) + '…' : raw
  return head + ' = ' + '"' + shown.replace(/"/g, "'") + '"' + pos
}

function formatSnapshot({ url, title, nodes, maxChars = 8000 }) {
  const list = Array.isArray(nodes) ? nodes : []
  const header = 'URL: ' + String(url || '') + '\nTITLE: ' + String(title || '') + '\n'
  const lines = []
  let size = header.length
  let truncated = false

  for (const node of list) {
    const line = formatNode(node)
    if (size + line.length + 1 > maxChars) {
      truncated = true
      break
    }
    lines.push(line)
    size += line.length + 1
  }

  const body = lines.join('\n')
  const note = truncated ? '\n… (truncated: scroll the page or narrow the selector)' : ''
  return { text: header + body + note, truncated }
}

function formatExtract({ url, format, text, links }) {
  const parts = ['URL: ' + String(url || ''), '', String(text ?? '')]
  if (format === 'links' && Array.isArray(links)) {
    parts.push('', 'Links:')
    for (const link of links) parts.push('- ' + String(link.text || '').replace(/\s+/g, ' ').slice(0, 160) + ' — ' + link.href)
  }
  return { text: parts.join('\n') }
}

module.exports = { formatSnapshot, formatExtract, formatNode, MAX_VALUE_CHARS }
