'use strict'

/**
 * Document schema and operation validation for the design canvas.
 *
 * Everything here is shared by the local API (`/design/*`) and the renderer:
 * the route validates before writing, the canvas validates before applying.
 * The functions are pure; the only global is the id counter passed in the doc.
 */

const LIMITS = {
  nodes: 2000,
  ops: 200,
  text: 4000,
  points: 5000,
  coord: 100000,
  name: 120,
  id: 40,
}

const COLORS = new Set(['transparent'])

function isColor(value) {
  if (typeof value !== 'string') return false
  const color = value.trim().toLowerCase()
  if (COLORS.has(color)) return true
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(color)
}

function num(value, min = -LIMITS.coord, max = LIMITS.coord) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.min(max, Math.max(min, parsed))
}

function id(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value) ? value : null
}

function text(value) {
  if (typeof value !== 'string') return ''
  return value.slice(0, LIMITS.text)
}

function pointList(value) {
  if (!Array.isArray(value)) return []
  const points = []
  for (const entry of value.slice(0, LIMITS.points)) {
    const pair = Array.isArray(entry) ? entry : null
    if (!pair || pair.length < 2) continue
    const x = num(pair[0])
    const y = num(pair[1])
    if (x === null || y === null) continue
    points.push([Math.round(x), Math.round(y)])
  }
  return points
}

function clampInt(value, min, max) {
  const parsed = Math.round(num(value, min, max) ?? min)
  return parsed
}

/** A node is valid only with a known type and numeric geometry. */
function normalizeNode(input, doc, forcedId) {
  if (!input || typeof input !== 'object') return { error: 'invalid-node' }
  const rawType = String(input.type ?? '').toLowerCase()
  const type = rawType === 'circle' ? 'ellipse' : rawType
  if (!['rect', 'ellipse', 'text', 'path'].includes(type)) return { error: 'invalid-type' }

  let w = num(input.w, 1, 100000)
  let h = num(input.h, 1, 100000)
  if (type === 'path') {
    const points = pointList(input.points)
    if (points.length >= 2) {
      const xs = points.map((point) => point[0])
      const ys = points.map((point) => point[1])
      w = w ?? Math.max(1, Math.max(...xs) - Math.min(...xs))
      h = h ?? Math.max(1, Math.max(...ys) - Math.min(...ys))
    }
  }
  if (type === 'ellipse' && (w === null || h === null)) {
    const radius = num(input.r, 1, 50000)
    if (radius !== null) {
      if (w === null) w = radius * 2
      if (h === null) h = radius * 2
    }
  }
  if (w === null) w = type === 'text' ? 240 : 160
  if (h === null) h = type === 'text' ? 40 : 120

  const node = {
    id: forcedId ?? id(input.id) ?? nextId(doc),
    type,
    name: String(input.name ?? type).slice(0, LIMITS.name),
    x: num(input.x, -LIMITS.coord, LIMITS.coord) ?? 0,
    y: num(input.y, -LIMITS.coord, LIMITS.coord) ?? 0,
    w,
    h,
    rotation: num(input.rotation, -360, 360) ?? 0,
    fill: isColor(input.fill) ? input.fill : type === 'text' ? 'transparent' : '#eceff4',
    stroke: isColor(input.stroke) ? input.stroke : '#2e3440',
    strokeWidth: clampInt(input.strokeWidth ?? 1, 0, 64),
    opacity: num(input.opacity ?? 1, 0, 1) ?? 1,
    radius: type === 'rect' ? clampInt(input.radius ?? 0, 0, 4096) : 0,
    text: type === 'text' ? text(input.text) : '',
    fontSize: clampInt(input.fontSize ?? 16, 6, 400),
    fontFamily: typeof input.fontFamily === 'string' && input.fontFamily.trim()
      ? input.fontFamily.trim().slice(0, 120)
      : 'Inter, system-ui, sans-serif',
    fontWeight: clampInt(input.fontWeight ?? 400, 100, 900),
    align: ['left', 'center', 'right'].includes(input.align) ? input.align : 'left',
    points: type === 'path' ? pointList(input.points) : [],
    closed: type === 'path' ? input.closed === true : false,
  }
  if (node.type === 'path' && node.points.length < 2) return { error: 'invalid-path' }
  return { node }
}

function nextId(doc) {
  let counter = Number(doc?.nextId ?? 1)
  if (!Number.isFinite(counter) || counter < 1) counter = 1
  const used = new Set((doc?.nodes ?? []).map((node) => node.id))
  let candidate = ''
  do {
    candidate = `n_${counter}`
    counter += 1
  } while (used.has(candidate))
  if (doc && typeof doc === 'object') doc.nextId = counter
  return candidate
}

function emptyDoc(idValue = 'main', name = 'Без названия') {
  const doc = {
    version: 1,
    id: id(idValue) ?? 'main',
    name: String(name || 'Без названия').slice(0, LIMITS.name),
    updatedAt: new Date().toISOString(),
    canvas: { width: 1600, height: 1000, background: '#ffffff' },
    viewport: { x: 0, y: 0, zoom: 1 },
    nextId: 1,
    nodes: [],
  }
  return doc
}

