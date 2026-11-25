/**
 * Regression test: a saved manual preset must be the one on screen (web/aura.js).
 *
 * Like tests/test_page_gate_and_catalog.mjs this runs in plain Node: the page
 * script is evaluated in a vm context with just enough browser surface stubbed
 * to boot it (DOM elements, a WebGL2/AudioContext/WebSocket shim and a virtual
 * clock) and is then driven through the same window.__aura API the e2e suite
 * drives over CDP. Nothing here needs Chrome or a network.
 *
 * Covered:
 *   1. reload — a config carrying a manual preset (auto_preset off) boots into
 *      that preset. The page reads /api/config before the visualiser exists, so
 *      the name used to be dropped and the first frame came up on the family
 *      default instead;
 *   2. live — a config event pushed over the socket switches to the preset on
 *      the open page (the server's half of that contract is covered by
 *      tests/test_server.py::test_control_preset_reaches_open_pages).
 *
 * Run: node --test tests/test_web_saved_preset.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const AURA_JS = path.join(ROOT, 'web', 'aura.js')
const TOKEN = 'e2etok0123456789'

// The real curated catalog: the family of a preset is what decides whether the
// boot-time pick could ever land on it by accident.
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'presets.json'), 'utf8'))
const CATALOG_NAMES = CATALOG.presets.map(p => p.name)
const VENDOR_PRESETS = Object.fromEntries(CATALOG_NAMES.map(n => [n, { name: n }]))

// "balanced" (the default behaviour) prefers the liquid family; this one is not.
const SAVED = 'Flexi + Martin - cascading decay swing'
const SAVED_FAMILY = 'organic'
const LIVE_PRESET = 'suksma - vector exp 1 - couldn′t not'

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

// ------------------------------------------------------------------ stubs

function makeStyle() {
  const props = Object.create(null)
  return {
    setProperty(k, v) { props[k] = String(v) },
    getPropertyValue(k) { return props[k] === undefined ? '' : props[k] },
    removeProperty(k) { delete props[k] }
  }
}

function makeElement(id, tag, gl) {
  const listeners = Object.create(null)
  const el = {
    id,
    tagName: (tag || 'div').toUpperCase(),
    style: makeStyle(),
    dataset: Object.create(null),
    attrs: Object.create(null),
    classes: new Set(),
    hidden: false,
    textContent: '',
    value: '',
    disabled: false,
    width: 0,
    height: 0,
    listeners,
    classList: {
      add: c => el.classes.add(c),
      remove: c => el.classes.delete(c),
      contains: c => el.classes.has(c)
    },
    setAttribute(k, v) { el.attrs[k] = String(v) },
    getAttribute(k) { return el.attrs[k] === undefined ? null : el.attrs[k] },
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn) },
    removeEventListener(type, fn) {
      const list = listeners[type]
      if (!list) return
      const i = list.indexOf(fn)
      if (i !== -1) list.splice(i, 1)
    },
    dispatch(type, event) {
      for (const fn of (listeners[type] || []).slice()) fn(event || { type })
    },
    getBoundingClientRect: () => ({ width: 800, height: 450, left: 0, top: 0, right: 800, bottom: 450 }),
    querySelector: () => makeElement(id + '-label', 'span', gl),
    getContext: () => gl
  }
  return el
}

function makeGl() {
  return {
    COLOR_BUFFER_BIT: 16384,
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    drawingBufferWidth: 360,
    drawingBufferHeight: 203,
    clearColor() {},
    clear() {},
    readPixels() {},
    getExtension(name) {
      return name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 37445 } : null
    },
    getParameter() { return 'ANGLE Regression GPU' }
  }
}

function makeParam(value) {
  return {
    value,
    cancelScheduledValues() {},
    setValueAtTime(v) { this.value = v },
    linearRampToValueAtTime(v) { this.value = v }
  }
}

function makeAudioContextClass() {
  return class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000
      this.currentTime = 0
      this.state = 'running'
      this.destination = { connect() {} }
      this.audioWorklet = { addModule: async () => {} }
    }
    createGain() { return { gain: makeParam(1), connect() {}, disconnect() {} } }
    createBiquadFilter() {
      return { type: 'lowpass', frequency: makeParam(0), Q: makeParam(0), connect() {} }
    }
    createOscillator() { return { type: 'sine', frequency: makeParam(0), connect() {}, start() {} } }
    createBufferSource() { return { buffer: null, loop: false, connect() {}, start() {} } }
    createBuffer(channels, length) {
      return { getChannelData: () => new Float64Array(length) }
    }
    resume() { this.state = 'running'; return Promise.resolve() }
    addEventListener() {}
  }
}

/** Boot one page instance with a virtual clock; returns the driver. */
async function loadPage(opts = {}) {
  const clock = { now: 0, seq: 0, timers: new Map() }
  const setTimer = (fn, ms, repeat) => {
    const id = ++clock.seq
    clock.timers.set(id, { fn, due: clock.now + Math.max(0, ms || 0), repeat: repeat || 0 })
    return id
  }

  const gl = makeGl()
  const els = new Map()
  const sockets = []
  const config = Object.assign({
    enabled: true, intensity: 0.6, opacity: 0.75, behavior: 'balanced',
    motion: 'music', mood_reactive: true, accent_pulse: true,
    auto_preset: true, reduced_motion: false, capture: 'pulseaudio'
  }, opts.config || {})

  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    URLSearchParams,
    AbortController: class FakeAbortController {
      constructor() { this.signal = {} }
      abort() {}
    },
    performance: { now: () => clock.now },
    setTimeout: (fn, ms) => setTimer(fn, ms, 0),
    clearTimeout: id => clock.timers.delete(id),
    setInterval: (fn, ms) => setTimer(fn, ms, Math.max(1, ms || 1)),
    clearInterval: id => clock.timers.delete(id),
    requestAnimationFrame: fn => setTimer(fn, 16, 0),
    cancelAnimationFrame: id => clock.timers.delete(id),
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    AudioContext: makeAudioContextClass(),
    AudioWorkletNode: class FakeWorkletNode {
      constructor() { this.port = { onmessage: null, postMessage() {} } }
      connect() {}
      disconnect() {}
    },
    WebSocket: class FakeWebSocket {
      constructor(url) {
        this.url = url
        this.readyState = 0
        this.binaryType = ''
        this.bufferedAmount = 0
        sockets.push(this)
      }
      close() { this.readyState = 3 }
    },
    document: {
      readyState: 'complete',
      hidden: false,
      visibilityState: 'visible',
      documentElement: makeElement('html', 'html', gl),
      body: makeElement('body', 'body', gl),
      getElementById: id => (els.has(id) ? els.get(id) : (els.set(id, makeElement(id, 'div', gl)), els.get(id))),
      createElement: tag => makeElement('created-' + tag, tag, gl),
      addEventListener() {}
    },
    fetch: async url => {
      const route = String(url)
      const table = opts.routes || {}
      if (Object.prototype.hasOwnProperty.call(table, route)) {
        const hit = table[route]
        return { ok: hit.ok !== false, status: hit.status || 200, json: async () => hit.json }
      }
      if (route.indexOf('presets.json') !== -1) {
        return { ok: true, status: 200, json: async () => CATALOG }
      }
      if (route.indexOf('/healthz') !== -1) {
        return { ok: true, status: 200, json: async () => ({ ok: true, capture: 'pulseaudio', rate: 48000 }) }
      }
      if (route.indexOf('/api/config') !== -1) {
        return { ok: true, status: 200, json: async () => config }
      }
      if (route.indexOf('/api/state') !== -1) {
        return { ok: true, status: 200, json: async () => ({ enabled: true, intensity: 0.6, mood: 'idle' }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  const context = vm.createContext(sandbox)

  sandbox.location = { search: '?token=' + TOKEN, protocol: 'http:', host: '127.0.0.1:8765' }
  vm.runInContext(
    'window.butterchurn = { createVisualizer: function (ctx, canvas, opts) { ' +
    'window.__vizCalls = window.__vizCalls || []; ' +
    'return { loadPreset: function (p, blend) { window.__vizCalls.push([p && p.name, blend]); }, ' +
    'setRendererSize: function () {}, connectAudio: function () {}, render: function () {} }; } };' +
    'window.butterchurnPresets = { getPresets: function () { return window.__vendorPresets; } };',
    context
  )
  sandbox.__vendorPresets = VENDOR_PRESETS
  vm.runInContext(fs.readFileSync(AURA_JS, 'utf8'), context, { filename: 'web/aura.js' })

  for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve))

  return {
    sandbox,
    aura: sandbox.window.__aura,
    snap: () => sandbox.window.__aura.snapshot(),
    vizCalls: () => vm.runInContext('window.__vizCalls || []', context),
    loadedNames: () => (vm.runInContext('window.__vizCalls || []', context)).map(c => c[0]),
    openSocket() {
      const ws = sockets[sockets.length - 1]
      assert.ok(ws, 'the page never opened a stream socket')
      ws.readyState = 1
      ws.onopen({})
    },
    /** Push one server text event the way the socket delivers it. */
    pushEvent(obj) {
      const ws = sockets[sockets.length - 1]
      assert.ok(ws, 'the page never opened a stream socket')
      ws.onmessage({ data: JSON.stringify(obj) })
    }
  }
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve))
}

