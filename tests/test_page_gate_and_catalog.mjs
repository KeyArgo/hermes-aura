/**
 * Regression tests for the Aura page (web/aura.js), round 2.
 *
 * Like tests/test_desktop_plugin.mjs this runs in plain Node: the page script is
 * evaluated inside a vm context with just enough browser surface stubbed to boot
 * it (DOM elements, a WebGL2/AudioContext/WebSocket shim and a virtual clock),
 * and is then driven through the same window.__aura API the e2e suite drives over
 * CDP. Nothing here needs Chrome or a network.
 *
 * Covered:
 *   1. the silence gate keeps the canvas faded out across an opacity change
 *      (CONTRACT.md §10: only a non-silent frame resumes it at the user's
 *      opacity) — a §2 PCM frame is what lifts the gate, so a bad-frame parse
 *      cannot make the assertion pass by accident;
 *   2. a presets.json that loads but carries no usable preset falls back to the
 *      vendored preset pack instead of leaving a blank frame with no message.
 *
 * Run: node --test tests/test_page_gate_and_catalog.mjs
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

const CATALOG_NAMES = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'web', 'presets.json'), 'utf8')
).presets.map(p => p.name)

// The names a browser would find in vendor/butterchurnPresets when the curated
// catalog is unusable; none of them carry a curated family.
const VENDOR_NAMES = CATALOG_NAMES.concat(['vendored alpha', 'vendored beta', 'vendored gamma'])
const VENDOR_PRESETS = Object.fromEntries(VENDOR_NAMES.map(n => [n, { name: n }]))

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
    appendChild(child) { el.children = (el.children || []).concat([child]); return child },
    removeChild(child) { el.children = (el.children || []).filter(c => c !== child); return child },
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
  const advance = ms => {
    const end = clock.now + ms
    for (;;) {
      let next = null
      for (const [id, t] of clock.timers) {
        if (t.due <= end && (!next || t.due < next[1].due)) next = [id, t]
      }
      if (!next) break
      clock.now = Math.max(clock.now, next[1].due)
      if (next[1].repeat) next[1].due = clock.now + next[1].repeat
      else clock.timers.delete(next[0])
      next[1].fn()
    }
    clock.now = end
  }

  const gl = makeGl()
  const els = new Map()
  const element = id => {
    if (!els.has(id)) els.set(id, makeElement(id, 'div', gl))
    return els.get(id)
  }

  const sockets = []
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    URLSearchParams,
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
    // The page's fetch timeout needs a controller; the real browser has one.
    AbortController: class FakeAbortController {
      constructor() { this.signal = { aborted: false } }
      abort() { this.signal.aborted = true }
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
      documentElement: makeElement('html', 'html', gl),
      body: makeElement('body', 'body', gl),
      getElementById: id => (els.has(id) ? els.get(id) : (els.set(id, makeElement(id, 'div', gl)), els.get(id))),
      createElement: tag => makeElement('created-' + tag, tag, gl),
      addEventListener() {}
    },
    fetch: async (url, init) => {
      const route = String(url)
      const table = opts.routes || {}
      if (Object.prototype.hasOwnProperty.call(table, route)) {
        const hit = table[route]
        return { ok: hit.ok !== false, status: hit.status || 200, json: async () => hit.json }
      }
      if (route.indexOf('presets.json') !== -1) {
        const body = opts.presets === undefined
          ? { presets: CATALOG_NAMES.map(n => ({ name: n, family: 'organic', strobe: false })) }
          : opts.presets
        if (body === null) return { ok: false, status: 404, json: async () => null }
        return { ok: true, status: 200, json: async () => body }
      }
      if (route.indexOf('/healthz') !== -1) {
        return { ok: true, status: 200, json: async () => ({ ok: true, capture: 'pulseaudio', rate: 48000 }) }
      }
      if (route.indexOf('/api/config') !== -1) {
        return {
          ok: true, status: 200,
          json: async () => Object.assign({
            enabled: true, intensity: 0.6, opacity: 0.75, behavior: 'balanced',
            motion: opts.motion || 'music', mood_reactive: true, accent_pulse: true,
            auto_preset: true, reduced_motion: false, capture: 'pulseaudio'
          }, opts.config || {})
        }
      }
      if (route.indexOf('/api/state') !== -1) {
        return { ok: true, status: 200, json: async () => Object.assign({ enabled: true, intensity: 0.6, mood: 'idle' }, opts.state || {}) }
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
    'setRendererSize: function () {}, connectAudio: function () {}, render: function () { window.__renders = (window.__renders || 0) + 1; } }; } };\n' +
    'window.butterchurnPresets = { getPresets: function () { return window.__vendorPresets; } };',
    context
  )
  sandbox.__vendorPresets = VENDOR_PRESETS
  vm.runInContext(fs.readFileSync(AURA_JS, 'utf8'), context, { filename: 'web/aura.js' })

  for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve))

  const ArrayBufferIn = vm.runInContext('ArrayBuffer', context)
  const DataViewIn = vm.runInContext('DataView', context)
  const page = {
    sandbox,
    clock,
    advance,
    els,
    sockets,
    snap: () => sandbox.window.__aura.snapshot(),
    vizCalls: () => vm.runInContext('window.__vizCalls || []', context),
    setVendorPresets(map) { sandbox.__vendorPresets = map },
    /** Drive a CONTRACT.md §2 binary PCM frame through the live socket. */
    sendPcm(fields = {}) {
      const ws = sockets[sockets.length - 1]
      assert.ok(ws, 'the page never opened a stream socket')
      const count = fields.count || 480
      const buf = new ArrayBufferIn(32 + count * 4)
      const dv = new DataViewIn(buf)
      const magic = [0x41, 0x55, 0x52, 0x41]
      for (let i = 0; i < 4; i += 1) dv.setUint8(i, magic[i])
      dv.setUint8(4, 1)
      dv.setUint8(5, fields.silence ? 1 : 0)
      dv.setUint16(6, 32, true)
      dv.setBigUint64(8, BigInt(fields.seq === undefined ? 7 : fields.seq), true)
      dv.setBigUint64(16, BigInt(clock.now), true)
      dv.setUint32(24, fields.rate === undefined ? 48000 : fields.rate, true)
      dv.setUint32(28, count, true)
      for (let i = 0; i < count; i += 1) dv.setFloat32(32 + i * 4, Math.sin(i / 9) * 0.4, true)
      ws.onmessage({ data: buf })
    },
    openSocket() {
      const ws = sockets[sockets.length - 1]
      assert.ok(ws, 'the page never opened a stream socket')
      ws.readyState = 1
      ws.onopen({})
    },
    closeSocket(code) {
      const ws = sockets[sockets.length - 1]
      assert.ok(ws, 'the page never opened a stream socket')
      ws.readyState = 3
      ws.onclose({ code: code || 1006 })
    },
    aura: sandbox.window.__aura
  }
  return page
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve))
}

