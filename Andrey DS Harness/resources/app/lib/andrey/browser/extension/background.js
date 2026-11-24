'use strict'

/**
 * The extension's service worker: one WebSocket to the local bridge, one tab
 * group the agent is allowed to touch, and nothing else.
 *
 * The agent never sees the user's other tabs: a tab becomes reachable only by
 * being put into the "Andrey Agent" tab group, and `page.*` calls are refused for
 * any other tab. Pairing is a six digit code the user reads in the app and types
 * here once; afterwards the worker keeps a 64 hex token in chrome.storage.local.
 */

importScripts('actions.js', 'snapshot-source.js')

const PORTS = [39160, 39161, 39162, 39163, 39164, 39165, 39166, 39167, 39168, 39169]
const GROUP_TITLE = 'Andrey Agent'
const GROUP_COLOR = 'blue'
const KEEPALIVE_ALARM = 'andrey-keepalive'

const state = {
  socket: null,
  token: '',
  port: 0,
  connected: false,
  paused: false,
  extVersion: chrome.runtime.getManifest().version,
  ownedTabs: new Set(),
  groupId: null,
  activeTabId: null,
  panelPorts: new Set(),
  pendingConfirms: new Map(),
  lastError: '',
}

const persist = async (values) => {
  try {
    await chrome.storage.local.set(values)
  } catch {
    /* storage may be unavailable during shutdown */
  }
}

function postStatus() {
  const payload = {
    type: 'status',
    data: {
      connected: state.connected,
      port: state.port,
      paused: state.paused,
      ownedTabs: [...state.ownedTabs],
      groupId: state.groupId,
      version: state.extVersion,
      lastError: state.lastError,
    },
  }
  for (const port of state.panelPorts) {
    try {
      port.postMessage(payload)
    } catch {
      state.panelPorts.delete(port)
    }
  }
}

function send(message) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false
  try {
    state.socket.send(JSON.stringify(message))
    return true
  } catch {
    return false
  }
}

function errorOf(error) {
  return { code: (error && error.code) || 'EXTENSION_ERROR', message: String((error && error.message) || error) }
}

async function openSocket(hello) {
  let lastError = ''
  for (const port of PORTS) {
    const socket = new WebSocket('ws://127.0.0.1:' + port + '/ext')
    const opened = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          socket.close()
        } catch {}
        resolve(false)
      }, 900)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(true)
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    if (!opened) {
      lastError = 'no bridge on port ' + port
      continue
    }

    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2500)
      const onMessage = (event) => {
        let message = null
        try {
          message = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (message && message.type === 'hello') {
          clearTimeout(timer)
          socket.removeEventListener('message', onMessage)
          resolve(message)
        }
      }
      socket.addEventListener('message', onMessage)
      socket.send(JSON.stringify(Object.assign({ type: 'hello', ext: { version: state.extVersion, name: 'andrey-browser' } }, hello)))
      socket.addEventListener('close', () => resolve(null))
    })

    if (!answer || !answer.ok) {
      try {
        socket.close()
      } catch {}
      lastError = 'pairing rejected on port ' + port
      continue
    }

    state.socket = socket
    state.port = port
    state.connected = true
    state.lastError = ''
    if (typeof answer.token === 'string' && answer.token !== '') {
      state.token = answer.token
      await persist({ token: answer.token, port })
    }
    socket.addEventListener('message', onBridgeMessage)
    socket.addEventListener('close', () => {
      state.connected = false
      state.socket = null
      postStatus()
    })
    postStatus()
    return true
  }
  state.lastError = lastError
  postStatus()
  return false
}

async function restore() {
  const stored = await chrome.storage.local.get(['token', 'port', 'groupId', 'paused'])
  if (stored && typeof stored.token === 'string') state.token = stored.token
  if (stored && Number(stored.port) > 0) state.port = Number(stored.port)
  if (stored && Number(stored.groupId) > 0) state.groupId = Number(stored.groupId)
  state.paused = Boolean(stored && stored.paused)
  if (state.groupId) {
    try {
      const tabs = await chrome.tabs.query({ groupId: state.groupId })
      for (const tab of tabs) if (typeof tab.id === 'number') state.ownedTabs.add(tab.id)
    } catch {
      state.groupId = null
    }
  }
  if (state.token) void openSocket({ token: state.token })
  postStatus()
}