// ------------------------------------------------------------------ tests

await record('a saved manual preset boots on screen after a reload', async () => {
  // Guard the premise: with auto presets off and a balanced profile the page
  // would pick a liquid preset, so this organic one can only come from config.
  const familyDefault = CATALOG.presets
    .filter(p => p.family === 'liquid')
    .sort((a, b) => (b.beat || 0) - (a.beat || 0))[0]
  assert.ok(familyDefault, 'presets.json carries no liquid preset to compare against')
  assert.notEqual(familyDefault.name, SAVED, 'the saved preset must not be the family default')

  const page = await loadPage({
    config: { auto_preset: false, preset: SAVED, behavior: 'balanced' }
  })
  await flush()
  const snap = page.snap()
  const loaded = page.loadedNames()
  assert.ok(loaded.length > 0, 'the visualizer never got a preset')
  assert.equal(snap.preset, SAVED,
    'the page booted on ' + JSON.stringify(snap.preset) + ' instead of the saved preset ' +
    JSON.stringify(SAVED) + ' (the saved name is applied before the visualizer exists and dropped)')
  assert.equal(snap.presetFamily, SAVED_FAMILY, 'the loaded preset is not the saved one')
  assert.equal(loaded[loaded.length - 1], SAVED, 'the saved preset never reached the visualizer')
})

await record('a config event moves the open page to the manual preset', async () => {
  const page = await loadPage({ config: { auto_preset: false } })
  await flush()
  const before = page.snap().preset
  assert.notEqual(before, LIVE_PRESET, 'the page already started on the preset under test')

  page.openSocket()
  await flush()
  page.pushEvent({
    type: 'config', enabled: true, intensity: 0.6, opacity: 0.75,
    behavior: 'balanced', auto_preset: false, preset: LIVE_PRESET
  })
  await flush()

  const snap = page.snap()
  assert.equal(snap.preset, LIVE_PRESET, 'the config event did not switch the preset')
  assert.equal(page.loadedNames()[page.loadedNames().length - 1], LIVE_PRESET,
    'the preset from the config event never reached the visualizer')
})

console.log(results.join('\n'))
console.log(`\n${results.length - failed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
