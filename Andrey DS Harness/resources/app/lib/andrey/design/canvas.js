/* global AndreyDesignOps */
(function (root) {
  'use strict'

  const NS = root.AndreyDesign || (root.AndreyDesign = {})
  const OPS = root.AndreyDesignOps
  const GRID = 8
  const MIN_ZOOM = 0.1
  const MAX_ZOOM = 8

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value))
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  NS.createCanvas = function createCanvas(host, options) {
    const opts = options || {}
    const canvas = document.createElement('canvas')
    canvas.className = 'adz-canvas'
    canvas.tabIndex = 0
    host.appendChild(canvas)
    const ctx = canvas.getContext('2d')

    const doc = OPS.emptyDoc(opts.id || 'main')
    const view = { x: 0, y: 0, zoom: 1 }
    const state = {
      tool: 'select',
      selected: null,
      draft: null,
      drag: null,
      space: false,
      history: [],
      future: [],
      width: 800,
      height: 600,
    }

    const listeners = { change: [], select: [] }

    function emit(name, payload) {
      (listeners[name] || []).forEach((fn) => {
        try { fn(payload) } catch (error) { console.error(error) }
      })
    }

    function notify() {
      doc.updatedAt = new Date().toISOString()
      emit('change', { doc: doc, selected: state.selected })
    }

    function snapshot() {
      state.history.push(deepClone(doc))
      if (state.history.length > 100) state.history.shift()
      state.future = []
    }

    function applyDoc(next, record) {
      if (record !== false) snapshot()
      const clean = OPS.sanitizeDoc(next)
      doc.version = clean.version
      doc.id = clean.id
      doc.name = clean.name
      doc.canvas = clean.canvas
      doc.viewport = clean.viewport
      doc.nextId = clean.nextId
      doc.nodes = clean.nodes
      view.x = doc.viewport.x
      view.y = doc.viewport.y
      view.zoom = clamp(doc.viewport.zoom, MIN_ZOOM, MAX_ZOOM)
      if (!doc.nodes.some((node) => node.id === state.selected)) state.selected = null
      notify()
    }

    function undo() {
      if (state.history.length === 0) return false
      state.future.push(deepClone(doc))
      const previous = state.history.pop()
      const keepSelected = state.selected
      applyDoc(previous, false)
      state.selected = keepSelected
      emit('select', state.selected)
      notify()
      return true
    }

    function redo() {
      if (state.future.length === 0) return false
      state.history.push(deepClone(doc))
      const next = state.future.pop()
      applyDoc(next, false)
      emit('select', state.selected)
      notify()
      return true
    }

    function resize() {
      const ratio = root.devicePixelRatio || 1
      const rect = host.getBoundingClientRect()
      state.width = Math.max(320, Math.floor(rect.width))
      state.height = Math.max(240, Math.floor(rect.height))
      canvas.width = Math.floor(state.width * ratio)
      canvas.height = Math.floor(state.height * ratio)
      canvas.style.width = state.width + 'px'
      canvas.style.height = state.height + 'px'
      render()
    }

    function toScreen(x, y) {
      return [(x + view.x) * view.zoom, (y + view.y) * view.zoom]
    }

    function toWorld(x, y) {
      return [x / view.zoom - view.x, y / view.zoom - view.y]
    }

    function drawGrid() {
      let step = GRID
      while (step * view.zoom < 6) step *= 2
      while (step * view.zoom > 48) step /= 2
      const startX = -view.x % step
      const startY = -view.y % step
      ctx.save()
      ctx.strokeStyle = opts.gridColor || 'rgba(127,127,127,0.16)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = startX; x < state.width; x += step * view.zoom) {
        ctx.moveTo(Math.round(x) + 0.5, 0)
        ctx.lineTo(Math.round(x) + 0.5, state.height)
      }
      for (let y = startY; y < state.height; y += step * view.zoom) {
        ctx.moveTo(0, Math.round(y) + 0.5)
        ctx.lineTo(state.width, Math.round(y) + 0.5)
      }
      ctx.stroke()
      ctx.restore()
    }

    function nodePath(node) {
      const w = Math.max(1, node.w)
      const h = Math.max(1, node.h)
      if (node.type === 'ellipse') {
        ctx.beginPath()
        ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
      } else if (node.type === 'path') {
        ctx.beginPath()
        const points = node.points && node.points.length >= 2 ? node.points : [[0, 0], [w, h]]
        points.forEach((point, index) => {
          if (index === 0) ctx.moveTo(point[0], point[1])
          else ctx.lineTo(point[0], point[1])
        })
        if (node.closed) ctx.closePath()
      } else {
        const radius = Math.min(node.radius || 0, w / 2, h / 2)
        ctx.beginPath()
        if (radius > 0 && ctx.roundRect) ctx.roundRect(0, 0, w, h, radius)
        else ctx.rect(0, 0, w, h)
      }
    }

    function drawNode(node) {
      const [sx, sy] = toScreen(node.x, node.y)
      ctx.save()
      ctx.globalAlpha = clamp(node.opacity ?? 1, 0, 1)
      ctx.translate(sx, sy)
      if (node.rotation) {
        ctx.translate(node.w * view.zoom / 2, node.h * view.zoom / 2)
        ctx.rotate(node.rotation * Math.PI / 180)
        ctx.translate(-node.w * view.zoom / 2, -node.h * view.zoom / 2)
      }
      ctx.scale(view.zoom, view.zoom)
      ctx.lineWidth = Math.max(0.5, node.strokeWidth || 0)
      ctx.strokeStyle = node.stroke || 'transparent'
      ctx.fillStyle = node.fill || 'transparent'
      if (node.type === 'text') {
        const size = node.fontSize || 16
        ctx.font = `${node.fontWeight || 400} ${size}px ${node.fontFamily || 'Inter, system-ui, sans-serif'}`
        ctx.textBaseline = 'top'
        ctx.textAlign = node.align || 'left'
        const lines = String(node.text || '').split('\n')
        const lineHeight = size * 1.35
        const maxWidth = Math.max(40, node.w)
        lines.forEach((line, index) => {
          let content = line
          if (ctx.measureText(content).width > maxWidth && maxWidth > 40) {
            while (content.length > 1 && ctx.measureText(content + '…').width > maxWidth) content = content.slice(0, -1)
            if (content !== line) content += '…'
          }
          const x = node.align === 'center' ? maxWidth / 2 : node.align === 'right' ? maxWidth : 0
          ctx.fillText(content, x, index * lineHeight)
        })
      } else {
        nodePath(node)
        if (node.type !== 'path' || node.closed) {
          if (node.fill && node.fill !== 'transparent') ctx.fill()
        }
        if (node.stroke && node.stroke !== 'transparent' && ctx.lineWidth > 0) ctx.stroke()
      }
      ctx.restore()
    }

    function drawSelection() {
      if (!state.selected) return
      const node = doc.nodes.find((entry) => entry.id === state.selected)
      if (!node) return
      const [sx, sy] = toScreen(node.x, node.y)
      const w = node.w * view.zoom
      const h = node.h * view.zoom
      ctx.save()
      ctx.strokeStyle = opts.selectionColor || '#4c8dff'
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.strokeRect(sx - 1, sy - 1, w + 2, h + 2)
      ctx.setLineDash([])
      const handles = [
        [sx, sy], [sx + w / 2, sy], [sx + w, sy],
        [sx, sy + h / 2], [sx + w, sy + h / 2],
        [sx, sy + h], [sx + w / 2, sy + h], [sx + w, sy + h],
      ]
      ctx.fillStyle = opts.handleColor || '#ffffff'
      handles.forEach(([hx, hy]) => {
        ctx.fillRect(hx - 3, hy - 3, 6, 6)
        ctx.strokeRect(hx - 3, hy - 3, 6, 6)
      })
      ctx.restore()
    }

    function drawDraft() {
      if (!state.draft) return
      const draft = state.draft
      const [sx, sy] = toScreen(Math.min(draft.x0, draft.x1), Math.min(draft.y0, draft.y1))
      const w = Math.abs(draft.x1 - draft.x0) * view.zoom
      const h = Math.abs(draft.y1 - draft.y0) * view.zoom
      ctx.save()
      ctx.strokeStyle = opts.selectionColor || '#4c8dff'
      ctx.setLineDash([4, 3])
      if (draft.kind === 'path') {
        ctx.beginPath()
        draft.points.forEach((point, index) => {
          const [px, py] = toScreen(point[0], point[1])
          if (index === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        })
        ctx.stroke()
      } else {
        ctx.strokeRect(sx, sy, w, h)
      }
      ctx.restore()
    }

    function render() {
      const ratio = root.devicePixelRatio || 1
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.scale(ratio, ratio)
      ctx.clearRect(0, 0, state.width, state.height)
      ctx.fillStyle = doc.canvas.background || '#ffffff'
      ctx.fillRect(0, 0, state.width, state.height)
      drawGrid()
      doc.nodes.forEach(drawNode)
      drawSelection()
      drawDraft()
    }

    function hitTest(clientX, clientY) {
      const rect = canvas.getBoundingClientRect()
      const [wx, wy] = toWorld(clientX - rect.left, clientY - rect.top)
      for (let index = doc.nodes.length - 1; index >= 0; index -= 1) {
        const node = doc.nodes[index]
        if (wx >= node.x && wx <= node.x + node.w && wy >= node.y && wy <= node.y + node.h) {
          return { node, index }
        }
      }
      return null
    }

    function handleAt(clientX, clientY) {
      const node = doc.nodes.find((entry) => entry.id === state.selected)
      if (!node) return null
      const rect = canvas.getBoundingClientRect()
      const [sx, sy] = toScreen(node.x, node.y)
      const x = clientX - rect.left
      const y = clientY - rect.top
      const w = node.w * view.zoom
      const h = node.h * view.zoom
      const points = {
        nw: [sx, sy], n: [sx + w / 2, sy], ne: [sx + w, sy],
        w: [sx, sy + h / 2], e: [sx + w, sy + h / 2],
        sw: [sx, sy + h], s: [sx + w / 2, sy + h], se: [sx + w, sy + h],
      }
      for (const key of Object.keys(points)) {
        const [hx, hy] = points[key]
        if (Math.abs(x - hx) <= 5 && Math.abs(y - hy) <= 5) return key
      }
      return null
    }

    function eventPoint(event) {
      const rect = canvas.getBoundingClientRect()
      const [wx, wy] = toWorld(event.clientX - rect.left, event.clientY - rect.top)
      return [wx, wy]
    }

    function onPointerDown(event) {
      if (event.button !== 0 && event.button !== 1) return
      canvas.focus()
      canvas.setPointerCapture(event.pointerId)
      const [wx, wy] = eventPoint(event)
      if (state.space || state.tool === 'hand' || event.button === 1) {
        state.drag = { mode: 'pan', x: event.clientX, y: event.clientY, vx: view.x, vy: view.y }
        return
      }
      const handle = handleAt(event.clientX, event.clientY)
      if (handle) {
        const node = doc.nodes.find((entry) => entry.id === state.selected)
        snapshot()
        state.drag = { mode: 'resize', handle, node, x: wx, y: wy, w: node.w, h: node.h }
        return
      }
      if (state.tool === 'select') {
        const hit = hitTest(event.clientX, event.clientY)
        state.selected = hit ? hit.node.id : null
        emit('select', state.selected)
        render()
        if (hit) {
          snapshot()
          state.drag = { mode: 'move', node: hit.node, x: wx, y: wy, ox: hit.node.x, oy: hit.node.y }
        }
        return
      }
      if (state.tool === 'text') {
        snapshot()
        const node = OPS.normalizeNode({
          type: 'text', x: Math.round(wx), y: Math.round(wy), w: 240, h: 40,
          text: opts.placeholderText || 'Текст', fontSize: 16, fill: opts.textColor || '#111111', stroke: 'transparent',
        }, doc).node
        if (node) {
          doc.nodes.push(node)
          state.selected = node.id
          emit('select', state.selected)
          notify()
          if (opts.onEditText) opts.onEditText(node)
        }
        return
      }
      state.draft = {
        kind: state.tool === 'pen' ? 'path' : state.tool,
        x0: wx, y0: wy, x1: wx, y1: wy,
        points: [[Math.round(wx), Math.round(wy)]],
      }
    }

    function onPointerMove(event) {
      if (!state.drag && !state.draft) return
      const [wx, wy] = eventPoint(event)
      if (state.drag) {
        const drag = state.drag
        if (drag.mode === 'pan') {
          view.x = drag.vx - (event.clientX - drag.x) / view.zoom
          view.y = drag.vy - (event.clientY - drag.y) / view.zoom
        } else if (drag.mode === 'move') {
          drag.node.x = Math.round(drag.ox + wx - drag.x)
          drag.node.y = Math.round(drag.oy + wy - drag.y)
        } else if (drag.mode === 'resize') {
          const node = drag.node
          const dx = wx - drag.x
          const dy = wy - drag.y
          if (drag.handle.includes('e')) node.w = Math.max(8, Math.round(drag.w + dx))
          if (drag.handle.includes('s')) node.h = Math.max(8, Math.round(drag.h + dy))
          if (drag.handle.includes('w')) {
            node.w = Math.max(8, Math.round(drag.w - dx))
            node.x = Math.round(drag.node.x + dx)
          }
          if (drag.handle.includes('n')) {
            node.h = Math.max(8, Math.round(drag.h - dy))
            node.y = Math.round(drag.node.y + dy)
          }
        }
        render()
        return
      }
      const draft = state.draft
      draft.x1 = wx
      draft.y1 = wy
      if (draft.kind === 'path') {
        const last = draft.points[draft.points.length - 1]
        if (Math.hypot(wx - last[0], wy - last[1]) > 2 / view.zoom) {
          draft.points.push([Math.round(wx), Math.round(wy)])
        }
      }
      render()
    }

    function onPointerUp(event) {
      if (state.drag) {
        state.drag = null
        notify()
        return
      }
      const draft = state.draft
      if (!draft) return
      state.draft = null
      let node = null
      if (draft.kind === 'path') {
        if (draft.points.length >= 2) {
          node = OPS.normalizeNode({ type: 'path', x: 0, y: 0, points: draft.points, stroke: opts.inkColor || '#111111', strokeWidth: 2, fill: 'transparent' }, doc).node
          if (node) {
            node.x = Math.min(...draft.points.map((p) => p[0]))
            node.y = Math.min(...draft.points.map((p) => p[1]))
          }
        }
      } else if (draft.kind === 'rect' || draft.kind === 'ellipse') {
        const x = Math.min(draft.x0, draft.x1)
        const y = Math.min(draft.y0, draft.y1)
        const w = Math.max(4, Math.abs(draft.x1 - draft.x0))
        const h = Math.max(4, Math.abs(draft.y1 - draft.y0))
        if (w > 2 && h > 2) {
          node = OPS.normalizeNode({
            type: draft.kind,
            x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h),
            fill: opts.fillColor || '#eceff4', stroke: opts.strokeColor || '#2e3440', strokeWidth: 1, radius: 8,
          }, doc).node
        }
      }
      if (node) {
        snapshot()
        doc.nodes.push(node)
        state.selected = node.id
        emit('select', state.selected)
        notify()
      } else {
        render()
      }
    }

    function onKeyDown(event) {
      if (event.key === ' ' && !event.repeat) {
        state.space = true
        canvas.style.cursor = 'grab'
        event.preventDefault()
      }
    }

    function onKeyUp(event) {
      if (event.key === ' ') {
        state.space = false
        canvas.style.cursor = state.tool === 'hand' ? 'grab' : 'default'
      }
    }

    function onWheel(event) {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      const [wx, wy] = toWorld(px, py)
      const factor = Math.exp(-event.deltaY * 0.0015)
      view.zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM)
      view.x = px / view.zoom - wx
      view.y = py / view.zoom - wy
      render()
    }

    function onDoubleClick(event) {
      if (state.tool !== 'select') return
      const hit = hitTest(event.clientX, event.clientY)
      if (!hit) return
      if (hit.node.type === 'text' && opts.onEditText) {
        state.selected = hit.node.id
        emit('select', state.selected)
        opts.onEditText(hit.node)
      }
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('dblclick', onDoubleClick)
    canvas.addEventListener('keydown', onKeyDown)
    canvas.addEventListener('keyup', onKeyUp)

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null
    observer?.observe(host)
    resize()

    return {
      canvas,
      get doc() { return doc },
      load(next) { applyDoc(next, false) },
      setDoc(next) { applyDoc(next, true) },
      getDoc() { return deepClone(doc) },
      get selected() { return state.selected },
      select(idValue) {
        state.selected = idValue && doc.nodes.some((node) => node.id === idValue) ? idValue : null
        emit('select', state.selected)
        render()
      },
      setTool(name) {
        state.tool = name
        canvas.style.cursor = name === 'hand' ? 'grab' : name === 'select' ? 'default' : 'crosshair'
      },
      undo,
      redo,
      refresh: render,
      addNode(node) {
        const normalized = OPS.normalizeNode(node, doc)
        if (normalized.error) return { ok: false, error: normalized.error }
        snapshot()
        doc.nodes.push(normalized.node)
        state.selected = normalized.node.id
        emit('select', state.selected)
        notify()
        return { ok: true, node: normalized.node }
      },
      applyAgentOps(ops) {
        const applied = OPS.applyOps(doc, ops)
        if (applied.accepted.length > 0) {
          snapshot()
          applied.accepted.forEach((op) => {
            if (op.op === 'clear') doc.nodes = []
            else if (op.op === 'add') doc.nodes.push(op.node)
            else if (op.op === 'delete') doc.nodes = doc.nodes.filter((node) => node.id !== op.id)
            else {
              const node = doc.nodes.find((entry) => entry.id === op.id)
              if (node) Object.assign(node, op.patch)
            }
          })
          notify()
        }
        return applied
      },
      update(idValue, patch) {
        const node = doc.nodes.find((entry) => entry.id === idValue)
        if (!node || !patch) return { ok: false, error: 'unknown-id' }
        const check = OPS.validateOp({ op: 'update', id: idValue, patch }, doc, 0)
        if (!check.ok) return { ok: false, error: check.reason }
        snapshot()
        Object.assign(node, check.op.patch)
        notify()
        return { ok: true, node }
      },
      deleteSelected() {
        if (!state.selected) return false
        const idValue = state.selected
        snapshot()
        doc.nodes = doc.nodes.filter((node) => node.id !== idValue)
        state.selected = null
        emit('select', null)
        notify()
        return true
      },
      duplicateSelected() {
        const node = doc.nodes.find((entry) => entry.id === state.selected)
        if (!node) return null
        const copy = OPS.normalizeNode({ ...deepClone(node), id: undefined, x: node.x + 24, y: node.y + 24 }, doc).node
        if (!copy) return null
        snapshot()
        doc.nodes.push(copy)
        state.selected = copy.id
        emit('select', copy.id)
        notify()
        return copy
      },
      reorder(idValue, direction) {
        const index = doc.nodes.findIndex((node) => node.id === idValue)
        const next = index + direction
        if (index < 0 || next < 0 || next >= doc.nodes.length) return false
        snapshot()
        const [node] = doc.nodes.splice(index, 1)
        doc.nodes.splice(next, 0, node)
        notify()
        return true
      },
      rename(idValue, name) {
        const node = doc.nodes.find((entry) => entry.id === idValue)
        if (!node) return false
        snapshot()
        node.name = String(name).slice(0, 120)
        notify()
        return true
      },
      on(name, fn) {
        if (!listeners[name]) listeners[name] = []
        listeners[name].push(fn)
        return () => { listeners[name] = listeners[name].filter((entry) => entry !== fn) }
      },
      destroy() {
        observer?.disconnect()
        canvas.removeEventListener('pointerdown', onPointerDown)
        canvas.removeEventListener('pointermove', onPointerMove)
        canvas.removeEventListener('pointerup', onPointerUp)
        canvas.removeEventListener('pointercancel', onPointerUp)
        canvas.removeEventListener('wheel', onWheel)
        canvas.removeEventListener('dblclick', onDoubleClick)
        canvas.removeEventListener('keydown', onKeyDown)
        canvas.removeEventListener('keyup', onKeyUp)
        canvas.remove()
      },
    }
  }
})(typeof window !== 'undefined' ? window : globalThis)