/**
 * Diagnostics tests for the Aura desktop half (desktop/plugin.js).
 *
 * The owner wants to catch problems — including memory growth — without a
 * network call. The desktop half keeps a ring buffer of the last 200 events
 * (errors, poll failures, the poll lifecycle) and samples performance.memory
 * every five minutes where the host exposes it.
 *
 * This file proves, headlessly and with a fake clock:
 *
 *   a. the heap sampler's interval is >= 5 minutes, and it is the only new
 *      timer (the 250 ms poll tick stays the first interval);
 *   b. the ring caps at 200 events, dropping the oldest;
 *   c. while Aura is Off nothing is recorded except the heap sample;
 *   d. the heap sample reads performance.memory.usedJSHeapSize;
 *   e. a failed /status poll lands in the ring as poll-fail;
 *   f. dispose clears every timer (including the sampler) and nothing is
 *      recorded afterwards;
 *   g. Copy diagnostics copies real JSON, never the token, and reports
 *      failure truthfully when the clipboard is unavailable;
 *   h. the poll lifecycle is recorded (poll-start / poll-stop) while On.
 *
 * Same wiring as tests/test_idle_poll.mjs: a temp copy has its three import
 * specifiers rewritten to local stubs. The diag internals are driven through
 * the plugin's own __test export.
 *
 * Run: node tests/test_diag_desktop.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGIN = process.env.AURA_PLUGIN || path.join(ROOT, 'desktop', 'plugin.js')

const results = []
let failed = 0

async function record(name, fn) {
  try {
    await fn()
    results.push(`PASS ${name}`)
  } catch (error) {
    failed += 1
    results.push(`FAIL ${name}: ${error && error.message ? error.message : error}`)
  }
}

// ------------------------------------------------------------------ fake clock
const clock = { now: 1_700_000_000_000 }
Date.now = () => clock.now

// ------------------------------------------------------------- host stubs
// performance.memory is Chromium-only; the stub makes the heap path testable.
const heap = { usedJSHeapSize: 10_000_000, totalJSHeapSize: 20_000_000, jsHeapSizeLimit: 4_000_000_000 }
Object.defineProperty(globalThis, 'performance', {
  value: { now: () => clock.now, memory: heap },
  configurable: true
})
const copied = []
let clipboardAvailable = true
Object.defineProperty(globalThis, 'navigator', {
  value: {
    clipboard: {
      writeText: async text => {
        if (!clipboardAvailable) throw new Error('clipboard denied')
        copied.push(text)
      }
    }
  },
  configurable: true
})

function makeElement(tagName) {
  const node = {
    tagName: String(tagName).toUpperCase(),
    style: {},
    attributes: {},
    children: [],
    parentNode: null,
    textContent: '',
    dataset: {},
    __handlers: {},
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return this.attributes[name] },
    removeAttribute(name) { delete this.attributes[name] },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child },
    removeChild(child) {
      const index = this.children.indexOf(child)
      if (index >= 0) this.children.splice(index, 1)
      return child
    },
    addEventListener(type, fn) { (this.__handlers[type] || (this.__handlers[type] = [])).push(fn) },
    removeEventListener(type, fn) { this.__handlers[type] = (this.__handlers[type] || []).filter(e => e !== fn) },
    dispatch(type, event) { for (const fn of (this.__handlers[type] || []).slice()) fn(event || { type }) },
    getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 } },
    remove() { if (this.parentNode) this.parentNode.removeChild(this) },
    get firstChild() { return this.children[0] || null }
  }
  return node
}

function makeParent() {
  const children = []
  const classes = new Set()
  return {
    children,
    style: {},
    className: '',
    classList: {
      add: name => classes.add(name),
      remove: (...names) => names.forEach(n => classes.delete(n)),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: name => classes.has(name)
    },
    appendChild(node) { node.parentNode = this; children.push(node); return node },
    removeChild(node) {
      const index = children.indexOf(node)
      if (index >= 0) children.splice(index, 1)
      node.parentNode = null
      return node
    }
  }
}

globalThis.document = {
  hidden: false,
  visibilityState: 'visible',
  documentElement: { style: {}, setAttribute() {}, getAttribute() { return null }, removeAttribute() {}, hasAttribute() { return false } },
  head: makeParent(),
  body: makeParent(),
  createElement: makeElement,
  addEventListener() {},
  removeEventListener() {}
}
globalThis.getComputedStyle = () => ({ backgroundColor: 'rgba(0, 0, 0, 0)', getPropertyValue: () => '' })

// ------------------------------------------------------------- temp module
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aura-diag-desktop-test-'))
const pluginCopy = path.join(tmp, 'plugin.mjs')
const source = fs.readFileSync(PLUGIN, 'utf8')
fs.writeFileSync(
  pluginCopy,
  source
    .replace(/from\s+'@hermes\/plugin-sdk'/g, "from './sdk-stub.mjs'")
    .replace(/from\s+'react'/g, "from './react-stub.mjs'")
    .replace(/from\s+'react\/jsx-runtime'/g, "from './jsx-stub.mjs'")
)

fs.writeFileSync(path.join(tmp, 'sdk-stub.mjs'), `
function makeAtom(initial) {
  let value = initial
  return { get: () => value, set: next => { value = next }, listen: () => () => {} }
}
export const atom = makeAtom
export const $accentOverride = makeAtom(null)
export const setAccentOverride = () => {}
export const requestTheme = () => true
export const host = {
  state: { focusedStoredSessionId: { get: () => 'chat/1' } },
  navigate: () => {},
  notify: () => {}
}
export const useValue = store => store.get()
export const useTheme = () => ({
  themeName: 'nous', theme: { name: 'nous', colors: {} },
  setTheme: () => {}, mode: 'dark', resolvedMode: 'dark', renderedMode: 'dark',
  availableThemes: [], setMode: () => {}, previewTheme: () => {}, clearThemePreview: () => {}
})
export const Button = () => null
export const Switch = () => null
export const SandboxedFrame = () => null
export const Popover = () => null
export const PopoverTrigger = () => null
export const PopoverContent = () => null
export const PALETTE_AREA = 'palette'
export const PANES_AREA = 'panes'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
export const SETTINGS_PLUGINS_AREA = 'settings.plugins'
export const THEMES_AREA = 'themes'
export const TITLEBAR_AREAS = { center: 'titleBar.center', left: 'titleBar.left', right: 'titleBar.right' }
`)

fs.writeFileSync(path.join(tmp, 'react-stub.mjs'), `
export const Fragment = Symbol.for('react.fragment')
export function useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] }
export function useEffect() {}
export function useLayoutEffect() {}
export function useRef(value) { return { current: value } }
export function useMemo(fn) { return fn() }
export function useCallback(fn) { return fn }
`)

fs.writeFileSync(path.join(tmp, 'jsx-stub.mjs'), `
export function jsx(type, props, key) { return { type, props, key } }
export const jsxs = jsx
export const Fragment = Symbol.for('react.fragment')
`)

const plugin = await import(pathToFileURL(pluginCopy).href)
const diag = plugin.__test
assert.ok(diag && typeof diag.diagNote === 'function', 'the plugin exposes no diagnostics __test surface')

// ------------------------------------------------------------------- harness
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/** One registration bucket: its own ctx, request log and interval records. */
function mount(settings, serverEnabled, opts = {}) {
  const storage = new Map()
  const contributions = []
  if (settings) storage.set('settings', settings)
  storage.set('userChoseOff', settings ? settings.enabled !== true : false)
  const requests = []
  const intervals = []
  const ctx = {
    source: 'plugin:aura',
    os: { openExternal: () => true },
    register(contribution) {
      contributions.push(contribution)
      return () => { contribution.removed = true }
    },
    registerSettingsPage(page) { return ctx.register(page) },
    onDispose() {},
    setInterval(fn, ms) {
      const record = { fn, ms, cleared: false }
      intervals.push(record)
      return () => { record.cleared = true }
    },
    setTimeout() { return () => {} },
    addEventListener() { return () => {} },
    storage: {
      get(key, fallback) { return storage.has(key) ? storage.get(key) : fallback },
      set(key, value) { storage.set(key, value) },
      remove(key) { storage.delete(key) }
    },
    async rest(route, options = {}) {
      requests.push(route)
      if (route === '/status') {
        if (opts.failStatus) throw new Error('connection refused')
        return { ok: true, port: 4321, url: 'http://127.0.0.1:4321/?token=sekrit-token-value', capture: 'none', enabled: serverEnabled }
      }
      if (route === '/state') {
        if (opts.failState) throw new Error('state went away')
        return { level: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0], silence: true, mood: 'idle', audio_requests: [] }
      }
      if (route === '/version') return { version: '1.0.0', commit: 'diag-test' }
      if (route === '/player') return { ok: true, window: { open: false }, player: {}, seq: 0 }
      if (route === '/control') return { ok: true, ...(options.body || {}) }
      return { ok: true }
    }
  }
  const dispose = plugin.default.register(ctx)
  return {
    dispose,
    requests,
    intervals,
    contributions,
    liveIntervals: () => intervals.filter(record => !record.cleared)
  }
}

