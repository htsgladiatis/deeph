'use strict'

/**
 * Automatic context compression for the loopback chat routes.
 *
 * A long session grows `messages` until the upstream rejects the request or the
 * agent loses coherence. This module shrinks that array to a token budget before
 * forwarding, keeping what carries meaning: system instructions, the original
 * goal, and the newest turns.
 *
 * It is deliberately lossy and honest — dropped turns are replaced by one small
 * notice, so the model knows the context was compacted instead of pretending
 * nothing happened. No extra LLM call is made: the freePi route allows a single
 * in-flight request, so a summarising round-trip would fight the same gates this
 * harness already works around.
 *
 * Tool-aware: an `assistant` message carrying `tool_calls` and the `tool`
 * messages that answer it are kept or dropped as one unit. Splitting them would
 * turn a long session into a hard API error ("tool_call_id not found") — the
 * exact failure this module exists to prevent.
 */

const CYRILLIC = /[\u0400-\u04FF]/g
/** Matches the harness compaction trigger (compaction-profile.cjs): 166232 of a 200k window with a 32k answer reservation. */
const DEFAULT_BUDGET = 166_232
const MIN_BUDGET = 1_000

/**
 * freePi refuses a request body above roughly one mebibyte and reports it as
 * `413 {code:"context_too_long"}`.
 *
 * The body is dominated by images: every screenshot in the history is re-encoded
 * into every request, so a session with a dozen screenshots sends ~1.8MB while
 * its text is only ~50k tokens. The route therefore drops the oldest image
 * payloads (they become a one-line note) until the body fits. Text is never cut
 * here — that stays the token budget's job.
 */
const DEFAULT_MAX_BODY_BYTES = 900_000
const MIN_BODY_BYTES = 100_000

const NOTICE = '[Context compaction: earlier conversation turns were removed to fit the context window. Continue from the retained messages below; do not refer to the removed turns as if they were still present.]'

const IMAGE_NOTICE = '[screenshot dropped before sending: the request body did not fit the provider limit]'

/** Length of the base64/data payload of an image part, or 0 for anything else. */
function imagePayloadLength(part) {
  if (!part || typeof part !== 'object') return 0
  if (typeof part.image_url === 'string') return part.image_url.length
  if (typeof part.image_url?.url === 'string') return part.image_url.url.length
  if (typeof part.data === 'string') return part.data.length
  if (typeof part.source?.data === 'string') return part.source.data.length
  return 0
}

function normalizeBodyBytes(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= MIN_BODY_BYTES ? Math.floor(number) : DEFAULT_MAX_BODY_BYTES
}

/**
 * Replace the oldest image payloads until the serialized body fits `maxBytes`.
 * Mutates `body.messages` in place and reports what it did.
 */
function shrinkImagesToLimit(body, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  const bytesBefore = Buffer.byteLength(JSON.stringify(body), 'utf8')
  const result = { changed: false, droppedImages: 0, bytesBefore, bytesAfter: bytesBefore }
  if (bytesBefore <= maxBytes) return result

  const images = []
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message?.content)) continue
    for (let index = 0; index < message.content.length; index += 1) {
      if (imagePayloadLength(message.content[index]) > 0) images.push({ content: message.content, index })
    }
  }

  for (const image of images) {
    image.content[image.index] = { type: 'text', text: IMAGE_NOTICE }
    result.droppedImages += 1
    result.bytesAfter = Buffer.byteLength(JSON.stringify(body), 'utf8')
    if (result.bytesAfter <= maxBytes) break
  }

  result.changed = result.droppedImages > 0
  return result
}

function estimateTokens(text) {
  const value = String(text ?? '')
  if (value === '') return 0
  const match = value.match(CYRILLIC)
  const cyrillic = match === null ? 0 : match.length
  return Math.ceil(cyrillic / 2 + (value.length - cyrillic) / 4)
}

