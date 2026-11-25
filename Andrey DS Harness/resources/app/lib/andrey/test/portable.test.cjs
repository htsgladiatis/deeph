'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { resolveDataRoot, ensureProfileSeed, profilePatchPath } = require('../portable.cjs')

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'andrey-portable-'))
}

test('resolveDataRoot: default data root without a portable marker', () => {
  const dir = tmp()
  const { root, portable } = resolveDataRoot({ appData: dir, exeDir: path.join(dir, 'app'), env: {} })
  assert.equal(portable, false)
  assert.equal(root, path.join(dir, 'andrey-ds-harness'))
})

test('resolveDataRoot: portable marker keeps state inside the program folder', () => {
  const dir = tmp()
  const exeDir = path.join(dir, 'app')
  fs.mkdirSync(exeDir, { recursive: true })
  fs.writeFileSync(path.join(exeDir, 'portable.txt'), '')
  const { root, portable } = resolveDataRoot({ appData: dir, exeDir, env: {} })
  assert.equal(portable, true)
  assert.equal(root, path.join(exeDir, 'andrey-data'))
})

test('resolveDataRoot: an explicit ANDREY_DATA_ROOT wins over the app data folder', () => {
  const dir = tmp()
  const { root, portable } = resolveDataRoot({ appData: dir, exeDir: path.join(dir, 'app'), env: { ANDREY_DATA_ROOT: path.join(dir, 'mine') } })
  assert.equal(portable, false)
  assert.equal(root, path.join(dir, 'mine'))
})

test('ensureProfileSeed: a fresh data root gets the starting profile', () => {
  const home = path.join(tmp(), 'dsh-home')
  const result = ensureProfileSeed({ dshHome: home })
  assert.equal(result.ok, true)
  assert.equal(result.created, true)
  const patch = fs.readFileSync(profilePatchPath(home), 'utf8')
  assert.match(patch, /llm-pi-ai/)
  assert.match(patch, /freepi/)
  assert.match(patch, /freebuff/)
  for (const name of ['cordis.yml', 'package.json', 'pnpm-workspace.yaml']) {
    assert.equal(fs.existsSync(path.join(home, 'profiles', 'desktop', name)), true, name)
  }
})

test('ensureProfileSeed: the host placeholder patch is replaced, its manifest kept', () => {
  const home = path.join(tmp(), 'dsh-home')
  const dir = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n')
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "host-made" }\n')
  const result = ensureProfileSeed({ dshHome: home })
  assert.equal(result.created, true)
  assert.match(fs.readFileSync(profilePatchPath(home), 'utf8'), /freepi/)
  assert.match(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), /host-made/)
})

test('ensureProfileSeed: an existing configured profile is left untouched', () => {
  const home = path.join(tmp(), 'dsh-home')
  const dir = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(dir, { recursive: true })
  const mine = '- id: llm-pi-ai\n  config:\n    providers:\n      freepi: {}\n'
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), mine)
  const result = ensureProfileSeed({ dshHome: home })
  assert.equal(result.created, false)
  assert.equal(fs.readFileSync(profilePatchPath(home), 'utf8'), mine)
})