function sanitizeDoc(input, fallbackId = 'main') {
  const doc = emptyDoc(
    typeof input?.id === 'string' ? input.id : fallbackId,
    typeof input?.name === 'string' ? input.name : 'Без названия',
  )
  if (input && typeof input === 'object') {
    const width = num(input.canvas?.width, 100, 20000)
    const height = num(input.canvas?.height, 100, 20000)
    if (width !== null) doc.canvas.width = Math.round(width)
    if (height !== null) doc.canvas.height = Math.round(height)
    if (isColor(input.canvas?.background)) doc.canvas.background = input.canvas.background
    const viewport = input.viewport ?? {}
    doc.viewport = {
      x: num(viewport.x, -LIMITS.coord, LIMITS.coord) ?? 0,
      y: num(viewport.y, -LIMITS.coord, LIMITS.coord) ?? 0,
      zoom: num(viewport.zoom, 0.05, 20) ?? 1,
    }
    const nodes = Array.isArray(input.nodes) ? input.nodes.slice(0, LIMITS.nodes) : []
    for (const raw of nodes) {
      const result = normalizeNode(raw, doc)
      if (result.node) doc.nodes.push(result.node)
    }
    doc.nextId = Math.max(doc.nextId, Number(input.nextId) || 1)
  }
  doc.nodes = doc.nodes.slice(0, LIMITS.nodes)
  return doc
}

const PATCH_FIELDS = [
  'name', 'x', 'y', 'w', 'h', 'rotation', 'fill', 'stroke', 'strokeWidth',
  'opacity', 'radius', 'text', 'fontSize', 'fontFamily', 'fontWeight', 'align', 'points', 'closed',
]

/** Validate one agent/user operation against the document. */
function validateOp(op, doc, index) {
  const fail = (reason) => ({ ok: false, reason: `${reason}#${index}` })
  if (!op || typeof op !== 'object') return fail('invalid-op')
  const kind = String(op.op ?? '').toLowerCase()
  if (kind === 'clear') return { ok: true, op: { op: 'clear' } }
  if (kind === 'add') {
    if (doc.nodes.length >= LIMITS.nodes) return fail('too-many-nodes')
    const result = normalizeNode(op.node, doc)
    if (result.error) return fail(result.error)
    return { ok: true, op: { op: 'add', node: result.node } }
  }
  if (kind === 'update') {
    const node = doc.nodes.find((entry) => entry.id === op.id)
    if (!node) return fail('unknown-id')
    if (!op.patch || typeof op.patch !== 'object') return fail('invalid-patch')
    const patch = {}
    for (const field of PATCH_FIELDS) {
      if (!(field in op.patch)) continue
      if (field === 'fill' || field === 'stroke') {
        if (!isColor(op.patch[field])) return fail('invalid-color')
        patch[field] = op.patch[field]
      } else if (field === 'text') {
        patch.text = text(op.patch[field])
      } else if (field === 'points') {
        patch.points = pointList(op.patch[field])
      } else if (field === 'fontFamily' || field === 'name' || field === 'align') {
        if (field === 'align' && !['left', 'center', 'right'].includes(op.patch[field])) return fail('invalid-align')
        patch[field] = String(op.patch[field]).slice(0, field === 'fontFamily' ? 120 : LIMITS.name)
      } else if (field === 'closed') {
        patch.closed = op.patch[field] === true
      } else {
        const min = field === 'w' || field === 'h' ? 1 : -LIMITS.coord
        const value = num(op.patch[field], min, field === 'fontSize' ? 400 : LIMITS.coord)
        if (value === null) return fail('invalid-number')
        patch[field] = value
      }
    }
    if (Object.keys(patch).length === 0) return fail('empty-patch')
    return { ok: true, op: { op: 'update', id: node.id, patch } }
  }
  if (kind === 'delete') {
    if (!doc.nodes.some((entry) => entry.id === op.id)) return fail('unknown-id')
    return { ok: true, op: { op: 'delete', id: op.id } }
  }
  return fail('unknown-op')
}

/**
 * Apply a list of ops atomically. Unknown/invalid ops are rejected with a
 * reason; valid ones are applied to a clone, so a bad answer never destroys the
 * current document.
 */
function applyOps(inputDoc, ops) {
  const doc = sanitizeDoc(inputDoc)
  const accepted = []
  const rejected = []
  const list = Array.isArray(ops) ? ops.slice(0, LIMITS.ops) : []
  for (let index = 0; index < list.length; index += 1) {
    const result = validateOp(list[index], doc, index)
    if (!result.ok) {
      rejected.push({ index, op: list[index]?.op ?? null, reason: result.reason })
      continue
    }
    accepted.push(result.op)
    applyOp(doc, result.op)
  }
  doc.updatedAt = new Date().toISOString()
  return { doc, accepted, rejected }
}

function applyOp(doc, op) {
  if (op.op === 'clear') {
    doc.nodes = []
    return
  }
  if (op.op === 'add') {
    doc.nodes.push(op.node)
    return
  }
  if (op.op === 'delete') {
    doc.nodes = doc.nodes.filter((node) => node.id !== op.id)
    return
  }
  const node = doc.nodes.find((entry) => entry.id === op.id)
  if (node) Object.assign(node, op.patch)
}
;(function (root) { root.AndreyDesignOps = { LIMITS, emptyDoc, sanitizeDoc, normalizeNode, applyOps, validateOp, isColor }; })(typeof window !== 'undefined' ? window : globalThis);
