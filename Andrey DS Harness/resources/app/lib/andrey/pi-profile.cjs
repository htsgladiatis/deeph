'use strict'

/**
 * Keep the `freepi` provider in the copy's dsh profile pointed at the local
 * freePi route.
 *
 * The route (`freepi-route.cjs`) resolves the active account on every request
 * and talks to `api.freepi.ai` itself, so no token lives in the profile any
 * more: switching a freePi account applies to the next message, with no
 * restart, and the same chat keeps its history. The profile keeps only what the
 * picker needs — the route's base URL and the model list.
 *
 * Models come from `GET /client-version`, the endpoint their own CLI uses. Only
 * the scripts refresh that list — boot must not wait on the network — and when
 * the list was never fetched the existing one is kept, so nothing is ever lost.
 */

const fs = require('node:fs')
const path = require('node:path')

const BASE_URL = 'https://api.freepi.ai/v1'
const LOCAL_BASE_URL = 'http://127.0.0.1:39147/freepi/v1'
const CLIENT_VERSION = '0.6.21'
const CONTEXT_WINDOW = 200000
/**
 * Answer budget every freePi model gets. It is also the output reservation the
 * harness compaction formula subtracts from the window (`compaction-profile.cjs`),
 * so it cannot be tiny: 8192 made thinking models spend the budget on reasoning
 * and come back empty. 32k keeps a long reasoning pass and still leaves ~166k of
 * a 200k window for the prompt.
 */
const MAX_TOKENS = 32768

/**
 * Screenshot budget per request.
 *
 * freePi answers `413 context_too_long` on a request that carries several
 * screenshots even when the text side is only ~50k tokens: every image in the
 * history is re-encoded into every body, and their side counts them far above
 * our reference-only estimate. The adapter's defaults (50 images, 20MiB, 1MiB
 * each) never trigger, so the provider refuses instead. Keeping the newest four
 * at ~1MP / 400KB keeps the body small; older occurrences are replaced with a
 * text note by `@deepseek-ai/dsh-compaction-image-offload`, which reacts to the
 * adapter's IMAGE_OFFLOAD_REQUIRED and retries the request.
 */
const REQUEST_MAX_IMAGES = 4
const REQUEST_IMAGE_PIXEL_BUDGET = 1024 * 1024
const REQUEST_IMAGE_MAX_BYTES = 400 * 1024
const REQUEST_MAX_IMAGE_BYTES = 4 * 1024 * 1024
const FALLBACK_MODELS = [{ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4.1 Flash' }]

/**
 * The bundled runtime owns `yaml`; the copy has no package.json of its own.
 *
 * Two layouts have to work: inside the app (`resources/app/lib/andrey`, where
 * the runtime is a sibling `dsh`) and inside `_integr` (where the runtime is the
 * installed copy several levels up). Hence the candidate list rather than one
 * guessed path.
 */
function runtimeRequire(module) {
  const candidates = [
    process.env.ANDREY_DSH_RUNTIME,
    path.resolve(__dirname, '..', '..', 'dsh'),
    path.resolve(__dirname, '..', '..', '..', '..', 'Andrey DS Harness', 'resources', 'app', 'dsh'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')

  for (const runtime of candidates) {
    try {
      return require(path.join(runtime, 'node_modules', module))
    } catch {
      /* try the next layout */
    }
  }
  throw new Error(`${module} not found in the bundled runtime (checked: ${candidates.join(', ')})`)
}

function toModels(catalog) {
  const models = (catalog?.models ?? []).filter((model) => model && model.id && model.section !== 'defense')
  const shaped = models.map((model) => ({
    id: model.id,
    name: model.display_name ?? model.name ?? model.id,
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_TOKENS,
    input: ['text'],
  }))
  return shaped.length > 0 ? shaped : FALLBACK_MODELS
}

async function fetchCatalog({ token, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (typeof token !== 'string' || token === '') return null
  try {
    const res = await fetchImpl(`${BASE_URL.replace(/\/v1$/, '')}/client-version`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * The provider entry: the local route plus the visible model list.
 *
 * `apiKeyEnv` is a placeholder the route never checks — pi-ai refuses a route
 * that names no credential at all, and `boot.cjs` fills the variable.
 */
function buildProvider({ catalog, previous }) {
  return {
    displayName: 'freePi',
    api: 'openai-completions',
    baseURL: LOCAL_BASE_URL,
    apiKeyEnv: 'FREEPI_LOCAL_KEY',
    maxRequestImages: REQUEST_MAX_IMAGES,
    maxRequestImageBytes: REQUEST_MAX_IMAGE_BYTES,
    requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
    models: catalog ? toModels(catalog) : (previous?.models ?? FALLBACK_MODELS),
  }
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Write the active account's token into the profile, synchronously.
 *
 * Synchronous on purpose: boot must finish this before their `main.js` reads the
 * profile, and a promise would race the import. No network here.
 */
function applyActivePiAccountSync({ store, profilePath, catalog = null } = {}) {
  try {
    if (!fs.existsSync(profilePath)) return { ok: false, error: 'profile-missing' }

    const account = store.profiles.context('pi')

    const YAML = runtimeRequire('yaml')
    const doc = YAML.parse(fs.readFileSync(profilePath, 'utf8'))
    const entry = Array.isArray(doc) ? doc.find((item) => item && item.id === 'llm-pi-ai') : null
    if (!entry) return { ok: false, error: 'llm-pi-ai-missing' }

    const previous = entry.config?.providers?.freepi ?? null
    const next = buildProvider({ catalog, previous })
    if (previous && sameJson(previous, next)) {
      return { ok: true, changed: false, account: account.id, models: next.models.length }
    }

    entry.config = entry.config ?? {}
    entry.config.providers = entry.config.providers ?? {}
    entry.config.providers.freepi = next
    fs.writeFileSync(profilePath, YAML.stringify(doc))
    return { ok: true, changed: true, account: account.id, models: next.models.length }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** Same, plus a fresh model list when the caller can afford the round trip. */
async function applyActivePiAccount({ store, profilePath, fetchImpl = fetch, log = () => {} } = {}) {
  const account = store.profiles.context('pi')
  const token = store.piToken(account)
  // A missing token is not a profile problem any more: the route reports it per
  // request, and the model list simply stays as it was.
  const catalog = token ? await fetchCatalog({ token, fetchImpl }) : null
  const result = applyActivePiAccountSync({ store, profilePath, catalog })
  if (result.ok && result.changed) log('info', 'pi-profile:applied', { account: result.account, models: result.models })
  return result
}

module.exports = {
  applyActivePiAccount,
  applyActivePiAccountSync,
  MAX_TOKENS,
  fetchCatalog,
  runtimeRequire,
  toModels,
  BASE_URL,
  LOCAL_BASE_URL,
}
