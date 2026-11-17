'use strict'

/**
 * Token files on disk are encrypted with Electron's safeStorage (OS keychain)
 * when it is available. The file keeps the same JSON shape otherwise, so a
 * legacy plaintext file and a test environment both keep working.
 */
function defaultSafeStorage() {
  try {
    // Required lazily: node --test has no Electron runtime.
    const { safeStorage } = require('electron')
    return safeStorage ?? null
  } catch {
    return null
  }
}

function available(safeStorage) {
  const impl = safeStorage ?? defaultSafeStorage()
  try {
    return Boolean(impl?.isEncryptionAvailable?.())
  } catch {
    return false
  }
}

function protectObject(object, { safeStorage } = {}) {
  const impl = safeStorage ?? defaultSafeStorage()
  if (!object || typeof object !== 'object') return object
  try {
    if (!impl?.isEncryptionAvailable?.()) return object
    const encrypted = impl.encryptString(JSON.stringify(object))
    return { v: 1, enc: Buffer.from(encrypted).toString('base64') }
  } catch {
    return object
  }
}

function unprotectObject(parsed, { safeStorage } = {}) {
  if (!parsed || typeof parsed !== 'object') return null
  if (typeof parsed.enc !== 'string') return parsed
  const impl = safeStorage ?? defaultSafeStorage()
  try {
    const decrypted = impl?.decryptString?.(Buffer.from(parsed.enc, 'base64'))
    if (typeof decrypted !== 'string') return null
    return JSON.parse(decrypted)
  } catch {
    return null
  }
}

module.exports = { protectObject, unprotectObject, available }