function onBridgeMessage(event) {
  let message = null
  try {
    message = JSON.parse(String(event.data))
  } catch {
    return
  }
  if (!message || typeof message !== 'object') return

  if (message.type === 'req') {
    void handleRequest(message)
    return
  }
  if (message.type === 'event' && message.event === 'confirm.request') {
    state.pendingConfirms.set(message.data.id, message.data)
    let delivered = false
    for (const port of state.panelPorts) {
      try {
        port.postMessage({ type: 'confirm', data: message.data })
        delivered = true
      } catch {
        state.panelPorts.delete(port)
      }
    }
    if (!delivered) {
      send({ type: 'event', event: 'confirm.answer', data: { id: message.data.id, allow: false, reason: 'panel-closed' } })
      state.pendingConfirms.delete(message.data.id)
    } else {
      chrome.action.setBadgeText({ text: '!' }).catch(() => {})
    }
    return
  }
  if (message.type === 'event' && message.event === 'stop') {
    state.paused = true
    void persist({ paused: true })
    void detachAll()
    postStatus()
    return
  }
  if (message.type === 'event' && message.event === 'resume') {
    state.paused = false
    void persist({ paused: false })
    postStatus()
    return
  }
  if (message.type === 'event' && message.event === 'replaced') {
    try {
      state.socket.close()
    } catch {}
  }
}

async function detachAll() {
  for (const tabId of [...state.ownedTabs]) await self.AndreyActions.detach(tabId)
}

async function ensureGroup(tabIds) {
  const existing = tabIds.filter((tabId) => typeof tabId === 'number')
  if (existing.length === 0) throw Object.assign(new Error('no tab to group'), { code: 'BAD_PARAMS' })
  const groupId = await chrome.tabs.group({ tabIds: existing })
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR, collapsed: false })
  state.groupId = groupId
  await persist({ groupId })
  for (const tabId of existing) state.ownedTabs.add(tabId)
  return groupId
}

async function ownedTab(tabId) {
  const id = Number(tabId)
  if (!Number.isFinite(id)) {
    const tab = await chrome.tabs.query({ groupId: state.groupId }).catch(() => [])
    const fallback = tab.find((item) => typeof item.id === 'number')
    if (!fallback) throw Object.assign(new Error('there is no agent tab yet; open one first'), { code: 'NO_SUCH_TAB' })
    return fallback.id
  }
  if (!state.ownedTabs.has(id)) throw Object.assign(new Error('tab ' + id + ' is not owned by the agent'), { code: 'TAB_NOT_OWNED' })
  const tab = await chrome.tabs.get(id).catch(() => null)
  if (!tab) {
    state.ownedTabs.delete(id)
    throw Object.assign(new Error('tab ' + id + ' no longer exists'), { code: 'NO_SUCH_TAB' })
  }
  return id
}

async function withTab(method, params) {
  const tabId = await ownedTab(params && params.tabId)
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab) throw Object.assign(new Error('tab disappeared'), { code: 'NO_SUCH_TAB' })
  if (tab.discarded) await chrome.tabs.reload(tabId)
  await self.AndreyActions.attach(tabId)
  return tabId
}

const PAGE_METHODS = {
  'page.snapshot': 'snapshot',
  'page.describe': 'describe',
  'page.screenshot': 'screenshot',
  'page.click': 'click',
  'page.type': 'type',
  'page.press': 'press',
  'page.scroll': 'scroll',
  'page.navigate': 'navigate',
  'page.wait': 'wait',
  'page.extract': 'extract',
  'page.upload': 'upload',
  'page.console': 'consoleEntries',
}

