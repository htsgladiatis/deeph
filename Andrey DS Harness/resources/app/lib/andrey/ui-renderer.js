// Renderer-side additions for the copied DeepSeek Harness.
//
// This file is not loaded as a module: `ui-inject.cjs` reads it and passes the
// text to `webContents.executeJavaScript`, so it must be a self-contained script
// that runs once per page load. Everything it adds is marked with `data-andrey`
// or a known id, is purely additive, and never rewrites their markup.
;(() => {
  const VERSION_LABEL = 'Andrey Version 0.5.1'
  const STYLE_ID = 'andrey-extra-style'
  const BADGE_ID = 'andrey-version-badge'
  const LIMITS_ID = 'andrey-limits'
  const LIMITS_URL = 'http://127.0.0.1:39147/limits'

  /* ---- styles -------------------------------------------------------- */

  if (document.getElementById(STYLE_ID) === null) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = `
      #${BADGE_ID} {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 12px 6px;
        font-size: 10px;
        line-height: 14px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--dsw-alias-fg-secondary, rgba(128,128,128,0.9));
        opacity: 0.75;
        user-select: none;
        pointer-events: none;
        white-space: nowrap;
      }
      #${BADGE_ID}::before {
        content: "";
        width: 14px;
        height: 1px;
        background: currentColor;
        opacity: 0.5;
      }
      #${LIMITS_ID} {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        height: 22px;
        padding: 0 9px;
        margin-left: 6px;
        border-radius: 999px;
        border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25));
        background: var(--dsw-specific-fill-quiet, rgba(128,128,128,0.08));
        font-size: 11px;
        line-height: 1;
        font-variant-numeric: tabular-nums;
        color: var(--dsw-alias-fg-secondary, rgba(128,128,128,0.95));
        white-space: nowrap;
        cursor: default;
        user-select: none;
      }
      #${LIMITS_ID} .andrey-limits__group {
        display: inline-flex;
        align-items: baseline;
        gap: 4px;
      }
      #${LIMITS_ID} .andrey-limits__name {
        opacity: 0.7;
        font-size: 10px;
        letter-spacing: 0.02em;
      }
      #${LIMITS_ID} .andrey-limits__value { font-weight: 600; }
      #${LIMITS_ID} .andrey-limits__sep {
        width: 1px;
        height: 11px;
        background: currentColor;
        opacity: 0.25;
      }
      #${LIMITS_ID}[data-low="1"] { color: var(--dsw-alias-warn-fg, #d08a2c); }

      /* Provider groups in the model menu. Their rows already carry
         data-provider-id; the heading only needs a colour and a dot. */
      [data-menu-group][data-andrey-provider] [data-menu-group-heading] {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      [data-menu-group][data-andrey-provider="freepi"] [data-menu-group-heading] { color: var(--andrey-freepi, #5b9dff); }
      [data-menu-group][data-andrey-provider="freebuff"] [data-menu-group-heading] { color: var(--andrey-freebuff, #e08b3c); }
      [data-menu-group][data-andrey-provider] [data-menu-group-heading]::before {
        content: "";
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
        opacity: 0.9;
      }
      [data-andrey-provider="freepi"] button[role="menuitemradio"] { box-shadow: inset 2px 0 0 -1px var(--andrey-freepi, #5b9dff); }
      [data-andrey-provider="freebuff"] button[role="menuitemradio"] { box-shadow: inset 2px 0 0 -1px var(--andrey-freebuff, #e08b3c); }
      .andrey-group-limits {
        margin-left: 2px;
        font-size: 10px;
        font-weight: 400;
        opacity: 0.65;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      /* ---- accounts panel ------------------------------------------- */

      #andrey-accounts-backdrop {
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.45);
        backdrop-filter: blur(2px);
      }
      #andrey-accounts {
        width: min(620px, calc(100vw - 48px));
        max-height: min(560px, calc(100vh - 64px));
        overflow: auto;
        border-radius: 14px;
        border: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3));
        background: var(--dsw-alias-bg-raised, #1c1d20);
        color: var(--dsw-alias-fg-primary, #e8e9ea);
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
        font-size: 13px;
      }
      #andrey-accounts .aa-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px 10px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.22));
      }
      #andrey-accounts .aa-title { font-size: 15px; font-weight: 600; }
      #andrey-accounts .aa-sub { font-size: 11px; opacity: 0.6; margin-top: 2px; }
      #andrey-accounts .aa-close {
        border: 0;
        background: transparent;
        color: inherit;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
        opacity: 0.6;
        padding: 4px 8px;
        border-radius: 8px;
      }
      #andrey-accounts .aa-close:hover { opacity: 1; background: rgba(128,128,128,0.15); }
      #andrey-accounts .aa-provider { padding: 10px 16px 14px; }
      #andrey-accounts .aa-provider + .aa-provider { border-top: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.18)); }
      #andrey-accounts .aa-provider-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 2px 0 8px;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.02em;
      }
      #andrey-accounts .aa-dot { width: 7px; height: 7px; border-radius: 50%; }
      #andrey-accounts .aa-provider[data-provider="pi"] .aa-dot { background: var(--andrey-freepi, #5b9dff); }
      #andrey-accounts .aa-provider[data-provider="freebuff"] .aa-dot { background: var(--andrey-freebuff, #e08b3c); }
      #andrey-accounts .aa-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 7px 8px;
        border-radius: 9px;
      }
      #andrey-accounts .aa-row:hover { background: rgba(128,128,128,0.09); }
      #andrey-accounts .aa-row[data-active="1"] { background: rgba(91,157,255,0.10); }
      #andrey-accounts .aa-who { flex: 1; min-width: 0; }
      #andrey-accounts .aa-label { font-weight: 600; }
      #andrey-accounts .aa-meta { font-size: 11px; opacity: 0.62; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #andrey-accounts .aa-badge {
        font-size: 10px;
        padding: 2px 7px;
        border-radius: 999px;
        border: 0.5px solid currentColor;
        opacity: 0.85;
        white-space: nowrap;
      }
      #andrey-accounts button.aa-act {
        border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.3));
        background: transparent;
        color: inherit;
        font-size: 11px;
        padding: 4px 9px;
        border-radius: 8px;
        cursor: pointer;
        white-space: nowrap;
      }
      #andrey-accounts button.aa-act:hover { background: rgba(128,128,128,0.15); }
      #andrey-accounts button.aa-act[disabled] { opacity: 0.4; cursor: default; }
      #andrey-accounts .aa-add { display: flex; gap: 8px; margin-top: 8px; }
      #andrey-accounts .aa-note {
        margin-top: 8px;
        padding: 9px 10px;
        border-radius: 9px;
        background: rgba(91,157,255,0.12);
        font-size: 11.5px;
        line-height: 1.45;
        word-break: break-all;
      }
      #andrey-accounts .aa-note a { color: inherit; font-weight: 600; }
      .andrey-menu-item-label { display: inline-flex; align-items: center; gap: 6px; }

      /* ---- freePi ad banner ------------------------------------------ */

      /* The free tier is paid for by ads that are actually displayed, so this
         has to be a real, visible strip: the impression is posted only after
         the element measures as shown (see placeAd). */
      #andrey-ad {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        height: 18px;
        margin: 0;
        padding: 0 10px;
        border: 0;
        border-bottom: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.22));
        border-radius: 0;
        background: var(--dsw-specific-fill-quiet, rgba(128,128,128,0.06));
        font-size: 10px;
        line-height: 12px;
        color: var(--dsw-alias-fg-secondary, rgba(128,128,128,0.95));
        overflow: hidden;
      }
      #andrey-ad .andrey-ad__text { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 7px; }
      #andrey-ad .andrey-ad__headline {
        flex: none;
        font-weight: 600;
        color: var(--dsw-alias-fg-primary, inherit);
        white-space: nowrap;
        max-width: 55%;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #andrey-ad .andrey-ad__body { opacity: 0.78; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #andrey-ad .andrey-ad__cta {
        flex: none;
        font-size: 9.5px;
        font-weight: 600;
        text-decoration: none;
        color: inherit;
        border: 0.5px solid currentColor;
        border-radius: 999px;
        padding: 0 6px;
        line-height: 13px;
        white-space: nowrap;
        opacity: 0.8;
      }
      #andrey-ad .andrey-ad__cta:hover { opacity: 1; }
      #andrey-ad .andrey-ad__brand {
        flex: none;
        font-size: 9px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        opacity: 0.45;
        white-space: nowrap;
      }
    `
    document.head.appendChild(style)
  }

  /* ---- provider groups in the model menu ----------------------------- */

  const PROVIDER_LABELS = { freepi: 'freePi', freebuff: 'Freebuff' }

  /**
   * Tag each model-menu group with the provider its rows belong to.
   *
   * Their rows already carry `data-provider-id`; the group heading (a plain div
   * holding the provider's display name) carries nothing, so the CSS cannot
   * colour it without this mark.
   */
  const markProviders = () => {
    let touched = 0
    for (const group of document.querySelectorAll('[data-menu-group]')) {
      if (group.dataset.andreyProvider !== undefined) {
        updateGroupLimits(group)
        continue
      }
      const row = group.querySelector('[data-provider-id]')
      const provider = row?.getAttribute('data-provider-id') ?? ''
      if (provider === '') continue
      group.dataset.andreyProvider = provider
      updateGroupLimits(group)
      touched += 1
    }
    return touched
  }

  /** Show the provider's remaining allowance beside its menu heading. */
  function updateGroupLimits(group) {
    const provider = group.dataset.andreyProvider
    const heading = group.querySelector('[data-menu-group-heading]')
    if (heading === null) return
    const data = provider === 'freepi' ? lastLimits?.pi : provider === 'freebuff' ? lastLimits?.freebuff : null
    const existing = heading.querySelector('.andrey-group-limits')
    if (data === null || data === undefined || data.ok !== true || typeof data.remaining !== 'number') {
      existing?.remove()
      return
    }
    const text = data.allowance === null || data.allowance === undefined
      ? formatNumber(data.remaining)
      : `${formatNumber(data.remaining)} / ${formatNumber(data.allowance)}`
    if (existing !== null && existing.textContent === text) return
    const span = existing ?? document.createElement('span')
    span.className = 'andrey-group-limits'
    span.textContent = text
    span.title = `${PROVIDER_LABELS[provider] ?? provider}: осталось ${text} сегодня`
    if (existing === null) heading.appendChild(span)
  }

  /* ---- version caption under the logo -------------------------------- */

  /** The sidebar's logo row: the drag strip that holds the mark and the wordmark. */
  const findLogoRow = () => {
    for (const row of document.querySelectorAll('div[data-window-drag]')) {
      if (row.querySelector('svg') !== null) return row
    }
    return null
  }

  const placeBadge = () => {
    const row = findLogoRow()
    if (row === null) return false
    const current = document.getElementById(BADGE_ID)
    if (current !== null && current.previousElementSibling === row) return true
    if (current !== null) current.remove()
    const badge = document.createElement('div')
    badge.id = BADGE_ID
    badge.textContent = VERSION_LABEL
    badge.title = VERSION_LABEL
    row.insertAdjacentElement('afterend', badge)
    return true
  }

  /* ---- limits plate -------------------------------------------------- */

  // Their React tree re-renders the composer and drops nodes it does not own,
  // so the plate can disappear and come back empty. Remembering the last
  // snapshot lets a re-attached plate paint immediately instead of waiting for
  // the next minute's refresh.
  let lastLimits = null

  const formatNumber = (value) => (typeof value === 'number' ? value.toLocaleString('ru-RU') : '?')

  const formatReset = (iso) => {
    if (typeof iso !== 'string' || iso === '') return ''
    const when = new Date(iso)
    if (Number.isNaN(when.getTime())) return ''
    return when.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  }

  /** The composer's stat strip: the dock that carries the context percentage. */
  const findDock = () => document.querySelector('[data-composer-dock]')

  /** Anchor for the plate: the context-percentage control, so we sit to its right. */
  const findContextAnchor = () => {
    const button = document.querySelector('[aria-label$="of context used"]')
    if (button === null) return null
    return button.parentElement ?? button
  }

  const limitsGroup = (name, data, unit) => {
    const group = document.createElement('span')
    group.className = 'andrey-limits__group'

    const label = document.createElement('span')
    label.className = 'andrey-limits__name'
    label.textContent = name

    const value = document.createElement('span')
    value.className = 'andrey-limits__value'
    if (data?.ok === true) {
      value.textContent = typeof data.remaining === 'number' ? formatNumber(data.remaining) : '?'
      group.title = [
        typeof data.remaining === 'number' && typeof data.allowance === 'number'
          ? `${name}: ${formatNumber(data.remaining)} из ${formatNumber(data.allowance)} ${unit} сегодня`
          : `${name}: остаток неизвестен`,
        data.resetAt ? `сброс в ${formatReset(data.resetAt)}` : '',
        data.tier ? `план: ${data.tier}` : '',
        typeof data.balance === 'number' ? `баланс: ${formatNumber(data.balance)}` : '',
        data.account ? `аккаунт: ${data.label ?? data.account}` : '',
      ].filter(Boolean).join(' · ')
    } else {
      value.textContent = '—'
      group.title = `${name}: ${data?.error ?? 'нет данных'}`
    }

    group.append(label, value)
    return group
  }

  const renderLimits = (payload) => {
    lastLimits = payload
    const plate = document.getElementById(LIMITS_ID)
    if (plate === null) return
    plate.replaceChildren()
    plate.appendChild(limitsGroup('freePi', payload?.pi, 'кредитов'))
    const sep = document.createElement('span')
    sep.className = 'andrey-limits__sep'
    plate.appendChild(sep)
    plate.appendChild(limitsGroup('FB', payload?.freebuff, 'фрибаксов'))

    const low = [payload?.pi, payload?.freebuff].some((data) =>
      data?.ok === true
      && typeof data.remaining === 'number'
      && typeof data.allowance === 'number'
      && data.allowance > 0
      && data.remaining / data.allowance < 0.15)
    plate.dataset.low = low ? '1' : '0'
    plate.dataset.loaded = '1'
    // Menu headings show the same numbers; repaint them from the new snapshot.
    for (const group of document.querySelectorAll('[data-menu-group][data-andrey-provider]')) updateGroupLimits(group)
  }

  const placeLimits = () => {
    const dock = findDock()
    if (dock === null) return false
    let plate = document.getElementById(LIMITS_ID)
    if (plate === null) {
      plate = document.createElement('span')
      plate.id = LIMITS_ID
      if (lastLimits === null) plate.textContent = 'freePi — · FB —'
    }
    const anchor = findContextAnchor()
    if (plate.parentElement !== dock) {
      if (anchor === null) dock.appendChild(plate)
      else anchor.insertAdjacentElement('afterend', plate)
    } else if (anchor !== null && plate.previousElementSibling !== anchor) {
      anchor.insertAdjacentElement('afterend', plate)
    }
    // A fresh plate (or one their render emptied) is repainted from memory.
    if (lastLimits !== null && plate.dataset.loaded !== '1') renderLimits(lastLimits)
    return true
  }

  const refreshLimits = () => {
    fetch(LIMITS_URL, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => {
        if (payload === null) return
        renderLimits(payload)
        // A cold start can time one provider out; a minute of dashes is too long
        // to look at, so an incomplete snapshot is retried on its own.
        const incomplete = [payload.pi, payload.freebuff].some((data) => data?.ok !== true)
        if (incomplete && document.documentElement.dataset.andreyLimitsRetry !== '1') {
          document.documentElement.dataset.andreyLimitsRetry = '1'
          setTimeout(() => {
            delete document.documentElement.dataset.andreyLimitsRetry
            refreshLimits()
          }, 12_000)
        }
      })
      .catch(() => {})
  }

  const startLimits = () => {
    if (document.documentElement.dataset.andreyLimits === '1') return
    document.documentElement.dataset.andreyLimits = '1'
    refreshLimits()
    setInterval(refreshLimits, 60_000)
  }

  /* ---- "More" menu: Accounts entry ---------------------------------- */

  const MENU_ITEM_ID = 'andrey-accounts-menu-item'
  const ACCOUNTS_URL = 'http://127.0.0.1:39147/accounts'

  /** The sidebar's overflow menu: the one that holds their Settings item. */
  const findMoreMenu = () => {
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      const labels = [...menu.querySelectorAll('[role="menuitem"]')].map((item) => (item.textContent || '').trim())
      if (labels.some((label) => label.startsWith('Settings'))) return menu
    }
    return null
  }

  const closeMenus = () => {
    for (const type of ['keydown']) {
      document.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', bubbles: true }))
    }
  }

  /**
   * Put our entry first in that menu.
   *
   * The item is a clone of their own first row, so it inherits the exact hover,
   * focus, spacing and typography of the menu it lives in; only the label, the
   * icon and the handler are ours.
   */
  const placeMenuItem = () => {
    const menu = findMoreMenu()
    if (menu === null) return false
    if (document.getElementById(MENU_ITEM_ID) !== null) return true

    const first = menu.querySelector('[role="menuitem"]')
    if (first === null) return false
    const row = first.parentElement ?? first
    const container = row.parentElement ?? menu
    const clone = row.cloneNode(true)
    clone.id = MENU_ITEM_ID
    clone.querySelectorAll('[class*="_shortcut"], [class*="_keys"]').forEach((node) => node.remove())

    const button = clone.querySelector('[role="menuitem"]') ?? clone
    button.removeAttribute('aria-keyshortcuts')

    const icon = clone.querySelector('[class*="_itemIcon"]')
    if (icon !== null) {
      icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
        + '<circle cx="8" cy="5.4" r="2.6" stroke="currentColor" stroke-width="1.3"/>'
        + '<path d="M3.2 13c0-2.2 2.1-3.6 4.8-3.6s4.8 1.4 4.8 3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
        + '</svg>'
    }
    const label = clone.querySelector('[class*="_itemLabel"]')
    if (label !== null) label.textContent = 'Аккаунты'

    clone.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      closeMenus()
      openAccounts()
    }, true)

    container.insertBefore(clone, row)
    return true
  }

  /* ---- accounts panel -------------------------------------------------- */

  let accountsPoll = null
  let accountsBusy = false

  const providersInfo = {
    pi: { label: 'freePi', addLabel: 'Добавить freePi' },
    freebuff: { label: 'Freebuff', addLabel: 'Добавить Freebuff' },
  }

  const accountsRequest = (path, body) => fetch(ACCOUNTS_URL + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  }).then((res) => res.json()).catch((error) => ({ ok: false, error: String(error?.message ?? error) }))

  const accountRow = (provider, account, pendingFlow) => {
    const row = document.createElement('div')
    row.className = 'aa-row'
    row.dataset.active = account.active ? '1' : '0'

    const who = document.createElement('div')
    who.className = 'aa-who'
    const label = document.createElement('div')
    label.className = 'aa-label'
    label.textContent = account.label
    const meta = document.createElement('div')
    meta.className = 'aa-meta'
    const state = pendingFlow?.accountId === account.id
      ? (pendingFlow.state === 'waiting' ? 'ждём подтверждения в браузере…' : `ошибка входа: ${pendingFlow.error ?? ''}`)
      : account.loggedIn ? (account.email ?? 'вход выполнен') : 'нет токена'
    meta.textContent = `${state} · ${account.id}`
    who.append(label, meta)

    const badge = document.createElement('span')
    badge.className = 'aa-badge'
    badge.textContent = account.active ? 'активен' : ''
    badge.style.visibility = account.active ? 'visible' : 'hidden'

    row.append(who, badge)

    if (!account.active) {
      const use = document.createElement('button')
      use.className = 'aa-act'
      use.type = 'button'
      use.textContent = 'Сделать активным'
      use.onclick = () => act({ path: '/switch', provider, id: account.id })
      row.appendChild(use)
    }

    const login = document.createElement('button')
    login.className = 'aa-act'
    login.type = 'button'
    login.textContent = account.loggedIn ? 'Войти заново' : 'Войти'
    login.onclick = () => act({ path: '/login', provider, id: account.id })
    row.appendChild(login)

    if (!account.active) {
      const remove = document.createElement('button')
      remove.className = 'aa-act'
      remove.type = 'button'
      remove.textContent = 'Убрать'
      remove.onclick = () => act({ path: '/remove', provider, id: account.id })
      row.appendChild(remove)
    }

    return row
  }

  const renderAccounts = (data) => {
    const panel = document.getElementById('andrey-accounts')
    if (panel === null) return
    const body = panel.querySelector('.aa-body')
    if (body === null) return
    body.replaceChildren()

    if (data === null || typeof data !== 'object' || data.error !== undefined) {
      const note = document.createElement('div')
      note.className = 'aa-note'
      note.textContent = `Не удалось получить список аккаунтов: ${data?.error ?? 'нет ответа от локального маршрута'}`
      body.appendChild(note)
      return
    }

    for (const provider of ['pi', 'freebuff']) {
      const info = providersInfo[provider]
      const section = document.createElement('div')
      section.className = 'aa-provider'
      section.dataset.provider = provider

      const head = document.createElement('div')
      head.className = 'aa-provider-head'
      const dot = document.createElement('span')
      dot.className = 'aa-dot'
      const name = document.createElement('span')
      name.textContent = info.label
      head.append(dot, name)
      section.appendChild(head)

      const accounts = Array.isArray(data[provider]) ? data[provider] : []
      for (const account of accounts) {
        section.appendChild(accountRow(provider, account, data.pending?.[provider]))
      }

      const add = document.createElement('button')
      add.className = 'aa-act'
      add.type = 'button'
      add.textContent = info.addLabel
      add.onclick = () => act({ path: '/add', provider })
      const actions = document.createElement('div')
      actions.className = 'aa-add'
      actions.appendChild(add)
      section.appendChild(actions)

      const flow = data.pending?.[provider]
      if (flow !== undefined) {
        const note = document.createElement('div')
        note.className = 'aa-note'
        if (flow.state === 'waiting') {
          note.append('Подтверди вход в браузере: ')
          const link = document.createElement('a')
          link.href = flow.url
          link.target = '_blank'
          link.rel = 'noreferrer'
          link.textContent = 'открыть ссылку'
          note.appendChild(link)
          note.append(` — ${flow.url}`)
        } else {
          note.textContent = `Вход не удался: ${flow.error ?? 'неизвестная ошибка'}`
        }
        section.appendChild(note)
      }

      body.appendChild(section)
    }
  }

  const refreshAccounts = () => {
    if (document.getElementById('andrey-accounts') === null) return
    accountsRequest('').then(renderAccounts)
  }

  const act = (action) => {
    if (accountsBusy) return
    accountsBusy = true
    accountsRequest(action.path, { provider: action.provider, id: action.id })
      .then((result) => {
        accountsBusy = false
        refreshAccounts()
        if (result?.needsRestart === true) {
          const panel = document.getElementById('andrey-accounts')
          const note = document.createElement('div')
          note.className = 'aa-note'
          note.textContent = 'Аккаунт freePi переключён — применится со следующего сообщения, перезапуск не нужен.'
          panel?.querySelector('.aa-body')?.prepend(note)
        }
      })
      .catch(() => { accountsBusy = false })
  }

  function openAccounts() {
    if (document.getElementById('andrey-accounts-backdrop') !== null) {
      refreshAccounts()
      return
    }

    const backdrop = document.createElement('div')
    backdrop.id = 'andrey-accounts-backdrop'
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) closeAccounts()
    })

    const panel = document.createElement('div')
    panel.id = 'andrey-accounts'

    const head = document.createElement('div')
    head.className = 'aa-head'
    const titles = document.createElement('div')
    const title = document.createElement('div')
    title.className = 'aa-title'
    title.textContent = 'Аккаунты'
    const sub = document.createElement('div')
    sub.className = 'aa-sub'
    sub.textContent = 'freePi и Freebuff · у каждого аккаунта свой токен'
    titles.append(title, sub)
    const close = document.createElement('button')
    close.className = 'aa-close'
    close.type = 'button'
    close.textContent = '×'
    close.title = 'Закрыть'
    close.onclick = closeAccounts
    head.append(titles, close)

    const body = document.createElement('div')
    body.className = 'aa-body'
    body.style.padding = '4px 0 8px'

    panel.append(head, body)
    backdrop.appendChild(panel)
    document.body.appendChild(backdrop)

    refreshAccounts()
    accountsPoll = setInterval(refreshAccounts, 2500)
  }

  function closeAccounts() {
    if (accountsPoll !== null) {
      clearInterval(accountsPoll)
      accountsPoll = null
    }
    document.getElementById('andrey-accounts-backdrop')?.remove()
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAccounts()
  })

  /* ---- freePi ad banner ---------------------------------------------- */

  // The chat itself goes straight to api.freepi.ai, so the route only serves
  // the creative: /ads/next returns one (or null), and /ads/impression accepts
  // a view the banner has actually measured. Reporting an impression without a
  // rendered, visible banner would be a lie the provider is paying for, so the
  // viewability check below is the only path to it.
  const AD_ID = 'andrey-ad'
  const ADS_NEXT_URL = 'http://127.0.0.1:39147/ads/next'
  const ADS_IMPRESSION_URL = 'http://127.0.0.1:39147/ads/impression'

  let currentAd = null
  const reportedAds = new Set()

  const buildAd = (ad) => {
    const node = document.createElement('div')
    node.id = AD_ID
    node.dataset.andreyAd = ad.ad_id
    node.title = 'Реклама: бесплатный тариф freePi оплачивается показами'

    const text = document.createElement('div')
    text.className = 'andrey-ad__text'
    const headline = document.createElement('div')
    headline.className = 'andrey-ad__headline'
    headline.textContent = ad.creative.headline
    text.appendChild(headline)
    if (ad.creative.body) {
      const body = document.createElement('div')
      body.className = 'andrey-ad__body'
      body.textContent = ad.creative.body
      text.appendChild(body)
    }

    const link = document.createElement('a')
    link.className = 'andrey-ad__cta'
    link.href = ad.click_url
    link.target = '_blank'
    link.rel = 'noreferrer noopener'
    link.textContent = ad.creative.cta || 'Подробнее'

    const brand = document.createElement('span')
    brand.className = 'andrey-ad__brand'
    brand.textContent = ad.creative.brand_name || 'Реклама'

    node.append(text, brand, link)
    return node
  }

  /**
   * The conversation pane, directly above its header.
   *
   * That header is the `header[data-window-drag]` whose title row carries the
   * "Creator mode" chip, so inserting before it puts the strip at the very top
   * of the app's content area — and outside the drag region, so the link stays
   * clickable.
   */
  const findTopHost = () => document.querySelector('header[data-window-drag]')?.parentElement ?? null

  /**
   * A view counts only if the banner is really on screen: at least 40x16 CSS
   * pixels and intersecting the viewport. Their React tree can drop the node,
   * so the check runs again whenever the banner is re-attached.
   */
  const reportAdIfVisible = () => {
    const ad = currentAd
    const node = document.getElementById(AD_ID)
    if (ad === null || node === null || reportedAds.has(ad.click_token)) return
    const rect = node.getBoundingClientRect()
    const visible = rect.width >= 40 && rect.height >= 16 && rect.bottom > 0 && rect.top < window.innerHeight
    if (!visible) return

    reportedAds.add(ad.click_token)
    fetch(ADS_IMPRESSION_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ad_id: ad.ad_id, click_token: ad.click_token, source: ad.source, imp_url: ad.imp_url }),
      cache: 'no-store',
    }).catch(() => { reportedAds.delete(ad.click_token) })
  }

  const requestAd = (trigger) => {
    const url = `${ADS_NEXT_URL}?slot=banner&trigger=${encodeURIComponent(trigger)}`
    fetch(url, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => {
        const ad = payload?.ad ?? null
        if (ad === null) {
          currentAd = null
          document.getElementById(AD_ID)?.remove()
          return
        }
        if (currentAd !== null && currentAd.click_token === ad.click_token) return
        currentAd = ad
        const existing = document.getElementById(AD_ID)
        if (existing !== null) existing.replaceWith(buildAd(ad))
        else placeAd()
        reportAdIfVisible()
      })
      .catch(() => {})
  }

  /** Keep the strip first in the conversation pane; nothing else moves. */
  const placeAd = () => {
    const host = findTopHost()
    if (host === null || currentAd === null) return false
    const existing = document.getElementById(AD_ID)
    if (existing === null) host.insertBefore(buildAd(currentAd), host.firstElementChild ?? null)
    else if (host.firstElementChild !== existing) host.insertBefore(existing, host.firstElementChild ?? null)
    reportAdIfVisible()
    return true
  }

  const startAds = () => {
    if (document.documentElement.dataset.andreyAds === '1') return
    document.documentElement.dataset.andreyAds = '1'
    requestAd('launch')
    // A creative is per view, not per session: keep one on screen while the
    // account stays on the free tier.
    setInterval(() => requestAd('launch'), 180_000)
    window.addEventListener('scroll', reportAdIfVisible, { passive: true })
    window.addEventListener('resize', reportAdIfVisible, { passive: true })
    // Each prompt is a new ad opportunity, exactly like free-pi's own client.
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (!target.closest('textarea, [contenteditable="true"]')) return
      requestAd('user_message')
    }, true)
  }

  /* ---- keep everything attached across their re-renders -------------- */

  if (!document.documentElement.dataset.andreyObserver) {
    document.documentElement.dataset.andreyObserver = '1'
    const observer = new MutationObserver(() => {
      placeBadge()
      placeLimits()
      markProviders()
      placeMenuItem()
      placeAd()
      placeDesignItem()
      placeHandoffItem()
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      event.stopPropagation()
      if (window.AndreyDesign) window.AndreyDesign.toggle()
    }
  }, true)

  function findDesignMenu() {
    const menus = [...document.querySelectorAll('[role="menu"]')]
    if (menus.length === 0) return null
    for (const menu of menus) {
      const classes = typeof menu.className === 'string' ? menu.className : ''
      if (classes.includes('moreMenu') || menu.closest('[class*="moreMenu"]') !== null) return menu
    }
    // Class hashes change between builds, so fall back to geometry: the More
    // menu opens next to the sidebar's own launcher, not in the content area.
    for (const button of document.querySelectorAll('nav button[aria-haspopup="menu"]')) {
      const label = `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`
      if (!/more|ещё|еще/i.test(label)) continue
      const anchor = button.getBoundingClientRect()
      let best = null
      let bestDistance = Infinity
      for (const menu of menus) {
        const rect = menu.getBoundingClientRect()
        if (rect.width === 0) continue
        const distance = Math.hypot(rect.left - anchor.left, rect.top - anchor.bottom)
        if (distance < bestDistance) {
          bestDistance = distance
          best = menu
        }
      }
      if (best !== null && bestDistance < 160) return best
    }
    return null
  }

  function placeDesignItem() {
    if (document.getElementById('andrey-design-menu-item') !== null) return
    const menu = findDesignMenu()
    if (menu === null) return
    const item = document.createElement('button')
    item.type = 'button'
    item.id = 'andrey-design-menu-item'
    item.setAttribute('role', 'menuitem')
    item.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left'
    item.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.8 13.2l1-3.4 6.6-6.6a1.7 1.7 0 0 1 2.4 2.4l-6.6 6.6-3.4 1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.6 4.2l2.2 2.2" stroke="currentColor" stroke-width="1.3"/></svg><span>Дизайн</span>'
    item.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      closeMenus()
      if (window.AndreyDesign) window.AndreyDesign.open()
    }, true)
    menu.appendChild(item)
  }

  /* ---- Hand Off to Another Agent ------------------------------------- */
  //
  // Client plugins never reach the client manifest in this build (see the note
  // in ui-inject.cjs), so the handoff lives here: the conversation root carries
  // `data-conversation-session`, the transcript comes from the app's own
  // `api/session.markdown` route, and `navigator.clipboard` copies the result.

  const HANDOFF_TAIL_CHARS = 12000
  const HANDOFF_GOAL_CHARS = 700
  let handoffToastTimer = 0

  function handoffSessionId() {
    const root = document.querySelector('[data-conversation-session]')
    const fromDom = root === null ? null : root.getAttribute('data-conversation-session')
    if (typeof fromDom === 'string' && fromDom !== '') return fromDom
    try {
      const raw = localStorage.getItem('dsh.sessions.current')
      const id = raw === null ? null : JSON.parse(raw)?.sessionId
      if (typeof id === 'string' && id !== '') return id
    } catch {
      /* a malformed entry is not worth a crash */
    }
    return null
  }

  function handoffGoal(markdown) {
    const block = []
    let started = false
    for (const line of markdown.split('\n')) {
      if (line.startsWith('>')) {
        started = true
        block.push(line.replace(/^>\s?/, ''))
        continue
      }
      if (started) break
    }
    return block.join('\n').trim().slice(0, HANDOFF_GOAL_CHARS)
  }

  function handoffTail(markdown) {
    if (markdown.length <= HANDOFF_TAIL_CHARS) return markdown.trim()
    const sliced = markdown.slice(-HANDOFF_TAIL_CHARS)
    const aligned = sliced.search(/\n(?:>\s|\*\*Assistant\*\*)/)
    return (aligned > 0 ? sliced.slice(aligned + 1) : sliced).trim()
  }

  function buildHandoff(markdown, sessionId) {
    const heading = markdown.split('\n').find((line) => line.startsWith('# '))
    const title = heading === undefined ? sessionId : heading.slice(2).trim()
    const goal = handoffGoal(markdown)
    return [
      `# Handoff: ${title}`,
      '',
      'You are taking over this work from a previous session. The context below is established state: do not redo finished work and do not ask the user to repeat it.',
      '',
      `- Source session: ${sessionId}`,
      `- Transferred: ${new Date().toISOString()}`,
      ...goal === '' ? [] : ['', '## Original goal', '', goal],
      '',
      '## Latest context',
      '',
      handoffTail(markdown),
      '',
      '## Your task',
      '',
      'Continue from where this session stopped. Verify the current state in the workspace first, then proceed with the next concrete step. If the goal is ambiguous, ask one clarifying question before changing anything.',
      '',
    ].join('\n')
  }

  function handoffToast(text, ok) {
    let node = document.getElementById('andrey-handoff-toast')
    if (node === null) {
      node = document.createElement('div')
      node.id = 'andrey-handoff-toast'
      node.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483001;max-width:520px;padding:10px 16px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);border:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.1));box-shadow:0 8px 24px rgba(0,0,0,0.16);font-size:13px;line-height:1.4'
      document.body.appendChild(node)
    }
    node.textContent = text
    node.style.color = ok ? 'var(--dsw-alias-label-primary,#111)' : 'var(--dsw-alias-state-error-primary,#c0392b)'
    clearTimeout(handoffToastTimer)
    handoffToastTimer = setTimeout(() => node.remove(), 4000)
  }

  async function readHandoff(sessionId) {
    const query = new URLSearchParams({ sessionId }).toString()
    const response = await fetch(`api/session.markdown?${query}`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return buildHandoff(await response.text(), sessionId)
  }

  async function copyHandoff(sessionId) {
    try {
      const text = await readHandoff(sessionId)
      await navigator.clipboard.writeText(text)
      handoffToast(`Хендофф скопирован: ${text.length} символов`, true)
      return true
    } catch (error) {
      handoffToast(`Не удалось прочитать сессию: ${String(error?.message ?? error)}`, false)
      return false
    }
  }

  async function startHandoff(sessionId) {
    const copied = await copyHandoff(sessionId)
    if (!copied) return
    const button = [...document.querySelectorAll('button')].find((element) => /new session|новая сессия/i.test(element.textContent ?? ''))
    if (button === undefined) {
      handoffToast('Контекст в буфере — создайте новый чат и вставьте его', true)
      return
    }
    button.click()
    handoffToast('Контекст в буфере — вставьте его в новый чат', true)
  }

  function closeHandoffMenu() {
    const menu = document.getElementById('andrey-handoff-menu')
    if (menu !== null) menu.remove()
  }

  function handoffMenuRow(label, run) {
    const row = document.createElement('button')
    row.type = 'button'
    row.setAttribute('role', 'menuitem')
    row.style.cssText = 'display:block;width:100%;padding:8px 12px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer'
    row.textContent = label
    row.addEventListener('mouseenter', () => { row.style.background = 'var(--dsw-alias-bg-layer-3,rgba(0,0,0,0.06))' })
    row.addEventListener('mouseleave', () => { row.style.background = 'transparent' })
    row.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      closeHandoffMenu()
      run()
    }, true)
    return row
  }

  function openHandoffMenu(point) {
    closeHandoffMenu()
    const sessionId = handoffSessionId()
    if (sessionId === null) {
      handoffToast('Откройте чат, который нужно передать', false)
      return
    }
    const menu = document.createElement('div')
    menu.id = 'andrey-handoff-menu'
    menu.setAttribute('role', 'menu')
    menu.style.cssText = 'position:fixed;z-index:2147483000;min-width:280px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);border:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.1));box-shadow:0 8px 24px rgba(0,0,0,0.16);font-size:13px'
    menu.appendChild(handoffMenuRow('Скопировать хендофф', () => copyHandoff(sessionId)))
    menu.appendChild(handoffMenuRow('Новый чат с хендоффом', () => startHandoff(sessionId)))
    document.body.appendChild(menu)
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(point.x, window.innerWidth - rect.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(point.y, window.innerHeight - rect.height - 8))}px`
  }

  function placeHandoffItem() {
    if (document.getElementById('andrey-handoff-menu-item') !== null) return
    const menu = findDesignMenu()
    if (menu === null) return
    const item = document.createElement('button')
    item.type = 'button'
    item.id = 'andrey-handoff-menu-item'
    item.setAttribute('role', 'menuitem')
    item.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left'
    item.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 8h9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M8.2 3.7L12.5 8l-4.3 4.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Передать агенту</span>'
    item.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const rect = item.getBoundingClientRect()
      closeMenus()
      openHandoffMenu({ x: rect.right + 6, y: rect.top })
    }, true)
    menu.appendChild(item)
  }

  // Right-click inside the conversation. A non-empty selection keeps the native
  // menu so selected text can still be copied; inputs keep it too.
  document.addEventListener('contextmenu', (event) => {
    if (event.defaultPrevented) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('textarea, input, [contenteditable="true"]') !== null) return
    if (target.closest('[data-conversation-session]') === null) return
    const selection = window.getSelection()
    if (selection !== null && selection.toString().trim() !== '') return
    event.preventDefault()
    openHandoffMenu({ x: event.clientX + 2, y: event.clientY + 2 })
  }, true)

  document.addEventListener('pointerdown', (event) => {
    const menu = document.getElementById('andrey-handoff-menu')
    if (menu !== null && !menu.contains(event.target)) closeHandoffMenu()
  }, true)

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeHandoffMenu()
  }, true)

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      event.stopPropagation()
      if (window.AndreyDesign) window.AndreyDesign.toggle()
    }
  }, true)

  const badgePlaced = placeBadge()
  const limitsPlaced = placeLimits()
  markProviders()
  placeMenuItem()
  // The composer often mounts after this script runs, so the polling is started
  // unconditionally: the plate attaches itself when its dock appears.
  startLimits()
  startAds()
  return badgePlaced ? (limitsPlaced ? 'placed' : 'placed-no-dock') : 'no-logo-row'
})()