/** Text used for the token estimate; image/base64 payloads never count. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== 'object') return ''
      if (typeof part.text === 'string') return part.text
      if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image') return '[image]'
      return ''
    }).join('\n')
  }
  return ''
}

function messageTokens(message) {
  if (!message || typeof message !== 'object') return 0
  let tokens = estimateTokens(textOf(message.content))
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      tokens += estimateTokens(JSON.stringify(call?.function ?? call ?? ''))
    }
  }
  if (typeof message.tool_call_id === 'string') tokens += estimateTokens(message.tool_call_id)
  return tokens
}

function unitTokens(unit) {
  let tokens = 0
  for (const message of unit) tokens += messageTokens(message)
  return tokens
}

function isSystem(message) {
  return message?.role === 'system' || message?.role === 'developer'
}

/**
 * Group an assistant tool-call message with the tool results that follow it.
 * Everything else is its own one-message unit.
 */
function groupMessages(messages) {
  const units = []
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const group = [message]
      let j = i + 1
      while (j < messages.length && messages[j]?.role === 'tool') {
        group.push(messages[j])
        j += 1
      }
      units.push(group)
      i = j - 1
      continue
    }
    units.push([message])
  }
  return units
}

/** Replace a string/part-array content with a shorter version (~tokens long). */
function truncateContent(content, tokens) {
  const chars = Math.max(0, Math.floor(tokens * 3))
  if (typeof content === 'string') {
    return content.length <= chars ? content : `${content.slice(0, chars).trimEnd()} …[trimmed]`
  }
  if (Array.isArray(content)) {
    let left = chars
    return content.map((part) => {
      if (!part || typeof part !== 'object' || typeof part.text !== 'string' || left <= 0) return part
      const kept = part.text.slice(0, left)
      left -= kept.length
      return kept.length === part.text.length ? part : { ...part, text: `${kept.trimEnd()} …[trimmed]` }
    })
  }
  return content
}

/** Shrink an oversized system prefix down to `tokens`, keeping its first bytes. */
function shrinkSystem(messages, tokens) {
  const out = []
  let left = tokens
  for (const message of messages) {
    if (left <= 0) break
    const cost = messageTokens(message)
    if (cost <= left) {
      out.push(message)
      left -= cost
      continue
    }
    const copy = { ...message, content: truncateContent(message.content, left) }
    out.push(copy)
    left -= messageTokens(copy)
  }
  return out
}

function normalizeBudget(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= MIN_BUDGET ? Math.floor(number) : DEFAULT_BUDGET
}

/**
 * Compress `messages` to the token budget.
 * Returns { messages, changed, originalTokens, finalTokens, removed }.
 * Never throws on odd input: bad messages simply pass through untouched.
 */
