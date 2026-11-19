/**
 * Diagnostics tests for the Aura page (web/aura.js).
 *
 * The page keeps a ring buffer of the last 200 events — errors, poll failures,
 * render-loop start/stop, quality steps — plus a performance.memory sample
 * every five minutes where the browser exposes it. Nothing is uploaded; the
 * Copy diagnostics button in the controls bar copies the report locally.
 *
 * This file boots the page in a vm context (fake DOM/WebGL/AudioContext/WS and
 * a virtual clock, same wiring as tests/test_web_idle_loop.mjs) and proves:
 *
 *   a. the heap sampler's interval is >= 5 minutes and it is armed at boot;
 *   b. the ring caps at 200 events, dropping the oldest;
 *   c. render-loop start/stop and quality steps land in the ring;
 *   d. a failed fetch lands in the ring as poll-fail;
 *   e. while Aura is Off nothing is recorded except the heap sample;
 *   f. the heap sample reads performance.memory.usedJSHeapSize, once per
 *      five minutes of virtual time (not faster);
 *   g. pagehide stops the sampler timer; pageshow (bfcache) re-arms it;
 *   h. Copy diagnostics copies real JSON, never the token, and the button
 *      reports failure truthfully when the clipboard is unavailable.
 *
 * Set AURA_WEB=<path> to point the same test at another copy of the page.
 *
 * Run: node tests/test_diag_web.mjs
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
    getParameter() { return 'ANGLE Diagnostics GPU' }
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

  const gl = makeGl()
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

  const winListeners = Object.create(null)
  const copied = []
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    URLSearchParams,
    AbortController: class FakeAbortController {
      constructor() { this.signal = {} }
      abort() {}
    },
    performance: { now: () => clock.now, memory: opts.memory },
    setTimeout: (fn, ms) => schedule(fn, ms, 0),
    clearTimeout: cancel,
    setInterval: (fn, ms) => schedule(fn, ms, Math.max(1, ms || 1)),
    clearInterval: cancel,
    requestAnimationFrame: fn => schedule(fn, 16, 0, 'raf'),
    cancelAnimationFrame: cancel,
    addEventListener(type, fn) { (winListeners[type] || (winListeners[type] = [])).push(fn) },
    removeEventListener(type, fn) {
      const list = winListeners[type]
      if (!list) return
      const i = list.indexOf(fn)
      if (i !== -1) list.splice(i, 1)
    },
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
      }
      close() { this.readyState = 3 }
    },
    document: doc,
    navigator: {
      clipboard: {
        writeText: async text => {
          if (opts.clipboard === 'denied') throw new Error('clipboard denied')
          copied.push(text)
        }
      }
    },
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
  sandbox.location = { search: '?token=' + TOKEN, protocol: 'http:', host: '127.0.0.1:8765', pathname: '/' }
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

  const liveTimers = () => clock.queue.filter(e => !e.done && !e.cancelled && e.repeat > 0)
  const diagTimers = () => liveTimers().filter(e => e.repeat >= 300000)

  return {
    aura,
    clock,
    advance,
    copied,
    element,
    liveTimers,
    diagTimers,
    dispatchWindow(type, event) {
      for (const fn of (winListeners[type] || []).slice()) fn(event || { type })
    },
    setHidden(hidden) {
      doc.hidden = hidden
      doc.visibilityState = hidden ? 'hidden' : 'visible'
      for (const fn of (docListeners.visibilitychange || []).slice()) fn({ type: 'visibilitychange' })
    },
    heapEvents: () => aura.diagnostics().filter(event => event.kind === 'heap')
  }
}

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve))
}

// ------------------------------------------------------------------ the checks

await record('a. the heap sampler interval is >= 5 min and armed at boot', async () => {
  const page = await makePage({ motion: 'designs' })
  assert.ok(page.aura._diag, 'window.__aura exposes no _diag surface')
  assert.ok(page.aura._diag.intervalMs >= 300000, `interval is ${page.aura._diag.intervalMs}`)
  assert.equal(page.aura._diag.max, 200)
  assert.equal(page.diagTimers().length, 1, 'the five-minute sampler is not armed at boot')
  assert.equal(page.diagTimers()[0].repeat, page.aura._diag.intervalMs)
})

await record('b. the ring caps at 200 events, dropping the oldest', async () => {
  const page = await makePage({ motion: 'designs' })
  for (let i = 0; i < 250; i += 1) page.aura._diag.note('error', 'e' + i)
  const ring = page.aura.diagnostics()
  assert.equal(ring.length, 200)
  // 250 notes into a 200-cap ring: the oldest 50 notes (and any boot events)
  // are gone, so the first kept note is e50 and the last is e249.
  assert.equal(ring[0].detail, 'e50')
  assert.equal(ring[ring.length - 1].detail, 'e249')
})

await record('c. render-loop start/stop and quality steps land in the ring', async () => {
  const page = await makePage({ motion: 'designs' })
  page.advance(200)
  assert.ok(page.aura._state.frames > 0, 'the loop never rendered at boot')
  page.setHidden(true)
  page.advance(100)
  assert.ok(page.aura.diagnostics().some(e => e.kind === 'loop-stop'), 'no loop-stop event when the tab hid')
  page.setHidden(false)
  page.advance(100)
  assert.ok(page.aura.diagnostics().some(e => e.kind === 'loop-start'), 'no loop-start event when the tab returned')
  // Force the degrade ladder one step down: heavy frame times, then evaluate.
  for (let i = 0; i < 10; i += 1) page.aura._frameTimes.push(400)
  page.aura.evaluateDegrade()
  const quality = page.aura.diagnostics().filter(e => e.kind === 'quality')
  assert.ok(quality.length >= 1, 'no quality event after a degrade step')
  assert.equal(quality[quality.length - 1].detail.level, page.aura._quality.degradeLevel)
  assert.ok(quality[quality.length - 1].detail.level >= 1, 'the ladder did not step down')
})

await record('d. a failed fetch lands in the ring as poll-fail', async () => {
  const page = await makePage({
    motion: 'designs',
    routes: { '/api/config': { ok: false, status: 500, json: null } }
  })
  await settle()
  const fails = page.aura.diagnostics().filter(e => e.kind === 'poll-fail')
  assert.ok(fails.some(e => e.detail && e.detail.path === '/api/config' && e.detail.status === 500),
    'the 500 from /api/config was not recorded')
})

await record('e. while Aura is Off only the heap sample is recorded', async () => {
  const page = await makePage({ motion: 'designs', memory: { usedJSHeapSize: 5, totalJSHeapSize: 9, jsHeapSizeLimit: 100 } })
  page.aura.setEnabledUI(false)
  page.advance(100)
  const before = page.aura.diagnostics().length
  page.aura._diag.note('error', 'must not land')
  page.aura._diag.note('poll-fail', { path: '/api/state' })
  page.aura._diag.note('loop-start')
  assert.equal(page.aura.diagnostics().length, before, 'Off Aura recorded events other than the heap sample')
  page.aura._diag.sampleHeap()
  const ring = page.aura.diagnostics()
  assert.equal(ring.length, before + 1, 'the heap sample must keep recording while Off')
  assert.equal(ring[ring.length - 1].kind, 'heap')
})

await record('f. the heap sample reads performance.memory once per five minutes', async () => {
  const memory = { usedJSHeapSize: 1000, totalJSHeapSize: 2000, jsHeapSizeLimit: 4000 }
  const page = await makePage({ motion: 'designs', memory })
  // Boot took one baseline sample.
  assert.equal(page.heapEvents().length, 1)
  assert.equal(page.heapEvents()[0].detail.usedJSHeapSize, 1000)
  memory.usedJSHeapSize = 2000
  page.advance(299999)
  assert.equal(page.heapEvents().length, 1, 'a heap sample fired before five minutes were up')
  page.advance(1)
  assert.equal(page.heapEvents().length, 2, 'no heap sample at the five-minute mark')
  assert.equal(page.heapEvents()[1].detail.usedJSHeapSize, 2000)
  page.advance(300000)
  assert.equal(page.heapEvents().length, 3, 'the sampler did not repeat every five minutes')
})

await record('g. pagehide stops the sampler; pageshow (bfcache) re-arms it', async () => {
  const page = await makePage({ motion: 'designs', memory: { usedJSHeapSize: 1, totalJSHeapSize: 2, jsHeapSizeLimit: 3 } })
  assert.equal(page.diagTimers().length, 1)
  page.dispatchWindow('pagehide', { type: 'pagehide' })
  assert.equal(page.diagTimers().length, 0, 'the sampler timer survived pagehide')
  page.advance(600000)
  assert.equal(page.heapEvents().length, 1, 'a heap sample fired while the page was suspended')
  page.dispatchWindow('pageshow', { type: 'pageshow', persisted: true })
  assert.equal(page.diagTimers().length, 1, 'pageshow did not re-arm the sampler')
})

await record('h. Copy diagnostics copies JSON without the token; failure is truthful', async () => {
  const page = await makePage({ motion: 'designs' })
  page.aura._diag.note('error', 'a recorded problem')
  const btn = page.element('aura-diag-copy')
  btn.dispatch('click', { type: 'click' })
  await settle()
  assert.equal(page.copied.length, 1, 'the button copied nothing')
  const report = JSON.parse(page.copied[0])
  assert.equal(report.source, 'aura-page')
  assert.ok(Array.isArray(report.events))
  assert.ok(report.events.some(e => e.kind === 'error' && e.detail === 'a recorded problem'))
  assert.ok(!page.copied[0].includes(TOKEN), 'the diagnostics report leaked the token')
  assert.ok(!page.copied[0].includes('token='), 'the diagnostics report carried a tokenised URL')
  assert.equal(btn.textContent, 'copied ✓')
  // A denied clipboard must say so, not claim success.
  const denied = await makePage({ motion: 'designs', clipboard: 'denied' })
  const btn2 = denied.element('aura-diag-copy')
  btn2.dispatch('click', { type: 'click' })
  await settle()
  assert.equal(denied.copied.length, 0)
  assert.equal(btn2.textContent, 'copy failed')
})

// ------------------------------------------------------------------- report
for (const line of results) console.log(line)
console.log(`${results.length - failed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
