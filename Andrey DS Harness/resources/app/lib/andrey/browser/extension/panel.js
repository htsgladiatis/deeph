'use strict'

/**
 * The side panel: pairing, the agent tab list, and the confirmation prompt.
 *
 * The panel holds no logic of its own beyond rendering and forwarding answers -
 * the service worker owns the connection, so closing the panel never drops it.
 */

const el = (id) => document.getElementById(id)
let port = null
let currentConfirm = null
let status = { connected: false, paused: false, ownedTabs: [], version: '' }

function connect() {
  port = chrome.runtime.connect({ name: 'panel' })
  port.onMessage.addListener(onMessage)
  port.onDisconnect.addListener(() => {
    port = null
    setTimeout(connect, 500)
  })
  port.postMessage({ type: 'status' })
}

function onMessage(message) {
  if (!message || typeof message !== 'object') return
  if (message.type === 'status') renderStatus(message.data)
  if (message.type === 'pair-result') {
    el('pair-btn').disabled = false
    if (!message.ok) showPairError('Не удалось подключиться: ' + (message.error || 'проверь, что приложение запущено'))
  }
  if (message.type === 'confirm') showConfirm(message.data)
}

function renderStatus(next) {
  status = Object.assign({}, status, next || {})
  const dot = el('dot')
  dot.className = 'dot' + (status.paused ? ' paused' : status.connected ? ' on' : '')
  el('version').textContent = status.version ? 'v' + status.version : ''
  el('status-line').textContent = status.paused
    ? 'агент на паузе'
    : status.connected
      ? 'подключён' + (status.port ? ' · порт ' + status.port : '')
      : 'не подключён'

  el('pair').classList.toggle('hidden', status.connected)
  el('connected').classList.toggle('hidden', !status.connected)
  el('pause-btn').textContent = status.paused ? 'Продолжить' : 'Пауза'
  el('pause-btn').classList.toggle('primary', status.paused)
  el('pause-btn').classList.toggle('secondary', !status.paused)
  renderTabs(status.ownedTabs || [])
}

function renderTabs(tabIds) {
  const list = el('tabs')
  list.textContent = ''
  if (tabIds.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    empty.textContent = 'Вкладок пока нет — агент создаст свою, когда начнёт.'
    list.appendChild(empty)
    return
  }
  for (const tabId of tabIds) {
    const item = document.createElement('li')
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = 'Вкладка ' + tabId
    item.appendChild(name)
    item.addEventListener('click', () => port && port.postMessage({ type: 'focus-tab', tabId }))
    chrome.tabs.get(tabId).then((tab) => {
      if (!tab) return
      name.textContent = tab.title || tab.url || 'Вкладка ' + tabId
      const url = document.createElement('span')
      url.className = 'url'
      url.style.display = 'block'
      try {
        url.textContent = new URL(tab.url).host
      } catch {
        url.textContent = tab.url || ''
      }
      name.appendChild(url)
    }).catch(() => {})
    list.appendChild(item)
  }
}

function showConfirm(data) {
  currentConfirm = data
  el('confirm').classList.remove('hidden')
  el('confirm-summary').textContent = data.summary || 'Действие на странице'
  el('confirm-origin').textContent = data.origin ? 'Сайт: ' + data.origin : ''
  chrome.action.setBadgeText({ text: '!' }).catch(() => {})
}

function answerConfirm(allow) {
  if (!currentConfirm || !port) return
  port.postMessage({ type: 'confirm-answer', id: currentConfirm.id, allow })
  currentConfirm = null
  el('confirm').classList.add('hidden')
  chrome.action.setBadgeText({ text: '' }).catch(() => {})
}

function showPairError(text) {
  const node = el('pair-error')
  node.textContent = text
  node.classList.remove('hidden')
}

el('pair-btn').addEventListener('click', () => {
  const code = el('code').value.replace(/\D/g, '').slice(0, 6)
  el('pair-error').classList.add('hidden')
  if (code.length !== 6) return showPairError('Код состоит из шести цифр')
  el('pair-btn').disabled = true
  if (!port) return showPairError('Нет связи со службой расширения — перезагрузи расширение')
  port.postMessage({ type: 'pair', code })
})

el('code').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') el('pair-btn').click()
})

el('allow-btn').addEventListener('click', () => answerConfirm(true))
el('deny-btn').addEventListener('click', () => answerConfirm(false))

el('open-btn').addEventListener('click', () => {
  if (port) port.postMessage({ type: 'open-tab' })
})

el('pause-btn').addEventListener('click', () => {
  if (!port) return
  port.postMessage({ type: status.paused ? 'resume' : 'pause' })
})

connect()
