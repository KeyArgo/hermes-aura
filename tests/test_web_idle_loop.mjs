/**
 * Idle-cost regression test for the Aura page render loop (web/aura.js).
 *
 * The loop used to reschedule itself at display rate forever, drawing nothing
 * while Aura was off, while the silence gate had faded the canvas out, while a
 * hard blocker hid it, or while the tab was hidden. It also ran a blocking 1x1
 * readPixels on every 5th frame all day to feed the degrade ladder.
 *
 * This file boots the page in a vm context (fake DOM/WebGL/AudioContext/WS and
 * a virtual clock, same wiring as tests/test_page_gate_and_catalog.mjs) and
 * proves:
 *
 *   a. Aura off: the loop parks (no rAF pending) and enabling restarts it
 *      within one frame;
 *   b. the silence gate parks it, and a non-silent PCM frame resumes it;
 *   c. a hidden tab parks it, and becoming visible restarts it;
 *   d. past the 10 s warm window the GPU sync probe runs at most once per 120
 *      rendered frames, and the full-buffer captureCanvas() readPixels does not
 *      run in normal playback at all;
 *   e. 50 preset loads and 5 automatic quality steps during steady playback
 *      never re-open the dense probe window: still at most one readPixels per
 *      120 frames afterwards (a warm window on every preset/mood/agent change
 *      brought the stall back all evening).
 *
 * Set AURA_WEB=<path> to point the same test at another copy of the page (used
 * to prove the checks fail on the parent commit without touching this tree).
 *
 * Run: node tests/test_web_idle_loop.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const AURA_JS = process.env.AURA_WEB || path.join(ROOT, 'web', 'aura.js')
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
const VENDOR_PRESETS = Object.fromEntries(CATALOG_NAMES.map(n => [n, { name: n }]))

function makeStyle() {
  const props = Object.create(null)
  return {
    setProperty(k, v) { props[k] = String(v) },
    getPropertyValue(k) { return props[k] === undefined ? '' : props[k] },
    removeProperty(k) { delete props[k] }
  }
}

function makeGl(stats) {
  return {
    COLOR_BUFFER_BIT: 16384,
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    drawingBufferWidth: 360,
    drawingBufferHeight: 203,
    clearColor() {},
    clear() {},
    // 1x1 is the loop's sync probe; anything larger is captureCanvas().
    readPixels(x, y, w, h) {
      if (w === 1 && h === 1) stats.probes += 1
      else stats.full += 1
    },
    getExtension(name) {
      return name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 37445 } : null
    },
    getParameter() { return 'ANGLE Regression GPU' }
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
    parentNode: null,
    children: [],
    appendChild(child) { child.parentNode = el; el.children.push(child); return child },
    removeChild(child) {
      const i = el.children.indexOf(child)
      if (i !== -1) el.children.splice(i, 1)
      return child
    },
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

/** Boot one page with a virtual clock and a fake WebGL/audio/WS stack. */
async function makePage(opts = {}) {
  const stats = { probes: 0, full: 0 }
  const clock = { now: 0, seq: 0, queue: [] }
  const schedule = (fn, ms, repeat, kind) => {
    const entry = {
      id: ++clock.seq,
      fn,
      due: clock.now + Math.max(0, ms || 0),
      repeat: repeat || 0,
      kind: kind || 'timer',
      cancelled: false,
      done: false
    }
    clock.queue.push(entry)
    return entry.id
  }
  const cancel = id => {
    const entry = clock.queue.find(e => e.id === id)
    if (entry) entry.cancelled = true
  }
  const advance = ms => {
    const end = clock.now + ms
    for (;;) {
      let next = null
      for (const entry of clock.queue) {
        if (entry.done || entry.cancelled || entry.due > end) continue
        if (!next || entry.due < next.due) next = entry
      }
      if (!next) break
      clock.now = Math.max(clock.now, next.due)
      if (next.repeat) next.due = clock.now + next.repeat
      else {
        next.done = true
        clock.queue = clock.queue.filter(e => e !== next)
      }
      next.fn(clock.now)
    }
    clock.now = end
  }
  const pendingRaf = () => clock.queue.filter(
    e => e.kind === 'raf' && !e.done && !e.cancelled
  ).length

  const gl = makeGl(stats)
  const els = new Map()
  const element = id => {
    if (!els.has(id)) els.set(id, makeElement(id, 'div', gl))
    return els.get(id)
  }

  const docListeners = Object.create(null)
  const doc = {
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    documentElement: makeElement('html', 'html', gl),
    body: makeElement('body', 'body', gl),
    getElementById: id => element(id),
    createElement: tag => makeElement('created-' + tag, tag, gl),
    querySelector: () => makeElement('query', 'div', gl),
    addEventListener(type, fn) { (docListeners[type] || (docListeners[type] = [])).push(fn) },
    removeEventListener(type, fn) {
      const list = docListeners[type]
      if (!list) return
      const i = list.indexOf(fn)
      if (i !== -1) list.splice(i, 1)
    }
  }

  const sockets = []
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    URLSearchParams,
    AbortController: class FakeAbortController {
      constructor() { this.signal = {} }
      abort() {}
    },
    performance: { now: () => clock.now },
    setTimeout: (fn, ms) => schedule(fn, ms, 0),
    clearTimeout: cancel,
    setInterval: (fn, ms) => schedule(fn, ms, Math.max(1, ms || 1)),
    clearInterval: cancel,
    requestAnimationFrame: fn => schedule(fn, 16, 0, 'raf'),
    cancelAnimationFrame: cancel,
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
    document: doc,
    fetch: async (url) => {
      const route = String(url)
      const table = opts.routes || {}
      if (Object.prototype.hasOwnProperty.call(table, route)) {
        const hit = table[route]
        return { ok: hit.ok !== false, status: hit.status || 200, json: async () => hit.json }
      }
      if (route.indexOf('presets.json') !== -1) {
        return {
          ok: true, status: 200,
          json: async () => ({ presets: CATALOG_NAMES.map(n => ({ name: n, family: 'organic', strobe: false })) })
        }
      }
      if (route.indexOf('/healthz') !== -1) {
        return { ok: true, status: 200, json: async () => ({ ok: true, capture: 'pulseaudio', rate: 48000 }) }
      }
      if (route.indexOf('/api/config') !== -1) {
        return {
          ok: true, status: 200,
          json: async () => Object.assign({
            enabled: true, intensity: 0.6, opacity: 0.75, behavior: 'balanced',
            motion: opts.motion || 'designs', mood_reactive: true, accent_pulse: true,
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
  sandbox.location = { search: '?token=' + TOKEN, protocol: 'http:', host: '127.0.0.1:8765' }
  const context = vm.createContext(sandbox)

  vm.runInContext(
    'window.butterchurn = { createVisualizer: function () { ' +
    'return { loadPreset: function () {}, setRendererSize: function () {}, ' +
    'connectAudio: function () {}, render: function () {} }; } };' +
    'window.butterchurnPresets = { getPresets: function () { return window.__vendorPresets; } };',
    context
  )
  sandbox.__vendorPresets = VENDOR_PRESETS
  vm.runInContext(fs.readFileSync(AURA_JS, 'utf8'), context, { filename: 'web/aura.js' })

  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve))

  const aura = sandbox.window.__aura
  assert.ok(aura, 'window.__aura test hook missing')

  const ArrayBufferIn = vm.runInContext('ArrayBuffer', context)
  const DataViewIn = vm.runInContext('DataView', context)

  return {
    aura,
    clock,
    advance,
    pendingRaf,
    stats,
    frames: () => aura._state.frames,
    setHidden(hidden) {
      doc.hidden = hidden
      doc.visibilityState = hidden ? 'hidden' : 'visible'
      for (const fn of (docListeners.visibilitychange || []).slice()) fn({ type: 'visibilitychange' })
    },
    openSocket() {
      const ws = sockets[sockets.length - 1]
      assert.ok(ws, 'the page never opened a stream socket')
      ws.readyState = 1
      ws.onopen({})
    },
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
    }
  }
}

// ------------------------------------------------------------------ the checks

await record('a. Aura off parks the render loop; enabling restarts it within one frame', async () => {
  const page = await makePage({ motion: 'designs' })
  page.advance(200)
  assert.ok(page.pendingRaf() > 0, 'the loop is not running at boot')
  assert.ok(page.frames() > 0, 'no frames were rendered at boot')
  page.aura.setEnabledUI(false)
  // Capture/config events still reach a switched-off page and call startLoop().
  // That must not leave the loop spinning at display rate with nothing to draw:
  // on the parent commit it rescheduled itself forever here.
  page.aura.applyConfig({ capture: 'pulseaudio' })
  page.advance(2000)
  assert.equal(page.pendingRaf(), 0, 'a rAF callback is still pending while Aura is off')
  const framesOff = page.frames()
  page.advance(1000)
  assert.equal(page.frames(), framesOff, 'frames were still rendered while Aura is off')
  page.aura.setEnabledUI(true)
  assert.equal(page.pendingRaf(), 1, 'enabling did not schedule a frame')
  const before = page.frames()
  page.advance(100)
  assert.ok(page.frames() > before, 'enabling did not restart rendering')
})

await record('b. the silence gate parks the loop; a non-silent frame resumes it', async () => {
  const page = await makePage({ motion: 'music' })
  page.openSocket()
  page.advance(2500)
  assert.equal(page.aura._state.renderPaused, true, 'the silence gate never closed: ' + JSON.stringify({
    motion: page.aura._state.motion,
    blockers: Array.from(page.aura._blockers.keys()),
    viz: !!page.aura._viz()
  }))
  assert.equal(page.pendingRaf(), 0, 'a rAF callback is still pending while the visual is faded out')
  const pausedFrames = page.frames()
  page.sendPcm({})
  assert.equal(page.aura._state.renderPaused, false, 'a non-silent PCM frame did not resume the visual')
  assert.equal(page.pendingRaf(), 1, 'resuming did not schedule a frame')
  page.advance(100)
  assert.ok(page.frames() > pausedFrames, 'resuming did not restart rendering')
})

await record('c. a hidden tab parks the loop; becoming visible restarts it', async () => {
  const page = await makePage({ motion: 'designs' })
  page.advance(200)
  assert.ok(page.pendingRaf() > 0, 'the loop is not running at boot')
  page.setHidden(true)
  const hiddenFrames = page.frames()
  page.advance(500)
  assert.equal(page.pendingRaf(), 0, 'a rAF callback is still pending while the tab is hidden')
  assert.equal(page.frames(), hiddenFrames, 'frames were still rendered while the tab is hidden')
  page.setHidden(false)
  assert.equal(page.pendingRaf(), 1, 'becoming visible did not schedule a frame')
  page.advance(100)
  assert.ok(page.frames() > hiddenFrames, 'becoming visible did not restart rendering')
})

await record('d. past the warm window the GPU sync probe is sparse and playback never reads the full buffer', async () => {
  const page = await makePage({ motion: 'designs' })
  page.advance(11000) // first 10 s after the loop started: the warm window
  assert.ok(page.frames() > 200, `only ${page.frames()} frames in 11 s: the loop is not running`)
  const framesBefore = page.frames()
  const probesBefore = page.stats.probes
  page.advance(12000)
  const frames = page.frames() - framesBefore
  const probes = page.stats.probes - probesBefore
  assert.ok(frames > 200, `only ${frames} frames rendered in 12 s of steady playback`)
  assert.ok(
    probes <= Math.ceil(frames / 120) + 1,
    `${probes} sync probes for ${frames} frames: expected at most one per 120 frames`
  )
  assert.equal(page.stats.full, 0, 'captureCanvas() read the full buffer during normal playback')
})

await record('e. preset loads and automatic quality steps never re-open the dense probe window', async () => {
  const page = await makePage({ motion: 'designs' })
  page.advance(11000) // past the start-up warm window: steady playback
  assert.ok(page.frames() > 200, `only ${page.frames()} frames in 11 s: the loop is not running`)
  // 50 preset loads — manual, mood and agent choices all arrive this way.
  for (let i = 0; i < 50; i += 1) {
    page.aura.applyConfig({ preset: CATALOG_NAMES[i % CATALOG_NAMES.length] })
  }
  // 5 automatic quality steps: seed slow frames and let the ladder decide.
  for (let i = 0; i < 5; i += 1) {
    page.aura._frameTimes.length = 0
    for (let j = 0; j < 120; j += 1) page.aura._frameTimes.push(300)
    page.aura.evaluateDegrade()
  }
  const framesBefore = page.frames()
  const probesBefore = page.stats.probes
  page.advance(12000)
  const frames = page.frames() - framesBefore
  const probes = page.stats.probes - probesBefore
  assert.ok(frames > 0, 'no frames rendered in 12 s of steady playback')
  assert.ok(
    probes <= Math.ceil(frames / 120) + 1,
    `${probes} sync probes for ${frames} frames after preset/quality churn: expected at most one per 120 frames`
  )
  assert.equal(page.stats.full, 0, 'captureCanvas() read the full buffer during normal playback')
})

// ------------------------------------------------------------------ report

for (const line of results) console.log(line)
console.log(`\nweb idle loop: ${results.length - failed}/${results.length}`)
process.exit(failed ? 1 : 0)