const kinds = ring => ring.map(event => event.kind)

// ------------------------------------------------------------------ the checks

await record('a. the heap sampler interval is >= 5 min and the poll tick stays first', async () => {
  assert.ok(diag.DIAG_SAMPLE_MS >= 300000, `DIAG_SAMPLE_MS is ${diag.DIAG_SAMPLE_MS}`)
  const bucket = mount({ enabled: true }, true)
  await settle()
  const live = bucket.liveIntervals()
  assert.equal(live[0].ms, 250, 'the first interval is no longer the 250 ms poll tick')
  const sampler = live.find(record => record.ms >= 300000)
  assert.ok(sampler, 'no five-minute diagnostics interval was registered')
  assert.equal(sampler.ms, diag.DIAG_SAMPLE_MS)
  // No other new timer: only the poll tick and the sampler are live.
  assert.equal(live.length, 2, `expected 2 live intervals, got ${live.length}`)
  bucket.dispose()
  await settle()
})

await record('b. the ring caps at 200 events, dropping the oldest', async () => {
  const bucket = mount({ enabled: true }, true)
  await settle()
  for (let i = 0; i < 250; i += 1) diag.diagNote('error', 'e' + i)
  assert.equal(diag.diagRing.length, diag.DIAG_RING_MAX)
  assert.equal(diag.DIAG_RING_MAX, 200)
  // 250 notes into a 200-cap ring: the oldest 50 notes (and any boot events)
  // are gone, so the first kept note is e50 and the last is e249.
  assert.equal(diag.diagRing[0].detail, 'e50')
  assert.equal(diag.diagRing[diag.diagRing.length - 1].detail, 'e249')
  bucket.dispose()
  await settle()
})

