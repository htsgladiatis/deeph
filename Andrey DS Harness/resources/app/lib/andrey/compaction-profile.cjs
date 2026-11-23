'use strict'

/**
 * Make the harness condense a chat as late as the window actually allows.
 *
 * `@deepseek-ai/dsh-compaction-basic` (mounted by the `dsh-base` bundle) starts
 * automatic compaction at
 *
 *   floor(min(W * thresholdRatio, W - O - headroomTokens))
 *
 * where W is the model's declared context window, O the routed output
 * reservation (the model's `maxTokens`) and the package defaults are
 * `thresholdRatio: 0.8` and `headroomTokens: 65536`. For a 200k freePi model
 * with the fork's 32k answer budget the default resolves to
 *
 *   min(160000, 200000 - 32768 - 65536) = 101696
 *
 * The prompt and the completion share one window, so a larger answer budget
 * necessarily moves the trigger down. With 0.95 of the window and a 1k headroom
 *
 *   min(200000 * 0.95, 200000 - 32768 - 1000) = min(190000, 166232) = 166232
 *
 * and that is the most a 200k window can give while keeping 32k for the answer.
 * 32k is the smallest cap that leaves room for a long reasoning pass: at 8192 a
 * thinking model spends the whole budget on reasoning, returns no content and
 * the turn fails. Anything below ~9k of answer budget could keep the 190k
 * trigger, but only by cutting thinking off again.
 *
 * `maxTokens` (the summary cap) has to be written explicitly: the backend
 * defaults it to `headroomTokens`, so a 1k headroom would cap a summary at 1000
 * tokens and truncate it.
 *
 * The freePi models' own `maxTokens` is normalized too. That field is the `O`
 * the formula subtracts, and the host rewrites it from the model catalog (120k
 * for the flash models), which pushed the trigger down to 79k no matter what
 * the ratios said.
 *
 * Per-model policies already in the file keep their own `headroomTokens` /
 * `maxTokens` (the local LM Studio routes need the small-window ones), and the
 * file is left untouched when it already says the same. The profile is read
 * when the host mounts plugins, so this runs at boot, before `main.js`.
 */

const fs = require('node:fs')

const { MAX_TOKENS: OUTPUT_TOKENS, runtimeRequire } = require('./pi-profile.cjs')

const THRESHOLD_RATIO = 0.95
const HEADROOM_TOKENS = 1000
const MAX_TOKENS = 8192

/** The trigger the backend resolves for one route; exported for the tests. */
function compactTriggerTokens({ contextWindow, reservedTokens, headroomTokens = HEADROOM_TOKENS, thresholdRatio = THRESHOLD_RATIO }) {
  return Math.floor(Math.min(contextWindow * thresholdRatio, contextWindow - reservedTokens - headroomTokens))
}

/** Cap every freePi model's answer budget, which is the reservation the trigger subtracts. */
function capFreePiOutputTokens(doc) {
  const entry = doc.find((item) => item && item.id === 'llm-pi-ai')
  const models = entry?.config?.providers?.freepi?.models
  if (!Array.isArray(models)) return false

  let changed = false
  for (const model of models) {
    if (!model || typeof model !== 'object') continue
    if (model.maxTokens !== OUTPUT_TOKENS) {
      model.maxTokens = OUTPUT_TOKENS
      changed = true
    }
  }
  return changed
}

function applyCompactionProfileSync({ profilePath } = {}) {
  try {
    if (!fs.existsSync(profilePath)) return { ok: false, error: 'profile-missing' }

    const YAML = runtimeRequire('yaml')
    const doc = YAML.parse(fs.readFileSync(profilePath, 'utf8'))
    if (!Array.isArray(doc)) return { ok: false, error: 'profile-not-a-list' }

    let changed = capFreePiOutputTokens(doc)

    // The backend itself comes from the `dsh-base` bundle, so a missing entry is
    // not an error: an entry with only an id and config is a patch of that base
    // entry, and the host rewrites this file from its own state, so the entry can
    // disappear between boots.
    let entry = doc.find((item) => item && item.id === 'compaction-basic')
    if (!entry) {
      entry = { id: 'compaction-basic', config: {} }
      doc.push(entry)
      changed = true
    }

    entry.config = entry.config ?? {}
    const wanted = {
      thresholdRatio: THRESHOLD_RATIO,
      headroomTokens: HEADROOM_TOKENS,
      maxTokens: MAX_TOKENS,
    }
    for (const [key, value] of Object.entries(wanted)) {
      if (entry.config[key] !== value) {
        entry.config[key] = value
        changed = true
      }
    }

    if (!changed) return { ok: true, changed: false }
    fs.writeFileSync(profilePath, YAML.stringify(doc))
    return { ok: true, changed: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

module.exports = {
  applyCompactionProfileSync,
  capFreePiOutputTokens,
  compactTriggerTokens,
  THRESHOLD_RATIO,
  HEADROOM_TOKENS,
  MAX_TOKENS,
  OUTPUT_TOKENS,
}
