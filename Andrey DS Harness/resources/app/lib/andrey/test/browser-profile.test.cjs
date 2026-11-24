'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { applyBrowserProfileSync, ENTRY_ID, PLUGIN, SERVER_NAME } = require('../browser-profile.cjs')
const { runtimeRequire } = require('../pi-profile.cjs')

const YAML = runtimeRequire('yaml')

function setup(initial = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrey-browser-profile-'))
  const profilePath = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(profilePath, YAML.stringify(initial))
  const mcpServerPath = path.join(dir, 'browser', 'mcp-server.cjs')
  return { dir, profilePath, mcpServerPath, nodePath: process.execPath }
}

const readProfile = (profilePath) => YAML.parse(fs.readFileSync(profilePath, 'utf8'))

test('the browser entry is appended with the stdio transport', () => {
  const { profilePath, mcpServerPath, nodePath, dir } = setup([{ id: 'llm-pi-ai', config: {} }])
  const result = applyBrowserProfileSync({ profilePath, mcpServerPath, nodePath, dataRoot: dir })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)

  const doc = readProfile(profilePath)
  assert.equal(doc.length, 2)
  const entry = doc.find((item) => item.id === ENTRY_ID)
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
  const again = applyBrowserProfileSync({ profilePath, mcpServerPath, nodePath, dataRoot: dir })
  assert.deepEqual(again, { ok: true, changed: false })
  assert.equal(readProfile(profilePath).length, 1)
})

test('a changed script path, node path or data root rewrites the entry', () => {
  const { profilePath, mcpServerPath, nodePath, dir } = setup()
  applyBrowserProfileSync({ profilePath, mcpServerPath, nodePath, dataRoot: dir })
  const moved = applyBrowserProfileSync({ profilePath, mcpServerPath: mcpServerPath + '.new', nodePath, dataRoot: dir })
  assert.equal(moved.changed, true)
  assert.deepEqual(readProfile(profilePath)[0].config.args, [mcpServerPath + '.new'])

  const otherRoot = applyBrowserProfileSync({ profilePath, mcpServerPath: mcpServerPath + '.new', nodePath, dataRoot: path.join(dir, 'other') })
  assert.equal(otherRoot.changed, true)
  assert.equal(readProfile(profilePath)[0].config.env.ANDREY_DATA_ROOT, path.join(dir, 'other'))
})

test('a wrong name on our id is repaired', () => {
  const { profilePath, mcpServerPath, nodePath, dir } = setup([{ id: ENTRY_ID, name: 'something-else', config: {} }])
  assert.equal(applyBrowserProfileSync({ profilePath, mcpServerPath, nodePath, dataRoot: dir }).changed, true)
  assert.equal(readProfile(profilePath)[0].name, PLUGIN)
})

test('a missing profile or arguments never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrey-browser-profile-'))
  assert.equal(applyBrowserProfileSync({ profilePath: path.join(dir, 'nope.yml'), mcpServerPath: 'x' }).ok, false)
  assert.equal(applyBrowserProfileSync({}).ok, false)
})
