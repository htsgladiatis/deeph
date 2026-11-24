'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { applyBrowserProfileSync, ENTRY_ID, PLUGIN, SERVER_NAME } = require('../browser-profile.cjs')
const { runtimeRequire } = require('../pi-profile.cjs')

const YAML = runtimeRequire('yaml')

function setup(initial = '[]') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrey-browser-profile-'))
  const profilePath = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(profilePath, typeof initial === 'string' ? initial : YAML.stringify(initial))
  const mcpServerPath = path.join(dir, 'browser', 'mcp-server.cjs')
  return { dir, profilePath, mcpServerPath, nodePath: process.execPath }
}

const readProfile = (profilePath) => YAML.parse(fs.readFileSync(profilePath, 'utf8'))

/** Our entry, wherever the patch list holds it: inside an insert or as a plain row. */
function findEntry(doc) {
  for (const patch of doc) {
    const rows = patch && Array.isArray(patch.insert) ? patch.insert : [patch]
    for (const row of rows) if (row && row.id === ENTRY_ID) return row
  }
  return null
}

test('the browser entry is inserted inside an insert patch, not appended as an override', () => {
  const { profilePath, mcpServerPath, nodePath, dir } = setup([{ id: 'llm-pi-ai', config: {} }])
  const result = applyBrowserProfileSync({ profilePath, mcpServerPath, nodePath, dataRoot: dir })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)

  const doc = readProfile(profilePath)
  // The override row is still first and untouched; our plugin arrives inside insert.
  assert.equal(doc[0].id, 'llm-pi-ai')
  const patch = doc.find((item) => Array.isArray(item.insert))
  assert.ok(patch, 'an insert patch exists')
  const entry = patch.insert.find((row) => row.id === ENTRY_ID)
  assert.equal(entry.name, PLUGIN)
  assert.equal(entry.config.serverName, SERVER_NAME)
  assert.equal(entry.config.transport, 'stdio')
  assert.equal(entry.config.command, nodePath)
  assert.deepEqual(entry.config.args, [mcpServerPath])
  assert.equal(entry.config.env.ANDREY_DATA_ROOT, dir)
  assert.equal(entry.config.failOnStartupError, false)
})

test('a second run is a no-op and keeps the rest of the profile', () => {
  const { profilePath, mcpServerPath, nodePath, dir } = setup()
  applyBrowserProfileSync({ profilePath, mcpServerPath, nodePath, dataRoot: dir })
  const afterFirst = fs.readFileSync(profilePath, 'utf8')
  const again = applyBrowserProfileSync({ profilePath, mcpServerPath, nodePath, dataRoot: dir })
  assert.deepEqual(again, { ok: true, changed: false })
  assert.equal(fs.readFileSync(profilePath, 'utf8'), afterFirst)
})

test('a changed script path, node path or data root rewrites the entry', () => {
  const { profilePath, mcpServerPath, nodePath, dir } = setup()
  applyBrowserProfileSync({ profilePath, mcpServerPath, nodePath, dataRoot: dir })
  const moved = applyBrowserProfileSync({ profilePath, mcpServerPath: mcpServerPath + '.new', nodePath, dataRoot: dir })
  assert.equal(moved.changed, true)
  assert.deepEqual(findEntry(readProfile(profilePath)).config.args, [mcpServerPath + '.new'])

  const otherRoot = applyBrowserProfileSync({ profilePath, mcpServerPath: mcpServerPath + '.new', nodePath, dataRoot: path.join(dir, 'other') })
  assert.equal(otherRoot.changed, true)
  assert.equal(findEntry(readProfile(profilePath)).config.env.ANDREY_DATA_ROOT, path.join(dir, 'other'))
})

test('a plain override row with our id is replaced by an insert patch', () => {
  const legacy = '- id: ' + ENTRY_ID + "\n  name: '" + PLUGIN + "'\n  config:\n    transport: stdio\n"
  const { profilePath, mcpServerPath, nodePath, dir } = setup(legacy)
  assert.equal(applyBrowserProfileSync({ profilePath, mcpServerPath, nodePath, dataRoot: dir }).changed, true)
  const doc = readProfile(profilePath)
  assert.equal(doc.some((item) => item.id === ENTRY_ID), false)
  assert.equal(findEntry(doc).name, PLUGIN)
})

test('comments and other patches survive byte for byte', () => {
  const original = [
    '# user patch layer',
    '- id: llm-pi-ai',
    '  config:',
    '    keep: 1',
    '',
    '- insert:',
    '    - id: demo',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '',
    '# trailing note',
    '',
  ].join('\n')
  const { profilePath, mcpServerPath, nodePath, dir } = setup(original)
  applyBrowserProfileSync({ profilePath, mcpServerPath, nodePath, dataRoot: dir })
  const text = fs.readFileSync(profilePath, 'utf8')
  assert.ok(text.startsWith('# user patch layer\n- id: llm-pi-ai\n'))
  assert.ok(text.includes("# trailing note"))
  assert.ok(text.includes('- id: demo'))
})

test('a missing profile or arguments never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrey-browser-profile-'))
  assert.equal(applyBrowserProfileSync({ profilePath: path.join(dir, 'nope.yml'), mcpServerPath: 'x' }).ok, false)
  assert.equal(applyBrowserProfileSync({}).ok, false)
})
