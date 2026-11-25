/**
 * Regression test for the saved reduced-motion choice being thrown away.
 *
 * A page opened with `reduced_motion=true` saved in its config, no force flag
 * in the URL, and the OS motion preference set to normal used to lose that
 * choice twice: the 350 ms boot re-read and the visibilitychange handler both
 * recomputed the preference from the OS and the URL alone, so coming back to
 * the page (or just waiting out the boot beat) re-enabled full motion and let
 * the strobe presets back in.
 *
 * The page is booted for real (a stub DOM, real timers) because both paths are
 * driven by timers and events, not by a snapshot field.
 *
 * Run: node tests/test_web_reduced_motion_persist.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'web', 'aura.js'), 'utf8')

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function element(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    style: {
      setProperty(name, value) { this[name] = String(value) },
      getPropertyValue(name) { return this[name] || '' },
      removeProperty(name) { delete this[name] }
    },
    dataset: {},
    attributes: {},
    classList: { add() {}, remove() {}, toggle() {} },
    textContent: '',
    value: '',
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null },
    getBoundingClientRect: () => ({ width: 640, height: 480 }),
    getContext: () => null
  }
}

/** A boot the page can finish in: no audio (a hard blocker), no WebGL, one
 *  canvas, and a document whose handlers the test can fire by hand. */
async function bootedAura(config, { osReduced = false } = {}) {
  const nodes = new Map()
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, element(id === 'aura-canvas' ? 'canvas' : 'div'))
    return nodes.get(id)
  }
  const payloads = {
    'presets.json': {
      presets: [
        { name: 'alpha preset', family: 'liquid' },
        { name: 'strobe preset', family: 'liquid', strobe: true }
      ],
      default: 'alpha preset'
    },
    '/healthz': { ok: true, capture: 'pipewire' },
    '/api/config': config,
    '/api/state': { enabled: true }
  }
  const reply = async url => {
    const key = String(url)
    if (!(key in payloads)) throw new Error('unexpected fetch ' + key)
    return { ok: true, status: 200, json: async () => payloads[key] }
  }
  // Reconnect timers and the like must not hold the Node process open.
  const later = (fn, ms) => {
    const timer = setTimeout(fn, ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return timer
  }
  class SilentSocket {
    constructor(url) {
      this.url = String(url)
      this.readyState = SilentSocket.CONNECTING
      this.binaryType = ''
    }
    send() {}
    close() {}
  }
  SilentSocket.CONNECTING = 0
  SilentSocket.OPEN = 1
  const documentHandlers = new Map()
  const motionHandlers = new Map()
  const media = {
    matches: osReduced,
    addEventListener(type, fn) { if (!motionHandlers.has(type)) motionHandlers.set(type, []); motionHandlers.get(type).push(fn) }
  }
  const doc = {
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    documentElement: { classList: { add() {} } },
    body: { classList: { add() {} } },
    addEventListener(type, fn) {
      if (!documentHandlers.has(type)) documentHandlers.set(type, [])
      documentHandlers.get(type).push(fn)
    },
    getElementById: id => node(id)
  }
  const sandbox = {
    location: { search: '?token=test-token' },
    URLSearchParams,
    AbortController,
    WebSocket: SilentSocket,
    document: doc,
    window: {
      addEventListener() {},
      matchMedia: () => media
    },
    performance: { now: () => 0 },
    console,
    setTimeout: later,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: reply,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {}
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'web/aura.js' })
  const aura = sandbox.window.__aura
  assert.ok(aura, 'window.__aura test hook missing')
  const fire = type => {
    for (const fn of documentHandlers.get(type) || []) fn()
  }
  const hide = () => { doc.hidden = true; doc.visibilityState = 'hidden'; fire('visibilitychange') }
  const show = () => { doc.hidden = false; doc.visibilityState = 'visible'; fire('visibilitychange') }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (aura._state.ready) break
    await sleep(5)
  }
  assert.equal(aura._state.ready, true,
    `boot never finished (errors: ${JSON.stringify(aura._state.errors)})`)
  return { aura, hide, show, media, motionHandlers }
}

await record('saved reduced motion survives the 350 ms boot re-read', async () => {
  const { aura } = await bootedAura({ enabled: true, motion: 'both', reduced_motion: true })
  assert.equal(aura.snapshot().reducedMotion, true, 'the saved choice never applied')
  await sleep(450)
  assert.equal(aura.snapshot().reducedMotion, true,
    'the 350 ms boot re-read turned the saved reduced motion back off')
})

await record('saved reduced motion survives hiding and showing the page', async () => {
  const { aura, hide, show } = await bootedAura({ enabled: true, motion: 'both', reduced_motion: true })
  await sleep(450)
  hide()
  show()
  assert.equal(aura.snapshot().reducedMotion, true,
    'coming back to the page re-enabled full motion')
  // The OS preference is still normal, so nothing else could be holding it.
  assert.equal(aura.snapshot().reducedMotion, true)
})

await record('strobe presets stay excluded while saved reduced motion holds', async () => {
  const { aura, hide, show } = await bootedAura({ enabled: true, motion: 'both', reduced_motion: true })
  await sleep(450)
  hide()
  show()
  const snap = aura.snapshot()
  assert.equal(snap.presetCount, 2)
  assert.equal(snap.reducedPresetsAllowed, 1,
    `the strobe preset came back: ${snap.reducedPresetsAllowed} of ${snap.presetCount} presets allowed`)
})

await record('an OS preference of normal is not overridden by the saved choice', async () => {
  const { aura, hide, show } = await bootedAura({ enabled: true, motion: 'both', reduced_motion: false })
  await sleep(450)
  hide()
  show()
  const snap = aura.snapshot()
  assert.equal(snap.reducedMotion, false, 'reduced motion was forced on without a reason')
  assert.equal(snap.reducedPresetsAllowed, snap.presetCount, 'a strobe preset stayed excluded')
})

await record('the OS preference still wins when it asks for reduced motion', async () => {
  const { aura, hide, show } = await bootedAura({ enabled: true, motion: 'both', reduced_motion: false },
    { osReduced: true })
  await sleep(450)
  hide()
  show()
  assert.equal(aura.snapshot().reducedMotion, true, 'the OS preference was lost')
})

console.log(results.join('\n'))
if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log(`\n${results.length} passed`)