await record('c. while Aura is Off only the heap sample is recorded', async () => {
  const bucket = mount({ enabled: false }, false)
  await settle()
  // The boot baseline heap sample is allowed even while Off.
  assert.ok(kinds(diag.diagRing).every(kind => kind === 'heap'), 'an Off Aura recorded a non-heap event')
  const before = diag.diagRing.length
  diag.diagNote('error', 'must not land')
  diag.diagNote('poll-fail', { route: '/status' })
  diag.diagNote('poll-start')
  assert.equal(diag.diagRing.length, before, 'Off Aura recorded events other than the heap sample')
  diag.diagSampleHeap()
  assert.equal(diag.diagRing.length, before + 1, 'the heap sample must keep running while Off')
  assert.equal(diag.diagRing[diag.diagRing.length - 1].kind, 'heap')
  bucket.dispose()
  await settle()
})

await record('d. the heap sample reads performance.memory.usedJSHeapSize', async () => {
  const bucket = mount({ enabled: true }, true)
  await settle()
  heap.usedJSHeapSize = 123_456_789
  diag.diagSampleHeap()
  const last = diag.diagRing[diag.diagRing.length - 1]
  assert.equal(last.kind, 'heap')
  assert.equal(last.detail.usedJSHeapSize, 123_456_789)
  assert.equal(last.detail.totalJSHeapSize, heap.totalJSHeapSize)
  assert.equal(last.detail.jsHeapSizeLimit, heap.jsHeapSizeLimit)
  assert.equal(typeof last.t, 'number')
  bucket.dispose()
  await settle()
})

await record('e. a failed /status poll lands in the ring as poll-fail', async () => {
  const bucket = mount({ enabled: true }, true, { failStatus: true })
  await settle()
  await settle()
  const fails = diag.diagRing.filter(event => event.kind === 'poll-fail')
  assert.ok(fails.length >= 1, 'a failed /status poll was not recorded')
  assert.equal(fails[0].detail.route, '/status')
  assert.ok(String(fails[0].detail.detail).includes('connection refused'))
  bucket.dispose()
  await settle()
})

await record('f. dispose clears every timer and nothing records afterwards', async () => {
  const bucket = mount({ enabled: true }, true)
  await settle()
  assert.ok(bucket.liveIntervals().length >= 2, 'the sampler was never armed')
  bucket.dispose()
  await settle()
  assert.equal(bucket.liveIntervals().length, 0, 'a timer survived dispose')
  const before = diag.diagRing.length
  diag.diagNote('error', 'after dispose')
  diag.diagSampleHeap()
  diag.startDiagSampler()
  assert.equal(diag.diagRing.length, before, 'diagnostics recorded after dispose')
  assert.equal(bucket.liveIntervals().length, 0, 'startDiagSampler re-armed a timer after dispose')
})

await record('g. Copy diagnostics copies JSON without the token, and reports failure truthfully', async () => {
  const bucket = mount({ enabled: true }, true)
  await settle()
  diag.diagNote('error', 'a recorded problem')
  copied.length = 0
  clipboardAvailable = true
  const ok = await diag.copyDiagnostics()
  assert.equal(ok, true)
  assert.equal(copied.length, 1)
  const report = JSON.parse(copied[0])
  assert.equal(report.source, 'aura-desktop')
  assert.ok(Array.isArray(report.events))
  assert.ok(report.events.some(event => event.kind === 'error' && event.detail === 'a recorded problem'))
  assert.ok(!copied[0].includes('sekrit-token-value'), 'the diagnostics report leaked the token')
  assert.ok(!copied[0].includes('token='), 'the diagnostics report carried a tokenised URL')
  clipboardAvailable = false
  const failedCopy = await diag.copyDiagnostics()
  assert.equal(failedCopy, false, 'a denied clipboard must report failure, not "copied"')
  clipboardAvailable = true
  bucket.dispose()
  await settle()
})

await record('h. the poll lifecycle is recorded while On', async () => {
  const bucket = mount({ enabled: true }, true)
  await settle()
  assert.ok(kinds(diag.diagRing).includes('poll-start'), 'no poll-start event at register')
  bucket.dispose()
  await settle()
  assert.ok(kinds(diag.diagRing).includes('poll-stop'), 'no poll-stop event at dispose')
})

// ------------------------------------------------------------------- report
for (const line of results) console.log(line)
console.log(`${results.length - failed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
