'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { projectChatsDir, latestChatId } = require('./freebuff-cli.cjs')

/**
 * Reads the conversation the Freebuff CLI persists for a folder.
 *
 * The CLI has no headless mode, but it does write every chat to
 * `projects/<basename>/chats/<id>/chat-messages.json`: an array of messages
 * whose `blocks` already separate reasoning, text, tool calls and questions.
 * That file is the provider's stream — no screen scraping — and it appears a few
 * seconds after the first prompt and grows as the run progresses.
 */

function newestChatDir({ cwd, userHome } = {}) {
  const dir = projectChatsDir({ cwd, userHome })
  if (!dir) return null
  try {
    const ids = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    return ids.at(-1) ?? null
  } catch {
    return null
  }
}

function textOf(blocks, textType) {
  return blocks
    .filter((block) => block?.type === 'text' && (block.textType ?? 'text') === textType)
    .map((block) => (typeof block.content === 'string' ? block.content : ''))
    .filter(Boolean)
    .join('\n\n')
}

function normalizeTool(block) {
  return {
    id: typeof block.toolCallId === 'string' ? block.toolCallId : null,
    name: typeof block.toolName === 'string' ? block.toolName : 'tool',
    input: block.input ?? null,
    output: typeof block.output === 'string' ? block.output : null,
  }
}

function normalizeAsk(block) {
  const questions = Array.isArray(block.questions) ? block.questions : []
  return {
    id: typeof block.toolCallId === 'string' ? block.toolCallId : null,
    questions: questions.map((question) => ({
      header: typeof question?.header === 'string' ? question.header : null,
      question: typeof question?.question === 'string' ? question.question : '',
      options: Array.isArray(question?.options)
        ? question.options.map((option) => ({
          label: typeof option?.label === 'string' ? option.label : '',
          description: typeof option?.description === 'string' ? option.description : null,
        }))
        : [],
    })),
  }
}

function normalizeMessage(raw) {
  const blocks = Array.isArray(raw?.blocks) ? raw.blocks : []
  const role = raw?.variant === 'user' ? 'user' : 'assistant'
  const message = {
    id: typeof raw?.id === 'string' ? raw.id : null,
    role,
    at: typeof raw?.timestamp === 'string' ? raw.timestamp : null,
    text: role === 'user'
      ? (typeof raw?.content === 'string' ? raw.content : textOf(blocks, 'text'))
      : textOf(blocks, 'text'),
    reasoning: role === 'assistant' ? textOf(blocks, 'reasoning') : '',
    tools: blocks.filter((block) => block?.type === 'tool').map(normalizeTool),
    asks: blocks.filter((block) => block?.type === 'ask-user').map(normalizeAsk),
    complete: raw?.isComplete !== false,
    completionTime: typeof raw?.completionTime === 'string' ? raw.completionTime : null,
    credits: Number.isFinite(raw?.credits) ? raw.credits : null,
  }
  return message
}

/** Drop layout-only entries (`mode-divider`) and empty assistant shells. */
function normalizeMessages(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((message) => !(Array.isArray(message?.blocks) && message.blocks.length > 0 && message.blocks.every((block) => block?.type === 'mode-divider')))
    .map(normalizeMessage)
    .filter((message) => message.role === 'user' || message.text || message.reasoning || message.tools.length > 0 || message.asks.length > 0)
}

function readChatFile(file) {
  try {
    const stat = fs.statSync(file)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { raw, signature: `${stat.size}:${Math.round(stat.mtimeMs)}` }
  } catch {
    return null
  }
}

/**
 * Polls the folder's chat file and reports normalised messages whenever it
 * changes. `chatId` seeds a resumed conversation; a newer chat directory (the
 * user pressed "New session") takes over automatically.
 */
function createChatWatcher({ cwd, userHome, chatId = null, onUpdate, intervalMs = 400, setTimeoutImpl, clearTimeoutImpl }) {
  let currentId = chatId
  let signature = null
  let timer = null
  let stopped = false

  function poll() {
    if (stopped) return null
    // Only chats with a transcript count: the CLI creates the folder on the
    // first prompt, so an empty newer folder must not hide a resumed chat.
    const newest = latestChatId({ cwd, userHome })
    if (newest && newest !== currentId) {
      currentId = newest
      signature = null
    }
    if (!currentId) return null

    const file = path.join(projectChatsDir({ cwd, userHome }), currentId, 'chat-messages.json')
    const read = readChatFile(file)
    if (!read) return null
    if (read.signature === signature) return null
    signature = read.signature

    const messages = normalizeMessages(read.raw)
    const last = messages.at(-1) ?? null
    const payload = {
      chatId: currentId,
      messages,
      complete: last ? last.complete : true,
    }
    onUpdate?.(payload)
    return payload
  }

  return {
    poll,
    start() {
      poll()
      if (timer || stopped) return
      const schedule = setTimeoutImpl ?? setTimeout
      const tick = () => {
        poll()
        if (stopped) return
        timer = schedule(tick, intervalMs)
      }
      timer = schedule(tick, intervalMs)
    },
    stop() {
      stopped = true
      const cancel = clearTimeoutImpl ?? clearTimeout
      if (timer) cancel(timer)
      timer = null
    },
  }
}

module.exports = {
  newestChatDir,
  normalizeMessage,
  normalizeMessages,
  readChatFile,
  createChatWatcher,
}
