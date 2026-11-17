(function (root) {
  'use strict'

  const NS = root.AndreyDesign || (root.AndreyDesign = {})
  const API = 'http://127.0.0.1:39147'
  const ROOT_ID = 'andrey-design-root'
  const TOOLS = [
    ['select', 'V', 'Выделение'],
    ['hand', 'H', 'Рука'],
    ['rect', 'R', 'Прямоугольник'],
    ['ellipse', 'O', 'Эллипс'],
    ['text', 'T', 'Текст'],
    ['pen', 'P', 'Перо'],
  ]

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  async function request(method, path, body, signal) {
    const response = await fetch(API + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
    const text = await response.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
    if (!response.ok || (parsed && parsed.ok === false)) {
      const reason = parsed?.error || parsed?.detail || `HTTP ${response.status}`
      throw new Error(String(reason))
    }
    return parsed
  }

  function detectModel() {
    const checked = document.querySelector('[role="menuitemradio"][aria-checked="true"]')
    const label = checked?.textContent?.trim()
    if (label) return label
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index)
        if (!/model/i.test(key)) continue
        const value = localStorage.getItem(key)
        if (typeof value === 'string' && value.trim() && value.length < 120) return value.trim()
      }
    } catch { /* storage may be blocked */ }
    return null
  }

  NS.open = function open() {
    if (!panel) panel = build()
    panel.root.style.display = 'flex'
    panel.canvas.refresh()
    if (!panel.loaded) panel.load()
    panel.canvas.canvas.focus()
    return panel.root
  }

  NS.close = function close() {
    if (!panel) return
    panel.saveNow()
    panel.root.style.display = 'none'
  }

  NS.toggle = function toggle() {
    if (!panel || panel.root.style.display === 'none') NS.open()
    else NS.close()
  }

  NS.canvas = function canvas() {
    return panel ? panel.canvas : null
  }

  NS.isOpen = function isOpen() {
    return Boolean(panel && panel.root.style.display !== 'none')
  }

  let panel = null

  function applyTheme(rootNode) {
    try {
      const style = getComputedStyle(document.body)
      const bg = style.backgroundColor || '#1f1f22'
      const text = style.color || '#eceff4'
      if (!bg || bg === 'rgba(0, 0, 0, 0)') return
      rootNode.style.setProperty('--adz-bg', bg)
      rootNode.style.setProperty('--adz-text', text)
      rootNode.style.setProperty('--adz-panel', `color-mix(in srgb, ${bg} 94%, ${text})`)
      rootNode.style.setProperty('--adz-panel-2', `color-mix(in srgb, ${bg} 88%, ${text})`)
      rootNode.style.setProperty('--adz-dim', `color-mix(in srgb, ${text} 62%, ${bg})`)
      rootNode.style.setProperty('--adz-line', `color-mix(in srgb, ${text} 12%, transparent)`)
    } catch {
      /* fall back to the stylesheet palette */
    }
  }

  function build() {
    const rootNode = el('div', 'adz-root')
    rootNode.id = ROOT_ID
    rootNode.style.display = 'none'

    /* header */
    const header = el('div', 'adz-head')
    const title = el('div', 'adz-title', 'Дизайн')
    const docSelect = el('select', 'adz-select adz-doc-select')
    const newDoc = el('button', 'adz-btn', 'Новый')
    const deleteDoc = el('button', 'adz-btn adz-btn--ghost', 'Удалить')
    const saveState = el('span', 'adz-save', 'сохранено')
    const back = el('button', 'adz-btn adz-btn--ghost adz-back', '← В чат')
    back.title = 'Вернуться в харнесс (Esc)'
    const close = el('button', 'adz-close', '×')
    close.setAttribute('aria-label', 'Закрыть дизайн')
    header.append(back, title, docSelect, newDoc, deleteDoc, el('span', 'adz-spacer'), saveState)

    /* toolbar */
    const toolbar = el('div', 'adz-tools')
    const toolButtons = {}
    TOOLS.forEach(([idValue, key, label]) => {
      const button = el('button', 'adz-tool', label)
      button.type = 'button'
      button.dataset.tool = idValue
      button.title = `${label} (${key})`
      button.textContent = label.slice(0, 1)
      button.setAttribute('aria-label', `${label} (${key})`)
      button.addEventListener('click', () => setTool(idValue))
      toolbar.appendChild(button)
      toolButtons[idValue] = button
    })
    const undo = el('button', 'adz-tool', '↶')
    undo.title = 'Отменить (Ctrl+Z)'
    undo.setAttribute('aria-label', 'Отменить')
    const redo = el('button', 'adz-tool', '↷')
    redo.title = 'Повторить (Ctrl+Shift+Z)'
    redo.setAttribute('aria-label', 'Повторить')
    toolbar.append(el('span', 'adz-sep'), undo, redo)

    /* canvas */
    const canvasHost = el('div', 'adz-canvas-host')
    const canvas = NS.createCanvas(canvasHost, {
      onEditText: (node) => {
        const value = rootNode.ownerDocument.defaultView?.prompt?.('Текст фигуры', node.text || '')
        if (value !== null) {
          state.canvas.update(node.id, { text: value })
          refresh()
        }
      },
      fillColor: '#eceff4',
      strokeColor: '#2e3440',
      textColor: '#111111',
    })

    /* side panel */
    const side = el('div', 'adz-side')
    const props = el('div', 'adz-props')
    props.appendChild(el('div', 'adz-side-title', 'Свойства'))
    const propFields = {}
    const propRow = (label, key, type) => {
      const row = el('label', 'adz-prop')
      row.appendChild(el('span', 'adz-prop__label', label))
      const input = el('input', 'adz-input')
      input.type = type
      input.dataset.prop = key
      input.addEventListener('change', () => {
        const node = state.canvas.selected
        const selected = state.canvas.doc.nodes.find((entry) => entry.id === node)
        if (!selected) return
        const raw = input.value
        const patch = {}
        if (type === 'number') {
          const parsed = Number(raw)
          if (Number.isFinite(parsed)) patch[key] = parsed
        } else {
          patch[key] = raw
        }
        state.canvas.update(selected.id, patch)
        refresh()
      })
      row.appendChild(input)
      propFields[key] = input
      props.appendChild(row)
    }
    propRow('X', 'x', 'number')
    propRow('Y', 'y', 'number')
    propRow('Ширина', 'w', 'number')
    propRow('Высота', 'h', 'number')
    propRow('Заливка', 'fill', 'color')
    propRow('Обводка', 'stroke', 'color')
    propRow('Толщина', 'strokeWidth', 'number')
    propRow('Прозрачность', 'opacity', 'number')
    propRow('Радиус', 'radius', 'number')
    propRow('Кегль', 'fontSize', 'number')
    propRow('Нить', 'fontWeight', 'number')
    const align = el('select', 'adz-select')
    ;[['left', 'Слева'], ['center', 'По центру'], ['right', 'Справа']].forEach(([value, label]) => {
      const option = el('option', null, label)
      option.value = value
      align.appendChild(option)
    })
    align.addEventListener('change', () => {
      const selected = state.canvas.doc.nodes.find((entry) => entry.id === state.canvas.selected)
      if (selected) { state.canvas.update(selected.id, { align: align.value }); refresh() }
    })
    const alignRow = el('label', 'adz-prop')
    alignRow.append(el('span', 'adz-prop__label', 'Выравнивание'), align)
    props.appendChild(alignRow)

    const layers = el('div', 'adz-layers')
    layers.appendChild(el('div', 'adz-side-title', 'Слои'))
    const layerList = el('div', 'adz-layer-list')
    layers.appendChild(layerList)

    side.append(props, layers)

    /* composer */
    const composer = el('div', 'adz-ai')
    const aiInput = el('input', 'adz-input adz-ai__input')
    aiInput.type = 'text'
    aiInput.placeholder = 'Нарисуй…'
    const modelSelect = el('select', 'adz-select adz-ai__model')
    const aiButton = el('button', 'adz-btn adz-btn--primary', 'Рисовать')
    const aiStop = el('button', 'adz-btn adz-btn--ghost', 'Отменить', )
    aiStop.style.display = 'none'
    const aiStatus = el('span', 'adz-ai__status', '')
    const agentUndo = el('button', 'adz-btn adz-btn--ghost', 'Отменить правку агента')
    agentUndo.style.display = 'none'
    const aiLeft = el('div', 'adz-ai__left')
    aiLeft.append(aiInput, modelSelect, aiButton, aiStop)
    const aiRight = el('div', 'adz-ai__right')
    aiRight.append(aiStatus, agentUndo)
    composer.append(aiLeft, aiRight)

    const main = el('div', 'adz-main')
    const center = el('div', 'adz-center')
    center.appendChild(canvasHost)
    main.append(toolbar, center, side)
    rootNode.append(header, main, composer)
    document.body.appendChild(rootNode)
    applyTheme(rootNode)

    const state = {
      canvas,
      docId: 'main',
      docs: [],
      models: [],
      model: null,
      loaded: false,
      saveTimer: null,
      saveState: 'saved',
      aiBusy: false,
      agentActive: false,
      suppressChange: false,
      abort: null,
    }

    function setSaveStatus(value) {
      state.saveState = value
      saveState.textContent = value === 'saving' ? 'сохраняю…' : value === 'error' ? 'ошибка сохранения' : 'сохранено'
      saveState.classList.toggle('adz-save--error', value === 'error')
      saveState.classList.toggle('adz-save--busy', value === 'saving')
    }

    function saveNow() {
      if (!state.loaded) return Promise.resolve()
      if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null }
      setSaveStatus('saving')
      return request('POST', '/design/state', { id: state.docId, doc: canvas.getDoc() })
        .then(() => { setSaveStatus('saved'); refreshDocs() })
        .catch((error) => { setSaveStatus('error'); console.warn('design save failed', error) })
    }

    function scheduleSave() {
      if (!state.loaded) return
      setSaveStatus('saving')
      if (state.saveTimer) clearTimeout(state.saveTimer)
      state.saveTimer = setTimeout(() => { saveNow() }, 400)
    }

    function setTool(idValue) {
      canvas.setTool(idValue)
      Object.entries(toolButtons).forEach(([key, button]) => {
        button.classList.toggle('is-on', key === idValue)
      })
    }

    function refreshProps() {
      const selected = canvas.doc.nodes.find((entry) => entry.id === canvas.selected) ?? null
      Object.entries(propFields).forEach(([key, input]) => {
        if (input.type === 'color') {
          input.value = selected && /^#[0-9a-f]{6}$/i.test(selected[key] || '') ? selected[key] : '#000000'
        } else {
          const value = selected ? selected[key] : ''
          input.value = value === undefined || value === null ? '' : String(value)
        }
      })
      align.value = selected?.align ?? 'left'
    }

    function refreshLayers() {
      layerList.textContent = ''
      const nodes = canvas.doc.nodes
      if (nodes.length === 0) {
        layerList.appendChild(el('div', 'adz-layer-empty', 'Пока пусто'))
        return
      }
      nodes.slice().reverse().forEach((node) => {
        const row = el('div', `adz-layer${node.id === canvas.selected ? ' is-on' : ''}`)
        const select = el('button', 'adz-layer__main')
        select.type = 'button'
        select.appendChild(el('span', 'adz-layer__dot', ''))
        select.appendChild(el('span', 'adz-layer__name', node.name || node.type))
        select.addEventListener('click', () => canvas.select(node.id))
        select.addEventListener('dblclick', () => {
          const value = prompt('Название слоя', node.name || '')
          if (value !== null) { canvas.rename(node.id, value); refresh() }
        })
        const actions = el('span', 'adz-layer__actions')
        ;[['up', '↑', 1], ['down', '↓', -1]].forEach(([cls, label, direction]) => {
          const button = el('button', `adz-mini adz-mini--${cls}`, label)
          button.type = 'button'
          button.title = direction === 1 ? 'Выше' : 'Ниже'
          button.addEventListener('click', (event) => { event.stopPropagation(); canvas.reorder(node.id, direction); refresh() })
          actions.appendChild(button)
        })
        const remove = el('button', 'adz-mini adz-mini--delete', '×')
        remove.type = 'button'
        remove.title = 'Удалить слой'
        remove.addEventListener('click', (event) => { event.stopPropagation(); canvas.select(node.id); canvas.deleteSelected(); refresh() })
        actions.appendChild(remove)
        row.append(select, actions)
        layerList.appendChild(row)
      })
    }

    function refreshDocs() {
      request('GET', '/design/docs').then((result) => {
        state.docs = result.docs ?? []
        docSelect.textContent = ''
        state.docs.forEach((doc) => {
          const option = el('option', null, doc.name || doc.id)
          option.value = doc.id
          docSelect.appendChild(option)
        })
        docSelect.value = state.docId
        newDoc.disabled = false
        deleteDoc.disabled = state.docs.length <= 1
      }).catch(() => {})
    }

    function refreshModels() {
      request('GET', '/design/models').then((result) => {
        state.models = result.models ?? []
        const current = state.model
        const counts = {}
        state.models.forEach((model) => { counts[model.name] = (counts[model.name] || 0) + 1 })
        modelSelect.textContent = ''
        state.models.forEach((model) => {
          const label = counts[model.name] > 1 ? `${model.name} � ${model.provider}` : model.name
          const option = el('option', null, label)
          option.value = model.name
          option.dataset.provider = model.provider
          option.dataset.model = model.id
          option.dataset.label = label
          modelSelect.appendChild(option)
        })
        let detected = current || detectModel()
        if (!detected) {
          const names = new Set(state.models.map((model) => model.name))
          const button = [...document.querySelectorAll('button, [role="button"]')]
            .find((node) => names.has((node.textContent || '').trim()))
          detected = button ? (button.textContent || '').trim() : null
        }
        const fallback = detected || state.models.find((m) => m.provider === 'freepi')?.name || ''
        if (fallback) {
          state.model = fallback
          modelSelect.value = fallback
        }
      }).catch(() => {})
    }

    function refresh() {
      refreshProps()
      refreshLayers()
      agentUndo.style.display = state.agentActive ? '' : 'none'
      agentUndo.disabled = !state.agentActive
      canvas.refresh()
    }

    function load(idValue) {
      const target = idValue || state.docId || 'main'
      request('GET', `/design/state?id=${encodeURIComponent(target)}`)
        .then((doc) => {
          state.docId = doc.id || target
          state.loaded = true
          canvas.load(doc)
          state.agentActive = false
          refresh()
          refreshDocs()
        })
        .catch((error) => {
          if (String(error.message) === 'not-found') {
            const ops = root.AndreyDesignOps
            state.docId = target
            state.loaded = true
            canvas.load(ops.emptyDoc(target))
            refresh()
            scheduleSave()
            return
          }
          aiStatus.textContent = `Не удалось открыть документ: ${error.message}`
        })
    }

    function createDoc() {
      const name = prompt('Название документа', 'Новый документ')
      if (!name) return
      request('POST', '/design/docs', { op: 'create', name }).then((result) => {
        const created = (result.docs ?? []).find((doc) => doc.name === name)
        if (created) { state.docId = created.id; load(created.id) }
        refreshDocs()
      }).catch((error) => { aiStatus.textContent = `Ошибка: ${error.message}` })
    }

    function removeDoc() {
      if (state.docs.length <= 1) return
      if (!confirm('Удалить текущий документ?')) return
      const target = state.docId
      request('POST', '/design/docs', { op: 'delete', id: target }).then((result) => {
        state.docs = result.docs ?? []
        const next = state.docs[0]?.id ?? 'main'
        state.docId = next
        load(next)
      }).catch((error) => { aiStatus.textContent = `Ошибка: ${error.message}` })
    }

    function applyAgent(payload) {
      const result = canvas.applyAgentOps(payload.ops ?? [])
      const applied = result.accepted.length
      const rejected = result.rejected.length
      if (applied > 0) {
        state.agentActive = true
        aiStatus.textContent = `Применено фигур: ${applied}`
      } else if (rejected > 0) {
        aiStatus.textContent = `Не применилось: ${result.rejected[0].reason}`
      } else {
        aiStatus.textContent = payload.text ? 'Модель ответила без операций' : 'Пустой ответ'
      }
      if (rejected > 0 && applied > 0) aiStatus.textContent += ` · отклонено ${rejected}`
      if (rejected > 0 && applied === 0) console.warn('design ops rejected', result.rejected)
      refresh()
    }

    function runAgent() {
      const promptText = aiInput.value.trim()
      if (!promptText || state.aiBusy) return
      const option = modelSelect.selectedOptions?.[0]
      const model = option?.value || detectModel() || state.models[0]?.name || ''
      const provider = option?.dataset?.provider || null
      if (!model) { aiStatus.textContent = 'Модель не выбрана'; return }
      state.model = model
      state.aiBusy = true
      state.agentActive = false
      aiButton.disabled = true
      aiStop.style.display = ''
      aiStatus.textContent = 'думает…'
      state.abort = new AbortController()
      const timeout = setTimeout(() => state.abort?.abort(), 300000)
      request('POST', '/design/ai', {
        model,
        provider,
        prompt: promptText,
        doc: canvas.getDoc(),
        canvasSize: canvas.doc.canvas,
      }, state.abort.signal).then((payload) => {
        applyAgent(payload)
        aiInput.value = ''
      }).catch((error) => {
        aiStatus.textContent = `Ошибка: ${error.message}`
      }).finally(() => {
        clearTimeout(timeout)
        state.aiBusy = false
        state.abort = null
        aiButton.disabled = false
        aiStop.style.display = 'none'
      })
    }

    /* events */
    canvas.on('change', () => {
      refresh()
      if (!state.suppressChange) {
        state.agentActive = false
        agentUndo.style.display = 'none'
      }
      scheduleSave()
    })
    canvas.on('select', () => { refreshProps(); refreshLayers() })

    back.addEventListener('click', () => NS.close())
    newDoc.addEventListener('click', createDoc)
    deleteDoc.addEventListener('click', removeDoc)
    docSelect.addEventListener('change', () => { state.docId = docSelect.value; load(docSelect.value) })
    undo.addEventListener('click', () => { canvas.undo(); refresh() })
    redo.addEventListener('click', () => { canvas.redo(); refresh() })
    aiButton.addEventListener('click', runAgent)
    aiStop.addEventListener('click', () => state.abort?.abort())
    agentUndo.addEventListener('click', () => { canvas.undo(); state.agentActive = false; refresh() })
    aiInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); runAgent() }
    })
    modelSelect.addEventListener('change', () => { state.model = modelSelect.value })

    document.addEventListener('keydown', (event) => {
      if (!NS.isOpen()) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        NS.close()
        return
      }
      const inside = event.target instanceof Element && event.target.closest('#' + ROOT_ID)
      if (!inside) return
      const meta = event.ctrlKey || event.metaKey
      if (meta && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); saveNow(); return }
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault(); event.stopPropagation()
        if (event.shiftKey) canvas.redo(); else canvas.undo()
        refresh()
        return
      }
      if (meta && event.key.toLowerCase() === 'd') {
        event.preventDefault(); event.stopPropagation(); canvas.duplicateSelected(); refresh(); return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (event.target && /input|textarea|select/i.test(event.target.tagName)) return
        event.preventDefault(); event.stopPropagation(); canvas.deleteSelected(); refresh(); return
      }
      const map = { v: 'select', h: 'hand', r: 'rect', o: 'ellipse', t: 'text', p: 'pen' }
      const tool = map[event.key.toLowerCase()]
      if (tool && !meta && !/input|textarea|select/i.test(event.target?.tagName ?? '')) {
        event.preventDefault(); event.stopPropagation(); setTool(tool); return
      }
    }, true)

    canvas.canvas.addEventListener('focus', () => canvas.canvas.focus())

    setTool('select')
    refreshModels()
    load(state.docId)

    return { root: rootNode, canvas, load, refresh, saveNow }
  }
})(typeof window !== 'undefined' ? window : globalThis)