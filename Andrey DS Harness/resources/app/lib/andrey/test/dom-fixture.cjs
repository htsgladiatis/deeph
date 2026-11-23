'use strict'

/**
 * A fake renderer page for tests.
 *
 * The injected bundle is a classic script that talks to document, localStorage
 * and fetch; this module gives it enough of a page to run under node:test
 * without Electron, and records every listener the bundle registers so a test
 * can dispatch an event the way the real window would.
 */

const vm = require('node:vm')

function element(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    children: [],
    parentNode: null,
    style: new Proxy({}, { get: (target, key) => (key in target ? target[key] : ''), set: (target, key, value) => { target[key] = value; return true } }),
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    dataset: {},
    textContent: '',
    innerHTML: '',
    value: '',
    title: '',
    href: '',
    appendChild(child) { this.children.push(child); child.parentNode = this; return child },
    insertBefore(child) { return this.appendChild(child) },
    removeChild(child) { child.parentNode = null; return child },
    remove() {},
    setAttribute(key, value) { this[key] = value },
    removeAttribute(key) { delete this[key] },
    getAttribute(key) { return this[key] ?? null },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    closest() { return null },
    contains() { return false },
    focus() {},
    blur() {},
    click() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 } },
    getContext() { return null },
    cloneNode() { return element(tag) },
    matches() { return false },
  }
}

function makeContext() {
  const listeners = []
  const document = {
    readyState: 'complete',
    hidden: false,
    cookie: '',
    activeElement: null,
    body: element('body'),
    head: element('head'),
    documentElement: element('html'),
    createElement: (tag) => element(tag),
    createElementNS: (ns, tag) => element(tag),
    createTextNode: (text) => ({ textContent: text }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, fn, options) => { listeners.push({ type, fn, options }) },
    removeEventListener: () => {},
    execCommand: () => true,
  }
  const store = () => {
    const data = {}
    return { getItem: (key) => data[key] ?? null, setItem: (key, value) => { data[key] = String(value) }, removeItem: (key) => { delete data[key] } }
  }
  const page = {
    document,
    location: { href: 'dsh-app://app/', protocol: 'dsh-app:', host: 'app', origin: 'dsh-app://app' },
    navigator: { clipboard: { writeText: () => Promise.resolve() }, userAgent: 'node-test', language: 'ru-RU' },
    localStorage: store(),
    sessionStorage: store(),
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    fetch: () => Promise.reject(new Error('no network in tests')),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    getComputedStyle: () => element('style'),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    addEventListener: (type, fn) => { listeners.push({ type, fn, options: {} }) },
    removeEventListener: () => {},
    devicePixelRatio: 1,
  }
  page.window = page
  page.self = page
  page.top = page
  page.parent = page
  page.globalThis = page
  return { ctx: vm.createContext(page), page, listeners }
}

function runIn(ctx, source, filename) {
  new vm.Script(source, { filename }).runInContext(ctx)
}

module.exports = { makeContext, runIn, element }