// ------------------------------------------------------------------ tests

await record('silence gate holds the canvas faded out across an opacity change', async () => {
  const page = await loadPage({ motion: 'music' })
  page.openSocket()
  page.aura.setMotionUI('music')
  assert.equal(page.snap().motion, 'music')

  page.sendPcm({ seq: 3 })
  const playing = page.snap()
  assert.equal(playing.badFrames, 0, 'the §2 frame was rejected: ' + JSON.stringify(playing.errors))
  assert.equal(playing.lastSeq, 3)
  assert.equal(playing.silent, false, 'audio present, the gate must be open')
  assert.equal(playing.canvasOpacity, '0.75')

  // No audio for longer than SILENCE_MS: the canvas fades out and its buffer clears.
  page.advance(1400)
  const quiet = page.snap()
  assert.equal(quiet.silent, true, 'the gate never closed')
  assert.equal(quiet.canvasOpacity, '0')

  // Any control change makes the server broadcast a config event, and that event
  // always carries `opacity`. It must not reveal the cleared drawing buffer.
  page.aura.applyConfig({ opacity: 0.5 })
  const dimmed = page.snap()
  assert.equal(dimmed.opacity, 0.5, 'the opacity setting itself must still be applied')
  assert.equal(dimmed.silent, true, 'the gate must still be holding the canvas')
  assert.equal(dimmed.canvasOpacity, '0',
    'an opacity change un-hid the canvas while the silence gate had it faded out ' +
    '(a cleared WebGL buffer paints an opaque black panel)')

  // Audio brings it back at the user's opacity.
  page.sendPcm({ seq: 4 })
  const back = page.snap()
  assert.equal(back.silent, false)
  assert.equal(back.canvasOpacity, '0.5')
})

