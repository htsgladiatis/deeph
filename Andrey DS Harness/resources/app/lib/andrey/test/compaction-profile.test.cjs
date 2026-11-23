'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const profile = require('../compaction-profile.cjs')
const { runtimeRequire } = require('../pi-profile.cjs')

function writeProfile(doc) {
  const YAML = runtimeRequire('yaml')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'andrey-compaction-'))
  const file = path.join(root, 'cordis.patch.yml')
  fs.writeFileSync(file, YAML.stringify(doc))
  return file
}

function readProfile(file) {
  const YAML = runtimeRequire('yaml')
  return YAML.parse(fs.readFileSync(file, 'utf8'))
}

test('a 200k freePi route with a 32k answer budget condenses at 166k', () => {
  assert.equal(
    profile.compactTriggerTokens({ contextWindow: 200000, reservedTokens: profile.OUTPUT_TOKENS }),
    166232,
  )
})

test('the same route with a 120k catalogue answer budget condensed at 79k', () => {
  assert.equal(profile.compactTriggerTokens({ contextWindow: 200000, reservedTokens: 120000 }), 79000)
})

test('the default package policy is what used to fire at 126k', () => {
  const legacy = profile.compactTriggerTokens({
    contextWindow: 200000,
    reservedTokens: 8192,
    headroomTokens: 65536,
    thresholdRatio: 0.8,
  })
  assert.equal(legacy, 126272)
})

test('a small window keeps its own per-model policy', () => {
  assert.equal(
    profile.compactTriggerTokens({ contextWindow: 40960, reservedTokens: 4096, headroomTokens: 8192 }),
    28672,
  )
})

test('the profile gets the trigger keys and keeps its model policies', () => {
  const file = writeProfile([
    { id: 'llm-pi-ai', config: { providers: {} } },
    {
      id: 'compaction-basic',
      config: {
        modelPolicies: [{ provider: 'freepi', model: 'glm-5.3-flash', maxTokens: 8192, headroomTokens: 8192 }],
      },
    },
  ])

  assert.deepEqual(profile.applyCompactionProfileSync({ profilePath: file }), { ok: true, changed: true })
  const entry = readProfile(file).find((item) => item.id === 'compaction-basic')
  assert.equal(entry.config.thresholdRatio, profile.THRESHOLD_RATIO)
  assert.equal(entry.config.headroomTokens, profile.HEADROOM_TOKENS)
  assert.equal(entry.config.maxTokens, profile.MAX_TOKENS)
  assert.equal(entry.config.modelPolicies[0].headroomTokens, 8192)
})

test('freePi answer budgets are capped, other providers are left alone', () => {
  const file = writeProfile([
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          freepi: { models: [{ id: 'deepseek-v4.1-flash', maxTokens: 120000 }, { id: 'glm-5.3-flash', maxTokens: 8192 }] },
          discovery: { models: [{ id: 'Sage-A1.5', maxTokens: 28000 }] },
        },
      },
    },
    { id: 'compaction-basic', config: {} },
  ])

  assert.deepEqual(profile.applyCompactionProfileSync({ profilePath: file }), { ok: true, changed: true })
  const providers = readProfile(file).find((item) => item.id === 'llm-pi-ai').config.providers
  assert.deepEqual(providers.freepi.models.map((model) => model.maxTokens), [32768, 32768])
  assert.equal(providers.discovery.models[0].maxTokens, 28000)
})

test('a second boot does not rewrite the profile', () => {
  const file = writeProfile([{ id: 'compaction-basic', config: {} }])
  profile.applyCompactionProfileSync({ profilePath: file })
  assert.deepEqual(profile.applyCompactionProfileSync({ profilePath: file }), { ok: true, changed: false })
})

test('a profile without the compaction entry gets one, so the base entry is patched', () => {
  const file = writeProfile([{ id: 'llm-pi-ai', config: {} }])
  assert.deepEqual(profile.applyCompactionProfileSync({ profilePath: file }), { ok: true, changed: true })
  const entry = readProfile(file).find((item) => item.id === 'compaction-basic')
  assert.equal(entry.config.thresholdRatio, profile.THRESHOLD_RATIO)
  assert.equal(entry.config.maxTokens, profile.MAX_TOKENS)
})
