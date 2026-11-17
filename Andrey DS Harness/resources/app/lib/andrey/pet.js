// Пэт: сгусток точек, который показывает, чем занят агент.
//
// `ui-inject.cjs` вставляет этот текст в страницу после каждой загрузки, как и
// `ui-renderer.js`, поэтому файл самодостаточен и идемпотентен: один fixed-
// канвас в body, никаких правок их разметки. Состояние берётся из трафика
// страницы (fetch к LLM-маршрутам) и лёгкого опроса DOM; если сигналов нет —
// пэт дышит в idle. Включается и выключается пунктом в меню «…», выбор
// запоминается в localStorage.
;(() => {
  'use strict'

  const ROOT_ID = 'andrey-pet'
  const STYLE_ID = 'andrey-pet-style'
  const MENU_ID = 'andrey-pet-menu-item'
  const ENABLED_KEY = 'andrey-pet-enabled'
  const POS_KEY = 'andrey-pet-pos'
  const FLAG = 'andreyPet'

  if (document.documentElement.dataset[FLAG] === '1') return
  document.documentElement.dataset[FLAG] = '1'

  const SIZE = 96
  const DPR = Math.min(window.devicePixelRatio || 1, 2)
  const COUNT = 210
  const LLM_ROUTE = /\/chat\/completions|api\.freepi\.ai|api\.deepseek\.com|\/freepi\/v1|\/v1\/messages/i

  const LINES = {
    idle: ['на связи', 'тут', 'слежу'],
    working: ['думаю…', 'работаю…', 'считаю…', 'секу…'],
    replying: ['отвечаю…', 'печатаю…', 'формулирую…'],
    waiting: ['нужно разрешение', 'жду ответа', 'подтверди, пожалуйста'],
    celebrate: ['готово!', 'ура!', 'сделано!'],
    error: ['ой, ошибка', 'что-то сломалось'],
  }

  const PALETTES = {
    idle: { dot: '138,168,255', glow: '91,157,255', radius: 26, speed: 0.35 },
    working: { dot: '91,157,255', glow: '91,157,255', radius: 24, speed: 1.4 },
    replying: { dot: '67,214,196', glow: '67,214,196', radius: 27, speed: 0.9 },
    waiting: { dot: '224,161,60', glow: '224,161,60', radius: 25, speed: 0.5 },
    celebrate: { dot: '124,227,139', glow: '124,227,139', radius: 30, speed: 1.1 },
    error: { dot: '224,108,117', glow: '224,108,117', radius: 26, speed: 0.7 },
  }

  const store = {
    get(key, fallback) {
      try {
        const value = localStorage.getItem(key)
        return value === null ? fallback : value
      } catch {
        return fallback
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value)
      } catch {
        /* storage can be denied */
      }
    },
  }

  const pick = (list) => list[Math.floor(Math.random() * list.length)]
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  /* ---- particles ----------------------------------------------------- */

  const points = []
  for (let index = 0; index < COUNT; index += 1) {
    const y = 1 - ((index + 0.5) * 2) / COUNT
    const ring = Math.sqrt(Math.max(0, 1 - y * y))
    const angle = index * Math.PI * (3 - Math.sqrt(5))
    points.push({
      x: Math.cos(angle) * ring,
      y,
      z: Math.sin(angle) * ring,
      phase: Math.random() * Math.PI * 2,
      size: 0.7 + Math.random() * 1.1,
    })
  }

  /* ---- activity signals ---------------------------------------------- */

  const activity = { inflight: 0 }
  let domBusy = 0
  let errorUntil = 0
  let celebrateUntil = 0
  let enabled = store.get(ENABLED_KEY, '1') !== '0'

  const originalFetch = window.fetch
  if (typeof originalFetch === 'function' && window.__andreyPetFetch !== true) {
    window.__andreyPetFetch = true
    window.fetch = function andreyPetFetch(input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? ''
      const call = originalFetch.apply(this, [input, init])
      if (LLM_ROUTE.test(url)) {
        activity.inflight += 1
        call.then((response) => {
          if (!response.ok) errorUntil = performance.now() + 1400
        }, () => {
          errorUntil = performance.now() + 1400
        }).finally(() => {
          activity.inflight = Math.max(0, activity.inflight - 1)
        })
      }
      return call
    }
  }

  const pollDom = () => {
    if (ui === null) return
    let busy = 0
    try {
      if (document.querySelector('[aria-busy="true"], [data-streaming="true"]')) busy |= 1
      for (const button of document.querySelectorAll('button[aria-label], button[title]')) {
        const label = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`
        if (/(stop|cancel|abort|останов|прерв)/i.test(label)) {
          busy |= 2
          break
        }
      }
      for (const dialog of document.querySelectorAll('[role="alertdialog"], [role="dialog"]')) {
        const actions = [...dialog.querySelectorAll('button')]
          .map((button) => button.textContent ?? '')
          .join(' ')
          .slice(0, 2000)
        if (/(allow|deny|approve|permission|разреш|отклон|подтверд|запрет)/i.test(actions)) {
          busy |= 4
          break
        }
      }
    } catch {
      /* their DOM changed under us */
    }
    domBusy = busy
  }

  /* ---- style --------------------------------------------------------- */

  if (document.getElementById(STYLE_ID) === null) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        width: ${SIZE}px;
        height: ${SIZE}px;
        z-index: 2147482000;
        cursor: grab;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
      }
      #${ROOT_ID}:focus-visible {
        outline: 1px solid rgba(128, 128, 128, 0.55);
        outline-offset: 4px;
        border-radius: 50%;
      }
      #${ROOT_ID} canvas {
        display: block;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }
      #${ROOT_ID} .andrey-pet-bubble {
        position: absolute;
        left: 50%;
        bottom: calc(100% + 6px);
        transform: translateX(-50%);
        max-width: 180px;
        padding: 4px 9px;
        border-radius: 10px;
        border: 0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.3));
        background: var(--dsw-alias-bg-raised, rgba(28, 29, 32, 0.94));
        color: var(--dsw-alias-fg-primary, #e8e9ea);
        font: 11px/1.35 var(--dsw-font-sans, Inter, system-ui, sans-serif);
        white-space: nowrap;
        opacity: 0;
        transition: opacity 0.18s ease;
        pointer-events: none;
      }
      #${ROOT_ID} .andrey-pet-bubble[data-show="1"] { opacity: 1; }
    `
    document.head.appendChild(style)
  }

  /* ---- pet window ---------------------------------------------------- */

  let ui = null
  let state = 'idle'
  let stateSince = 0
  let angle = 0
  let lastTick = 0
  let rafId = 0
  let bubbleAt = 0
  let pokeUntil = 0
  let pokeAt = 0

  const setBubble = (text, ms) => {
    if (ui === null) return
    ui.bubble.textContent = text
    ui.bubble.dataset.show = '1'
    bubbleAt = performance.now() + ms
  }

  const announce = (next) => {
    if (next === 'idle') return
    const lines = LINES[next]
    if (lines === undefined) return
    setBubble(pick(lines), next === 'waiting' ? 8000 : 2400)
  }

  const tickBubble = (now) => {
    if (ui === null) return
    if (state === 'waiting') bubbleAt = Math.max(bubbleAt, now + 1200)
    if (ui.bubble.dataset.show === '1' && now > bubbleAt) ui.bubble.dataset.show = '0'
  }

  const activeState = () => {
    if ((domBusy & 4) !== 0) return 'waiting'
    if ((domBusy & 3) !== 0) return 'replying'
    if (activity.inflight > 0) return 'working'
    return null
  }

  const tickState = (now) => {
    if (ui === null) return
    const active = activeState()
    let next = active
    if (next === null) next = now < errorUntil ? 'error' : now < celebrateUntil ? 'celebrate' : 'idle'
    if (next === state) return
    if (active === null && next === 'idle' && (state === 'working' || state === 'replying' || state === 'waiting')) {
      celebrateUntil = now + 1700
      next = 'celebrate'
    }
    state = next
    stateSince = now
    ui.root.dataset.state = state
    announce(state)
  }

  const draw = (now) => {
    if (ui === null) return
    const ctx = ui.ctx
    const palette = PALETTES[state] ?? PALETTES.idle
    const center = SIZE / 2
    const seconds = now / 1000
    const delta = Math.min(0.05, Math.max(0, (now - lastTick) / 1000))
    lastTick = now

    angle += (reduced ? 0.25 : 1) * palette.speed * delta

    ctx.clearRect(0, 0, SIZE, SIZE)

    const glow = ctx.createRadialGradient(center, center, 4, center, center, SIZE * 0.48)
    glow.addColorStop(0, `rgba(${palette.glow},0.16)`)
    glow.addColorStop(1, `rgba(${palette.glow},0)`)
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(center, center, SIZE * 0.48, 0, Math.PI * 2)
    ctx.fill()

    const age = now - stateSince
    let boost = 0
    if (state === 'celebrate') boost = 0.3 * Math.exp(-age / 420)
    if (state === 'error') boost = 0.1 * Math.sin(age / 45)
    if (now < pokeUntil) boost += 0.16 * Math.exp(-(now - pokeAt) / 260)

    const shake = state === 'error' && !reduced ? Math.sin(seconds * 90) * 1.4 : 0
    const cosA = Math.cos(angle)
    const sinA = Math.sin(angle)
    const cosT = Math.cos(0.36)
    const sinT = Math.sin(0.36)
    const rendered = []

    for (const point of points) {
      const rx = point.x * cosA + point.z * sinA
      const rz = -point.x * sinA + point.z * cosA
      const ry = point.y * cosT - rz * sinT
      const depthZ = point.y * sinT + rz * cosT

      let scale = 1 + Math.sin(seconds * 1.5 + point.phase * 0.4) * 0.035
      if (state === 'working') scale += Math.sin(seconds * 5 + point.phase) * 0.05
      if (state === 'replying') scale += Math.sin(seconds * 6 - point.y * 5) * 0.08
      if (state === 'waiting') scale += Math.sin(seconds * 10) > 0 ? 0.05 : -0.02
      scale += boost

      const radius = palette.radius * scale
      const depth = (depthZ + 1) / 2
      rendered.push({
        x: center + rx * radius + shake,
        y: center + ry * radius,
        z: depthZ,
        depth,
        size: point.size * (0.85 + depth * 0.25),
      })
    }

    rendered.sort((left, right) => left.z - right.z)
    for (const dot of rendered) {
      ctx.fillStyle = `rgba(${palette.dot},${(0.22 + dot.depth * 0.72).toFixed(3)})`
      ctx.beginPath()
      ctx.arc(dot.x, dot.y, dot.size, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  const frame = (now) => {
    tickState(now)
    draw(now)
    tickBubble(now)
    rafId = requestAnimationFrame(frame)
  }

  const startLoop = () => {
    if (rafId !== 0) return
    lastTick = performance.now()
    rafId = requestAnimationFrame(frame)
  }

  const stopLoop = () => {
    if (rafId === 0) return
    cancelAnimationFrame(rafId)
    rafId = 0
  }

  /* ---- dragging, position, poke -------------------------------------- */

  const clampTo = (x, y) => {
    const maxX = Math.max(0, window.innerWidth - SIZE)
    const maxY = Math.max(0, window.innerHeight - SIZE)
    return [Math.min(Math.max(0, x), maxX), Math.min(Math.max(0, y), maxY)]
  }

  const placeAt = (x, y) => {
    if (ui === null) return
    const [left, top] = clampTo(x, y)
    ui.root.style.left = `${left}px`
    ui.root.style.top = `${top}px`
    ui.root.style.right = 'auto'
    ui.root.style.bottom = 'auto'
  }

  const restorePos = () => {
    const match = /^(\d{1,5}),(\d{1,5})$/.exec(store.get(POS_KEY, ''))
    if (match !== null) placeAt(Number(match[1]), Number(match[2]))
  }

  const savePos = () => {
    if (ui === null) return
    const rect = ui.root.getBoundingClientRect()
    store.set(POS_KEY, `${Math.round(rect.left)},${Math.round(rect.top)}`)
  }

  const resetPos = () => {
    if (ui === null) return
    store.set(POS_KEY, '')
    ui.root.style.left = 'auto'
    ui.root.style.top = 'auto'
    ui.root.style.right = '18px'
    ui.root.style.bottom = '18px'
  }

  const poke = () => {
    const now = performance.now()
    if (now < pokeUntil - 350) return
    pokeAt = now
    pokeUntil = now + 700
    setBubble(pick(LINES.idle), 1500)
  }

  let drag = null

  const bind = () => {
    const root = ui.root

    root.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      const rect = root.getBoundingClientRect()
      drag = {
        id: event.pointerId,
        ox: event.clientX,
        oy: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false,
      }
      try {
        root.setPointerCapture(event.pointerId)
      } catch {
        /* older Chromium */
      }
      try {
        root.focus({ preventScroll: true })
      } catch {
        /* focus is optional */
      }
      root.style.cursor = 'grabbing'
    })

    root.addEventListener('pointermove', (event) => {
      if (drag === null || event.pointerId !== drag.id) return
      const dx = event.clientX - drag.ox
      const dy = event.clientY - drag.oy
      if (!drag.moved && dx * dx + dy * dy < 16) return
      drag.moved = true
      placeAt(drag.left + dx, drag.top + dy)
    })

    const release = (event, allowPoke) => {
      if (drag === null || event.pointerId !== drag.id) return
      const moved = drag.moved
      drag = null
      root.style.cursor = 'grab'
      if (moved) savePos()
      else if (allowPoke) poke()
    }

    root.addEventListener('pointerup', (event) => release(event, true))
    root.addEventListener('pointercancel', (event) => release(event, false))
    root.addEventListener('dblclick', resetPos)
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      poke()
    })
  }

  /* ---- enable / disable ---------------------------------------------- */

  const build = () => {
    if (ui !== null) return
    const root = document.createElement('div')
    root.id = ROOT_ID
    root.dataset.state = 'idle'
    root.setAttribute('role', 'button')
    root.setAttribute('aria-label', 'Пэт')
    root.tabIndex = 0

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(SIZE * DPR)
    canvas.height = Math.round(SIZE * DPR)
    canvas.setAttribute('aria-hidden', 'true')

    const bubble = document.createElement('div')
    bubble.className = 'andrey-pet-bubble'
    bubble.setAttribute('aria-live', 'polite')

    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)

    root.append(canvas, bubble)
    document.body.appendChild(root)

    ui = { root, canvas, bubble, ctx }
    state = 'idle'
    stateSince = performance.now()
    angle = 0
    restorePos()
    bind()
    startLoop()
    setBubble('привет!', 1600)
  }

  const destroy = () => {
    stopLoop()
    if (ui !== null) ui.root.remove()
    ui = null
    drag = null
    state = 'idle'
    domBusy = 0
  }

  /* ---- menu entry ---------------------------------------------------- */

  const ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    + '<circle cx="8" cy="8" r="1.7" fill="currentColor"/>'
    + '<circle cx="4.3" cy="5.9" r="1.1" fill="currentColor" opacity=".8"/>'
    + '<circle cx="11.7" cy="5.9" r="1.1" fill="currentColor" opacity=".8"/>'
    + '<circle cx="5.5" cy="11.1" r="1" fill="currentColor" opacity=".7"/>'
    + '<circle cx="10.9" cy="10.9" r="1.2" fill="currentColor" opacity=".7"/>'
    + '</svg>'

  const findMoreMenu = () => {
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      const items = menu.querySelectorAll('[role="menuitem"]')
      for (const item of items) {
        if (/settings|настрой/i.test(item.textContent ?? '')) return menu
      }
    }
    return null
  }

  const labelItem = (item) => {
    const label = item.querySelector('.andrey-pet-label')
    if (label !== null) label.textContent = enabled ? 'Скрыть пэта' : 'Показать пэта'
    item.title = enabled ? 'Пэт включён' : 'Пэт выключен'
  }

  const toggle = () => {
    enabled = !enabled
    store.set(ENABLED_KEY, enabled ? '1' : '0')
    if (enabled) build()
    else destroy()
    const item = document.getElementById(MENU_ID)
    if (item !== null) labelItem(item)
  }

  const placeMenuItem = () => {
    if (document.getElementById(MENU_ID) !== null) return true
    const menu = findMoreMenu()
    if (menu === null) return false

    const item = document.createElement('button')
    item.id = MENU_ID
    item.type = 'button'
    item.setAttribute('role', 'menuitem')
    item.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left'
    item.innerHTML = `${ICON}<span class="andrey-pet-label"></span>`
    labelItem(item)
    item.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      for (const type of ['keydown']) {
        document.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', bubbles: true }))
      }
      toggle()
    }, true)
    menu.appendChild(item)
    return true
  }

  let menuRaf = 0
  const queueMenu = () => {
    if (menuRaf !== 0) return
    menuRaf = requestAnimationFrame(() => {
      menuRaf = 0
      placeMenuItem()
    })
  }

  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(queueMenu)
    observer.observe(document.body, { childList: true, subtree: true })
  }

  setInterval(pollDom, 600)

  document.addEventListener('visibilitychange', () => {
    if (ui === null) return
    if (document.visibilityState === 'hidden') stopLoop()
    else startLoop()
  })

  window.addEventListener('resize', () => {
    if (ui === null) return
    if (ui.root.style.left === 'auto' || ui.root.style.left === '') return
    const rect = ui.root.getBoundingClientRect()
    placeAt(rect.left, rect.top)
  })

  if (enabled) build()
  placeMenuItem()
})()