function compressMessages(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : []
  const result = { messages: list, changed: false, originalTokens: 0, finalTokens: 0, removed: 0 }
  if (list.length === 0) return result

  const budget = normalizeBudget(options.budgetTokens)
  const originalTokens = list.reduce((sum, message) => sum + messageTokens(message), 0)
  result.originalTokens = originalTokens
  if (originalTokens <= budget) {
    result.finalTokens = originalTokens
    return result
  }

  const units = groupMessages(list)
  const system = []
  let index = 0
  while (index < units.length && isSystem(units[index][0])) {
    system.push(...units[index])
    index += 1
  }
  const turns = units.slice(index)

  const notice = { role: 'system', content: NOTICE }
  const noticeTokens = messageTokens(notice)
  const systemTokens = system.reduce((sum, message) => sum + messageTokens(message), 0)

  let keptSystem = system
  if (systemTokens + noticeTokens >= budget) {
    keptSystem = shrinkSystem(system, Math.max(0, budget - noticeTokens - MIN_BUDGET))
  }

  // Preserve the first user turn (the goal) when it is not already recent.
  const anchorIndex = turns.findIndex((unit) => unit[0]?.role === 'user')
  const anchor = anchorIndex >= 0 ? turns[anchorIndex] : null
  const anchorTokens = anchor ? unitTokens(anchor) : 0
  const fixedTokens = keptSystem.reduce((sum, message) => sum + messageTokens(message), 0) + noticeTokens
  const useAnchor = Boolean(anchor && anchorIndex !== turns.length - 1 && fixedTokens + anchorTokens < budget)

  const available = Math.max(0, budget - fixedTokens - (useAnchor ? anchorTokens : 0))
  const keep = new Set()
  let used = 0
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    if (useAnchor && at === anchorIndex) continue
    const cost = unitTokens(turns[at])
    if (cost <= available - used) {
      keep.add(at)
      used += cost
      continue
    }
    // A contiguous recent suffix is the point; stop at the first unit that
    // does not fit rather than fishing small, stale units out of the middle.
    break
  }
  // The newest turn is never dropped — shrink it later if it alone is huge.
  if (turns.length > 0) keep.add(turns.length - 1)

  const out = [...keptSystem, notice]
  if (useAnchor) out.push(...anchor)
  for (let at = 0; at < turns.length; at += 1) {
    if (keep.has(at)) out.push(...turns[at])
  }

  // Last resort: still over budget (one giant recent turn). Trim the oldest
  // kept turns first so the newest wording survives intact.
  let finalTokens = out.reduce((sum, message) => sum + messageTokens(message), 0)
  if (finalTokens > budget) {
    let excess = finalTokens - budget
    for (let at = 0; at < out.length && excess > 0; at += 1) {
      const message = out[at]
      if (message === notice || isSystem(message)) continue
      const cost = messageTokens(message)
      if (cost <= 0) continue
      const target = Math.max(0, cost - excess - 32)
      out[at] = { ...message, content: truncateContent(message.content, target) }
      excess -= cost - messageTokens(out[at])
    }
    finalTokens = out.reduce((sum, message) => sum + messageTokens(message), 0)
  }

  result.messages = out
  result.changed = true
  result.removed = Math.max(0, list.length - (out.length - 1))
  result.finalTokens = finalTokens
  return result
}

/**
 * Compress the `messages` field of a chat-completions request body, if needed.
 * Returns a Buffer: the original one when nothing changed, so the caller keeps
 * forwarding byte-for-byte identical requests on the common path.
 */
function maybeCompressBody(buffer, options = {}) {
  const enabled = options.enabled !== false && String(process.env.ANDREY_CONTEXT_ENABLED ?? '1') !== '0'
  const budget = normalizeBudget(options.budgetTokens ?? process.env.ANDREY_CONTEXT_TOKENS ?? process.env.FREEPI_CONTEXT_TOKENS)
  const result = { buffer, changed: false, originalTokens: 0, finalTokens: 0, removed: 0 }
  if (!enabled || !Buffer.isBuffer(buffer) || buffer.length === 0) return result

  let body
  try {
    body = JSON.parse(buffer.toString('utf8'))
  } catch {
    return result
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return result

  // Route diagnostics: the caller logs these next to what the provider answers.
  result.model = typeof body.model === 'string' ? body.model : null
  result.maxTokens = Number(body.max_tokens ?? body.maxTokens) || null
  result.messageCount = body.messages.length

  const compressed = compressMessages(body.messages, { budgetTokens: budget })
  const outbound = compressed.changed ? { ...body, messages: compressed.messages } : body
  const images = shrinkImagesToLimit(outbound, normalizeBodyBytes(options.maxBodyBytes ?? process.env.ANDREY_REQUEST_MAX_BYTES))

  result.originalTokens = compressed.originalTokens
  result.finalTokens = compressed.finalTokens
  result.removed = compressed.removed
  result.imagesDropped = images.droppedImages
  result.bytesAfter = images.bytesAfter

  if (!compressed.changed && !images.changed) return result
  result.buffer = Buffer.from(JSON.stringify(outbound), 'utf8')
  result.changed = true
  return result
}

module.exports = {
  estimateTokens,
  messageTokens,
  compressMessages,
  maybeCompressBody,
  shrinkImagesToLimit,
  imagePayloadLength,
  DEFAULT_BUDGET,
  DEFAULT_MAX_BODY_BYTES,
  NOTICE,
  IMAGE_NOTICE,
}