await record('an empty presets.json falls back to the vendored preset pack', async () => {
  const page = await loadPage({ motion: 'music', presets: { schema: 1, note: 'truncated file' } })
  await flush()
  const snap = page.snap()
  assert.equal(snap.presetCount > 0, true,
    'presets.json carried no usable presets and the page kept an empty catalog: ' +
    'no preset can ever load, so the canvas stays blank with no message')
  assert.equal(snap.preset, snap.presetAnchor, 'no preset was loaded into the visualizer')
  assert.equal(snap.presetFamily, 'misc', 'the catalog did not fall back to the vendored preset pack')
  assert.equal(snap.fallbackActive, false, 'the vendored pack needs no hard fallback')
  const loaded = page.vizCalls().map(c => c[0])
  assert.ok(loaded.length > 0, 'the visualizer never got a preset')
  assert.equal(snap.errors.some(e => /presets/i.test(e)), true,
    'a preset catalog failure must be recorded, never silent')

  // The 404 path keeps working after the fallback was shared between the two.
  const missing = await loadPage({ motion: 'music', presets: null })
  await flush()
  const missingSnap = missing.snap()
  assert.equal(missingSnap.presetCount > 0, true, 'a 404 presets.json lost the catalog too')
  assert.equal(missingSnap.presetFamily, 'misc')
  assert.ok(missing.vizCalls().length > 0, 'no preset loaded after a 404 presets.json')
})

await record('intensity: the drawn reaction is the slider value, not a floor plus a curve', async () => {
  const page = await loadPage({ motion: 'music', config: { intensity: 1 } })
  page.openSocket()
  page.sendPcm({ seq: 11 })
  assert.equal(page.snap().badFrames, 0, 'the §2 frame was rejected: ' + JSON.stringify(page.snap().errors))

  // Let the slow auto-gain envelope settle at each level: it normalises quiet
  // capture, so it must not be what makes the numbers move.
  const settle = level => {
    page.aura.setIntensityUI(level)
    for (let i = 0; i < 60; i += 1) {
      page.sendPcm({ seq: 12 + i, silence: false })
      page.advance(20)
    }
    return page.aura._drawnPcmPeak()
  }

  const full = settle(1)
  const half = settle(0.5)
  const quarter = settle(0.25)
  const off = settle(0)

  assert.ok(full > 0.05, `the full setting drew nothing (peak ${full})`)
  assert.equal(off, 0, `intensity 0 still handed ${off.toFixed(3)} to the visualizer: ` +
    'a 0 setting must mean no audio reaction')
  assert.ok(Math.abs(half / full - 0.5) < 0.05,
    `intensity 0.5 drew ${(half / full).toFixed(3)} of what 1.0 drew, not 0.500: ` +
    'the slider value is being remapped before it reaches the visualizer')
  assert.ok(Math.abs(quarter / full - 0.25) < 0.05,
    `intensity 0.25 drew ${(quarter / full).toFixed(3)} of what 1.0 drew, not 0.250: ` +
    'the slider value is being remapped before it reaches the visualizer')
})

await record('opacity: the page applies the setting to its canvas exactly once', async () => {
  const page = await loadPage({ motion: 'music', config: { opacity: 0.25 } })
  page.openSocket()
  page.sendPcm({ seq: 21 })
  const lit = page.snap()
  assert.equal(lit.opacity, 0.25, 'the saved opacity was not applied to the page')
  assert.equal(lit.canvasOpacity, '0.25',
    'the canvas does not carry the setting itself: ' + lit.canvasOpacity)
  assert.equal(Number(lit.scrimOpacity), 0.8875,
    'the scrim compensation broke: ' + lit.scrimOpacity)

  page.aura.setOpacityUI(0.4)
  page.sendPcm({ seq: 22 })
  const moved = page.snap()
  assert.equal(moved.canvasOpacity, '0.4', 'moving the slider did not reach the canvas')
  assert.equal(Number(moved.scrimOpacity), 0.91, 'the scrim did not follow the slider')
})

console.log(results.join('\n'))
console.log(`\n${results.length - failed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