async function handleRequest(message) {
  const id = message.id
  const method = String(message.method || '')
  const params = message.params && typeof message.params === 'object' ? message.params : {}
  try {
    if (state.paused && method !== 'status') {
      throw Object.assign(new Error('the user paused the agent'), { code: 'PAUSED' })
    }
    const data = await dispatch(method, params)
    send({ type: 'res', id, ok: true, data: data || {} })
  } catch (error) {
    send({ type: 'res', id, ok: false, error: errorOf(error) })
  }
}

async function dispatch(method, params) {
  switch (method) {
    case 'status':
      return { connected: state.connected, port: state.port, paused: state.paused, version: state.extVersion, ownedTabs: [...state.ownedTabs] }
    case 'tabs.list': {
      const tabs = state.groupId ? await chrome.tabs.query({ groupId: state.groupId }).catch(() => []) : []
      return {
        tabs: tabs.map((tab) => ({ tabId: tab.id, url: tab.url, title: tab.title, active: tab.active })),
        currentTabId: state.activeTabId,
        groupId: state.groupId,
      }
    }
    case 'tabs.open': {
      const url = String(params.url || 'about:blank')
      const tab = await chrome.tabs.create({ url, active: params.active === true })
      await ensureGroup([tab.id])
      state.activeTabId = tab.id
      postStatus()
      return { tabId: tab.id, url: tab.url || url }
    }
    case 'tabs.close': {
      const tabId = await ownedTab(params.tabId)
      await chrome.tabs.remove(tabId)
      state.ownedTabs.delete(tabId)
      if (state.activeTabId === tabId) state.activeTabId = null
      postStatus()
      return { closed: tabId }
    }
    case 'tabs.focus': {
      const tabId = await ownedTab(params.tabId)
      await chrome.tabs.update(tabId, { active: true })
      state.activeTabId = tabId
      return { focused: tabId }
    }
    case 'agent.stop': {
      state.paused = true
      await persist({ paused: true })
      await detachAll()
      postStatus()
      return { paused: true }
    }
    default: {
      const action = PAGE_METHODS[method]
      if (!action) throw Object.assign(new Error('unknown method: ' + method), { code: 'BAD_PARAMS' })
      const tabId = await withTab(method, params)
      state.activeTabId = tabId
      const data = await self.AndreyActions[action](tabId, params)
      return Object.assign({ tabId }, data)
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== 'panel') return
  state.panelPorts.add(port)
  port.onDisconnect.addListener(() => state.panelPorts.delete(port))
  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return
    if (message.type === 'status') postStatus()
    if (message.type === 'pair') {
      void (async () => {
        const ok = await openSocket({ code: String(message.code || '') })
        port.postMessage({ type: 'pair-result', ok, error: state.lastError })
      })()
    }
    if (message.type === 'confirm-answer') {
      const pending = state.pendingConfirms.get(message.id)
      if (pending) {
        state.pendingConfirms.delete(message.id)
        send({ type: 'event', event: 'confirm.answer', data: { id: message.id, allow: Boolean(message.allow) } })
        chrome.action.setBadgeText({ text: '' }).catch(() => {})
      }
    }
    if (message.type === 'focus-tab') {
      void dispatch('tabs.focus', { tabId: message.tabId }).then(postStatus, () => {})
    }
    if (message.type === 'open-tab') {
      void dispatch('tabs.open', {}).then(postStatus, () => {})
    }
    if (message.type === 'resume') {
      state.paused = false
      void persist({ paused: false })
      // Tell the app side as well, so the panel and the tools agree.
      send({ type: 'event', event: 'resumed' })
      postStatus()
    }
    if (message.type === 'pause') {
      state.paused = true
      void persist({ paused: true })
      void detachAll()
      postStatus()
    }
  })
})

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== KEEPALIVE_ALARM) return
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    send({ type: 'ping' })
    return
  }
  if (state.token) void openSocket({ token: state.token })
})

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
})

chrome.action.onClicked.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.ownedTabs.delete(tabId)) {
    void self.AndreyActions.detach(tabId)
    if (state.activeTabId === tabId) state.activeTabId = null
    postStatus()
  }
})

void restore()
