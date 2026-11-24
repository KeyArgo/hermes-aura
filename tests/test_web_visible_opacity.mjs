/**
 * Regression test for the black stage: a saved visual opacity of 0 used to
 * carry straight through to the canvas, so the backdrop painted nothing at all
 * while music played and the page looked like a broken visualiser. The canvas
 * keeps a faint floor instead; only the deliberate silence fade may reach 0.
 *
 * The page is booted for real (a stub DOM with one canvas) because the thing
 * the user sees is that element's style.opacity, not a snapshot field.
 *
 * Run: node tests/test_web_visible_opacity.mjs
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

/** A boot the page can finish in: no audio (a hard blocker, but the opacity is
 *  written on every branch), no WebGL, no socket, one canvas element. */
async function bootedAura(config) {
  const nodes = new Map()
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, element(id === 'aura-canvas' ? 'canvas' : 'div'))
    return nodes.get(id)
  }
  const payloads = {
    'presets.json': { presets: [{ name: 'alpha preset', family: 'liquid' }], default: 'alpha preset' },
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
  // A socket that never opens: connect() must not throw, and nothing retries
  // once the page is torn down.
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
  const sandbox = {
    location: { search: '?token=test-token' },
    URLSearchParams,
    AbortController,
    WebSocket: SilentSocket,
    document: {
      readyState: 'complete',
      hidden: false,
      documentElement: { classList: { add() {} } },
      body: { classList: { add() {} } },
      addEventListener() {},
      getElementById: id => node(id)
    },
    window: {
      addEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {} })
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
  const canvas = node('aura-canvas')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (aura._state.ready && canvas.style.opacity !== '') break
    await sleep(5)
  }
  assert.equal(aura._state.ready, true,
    `boot never finished (errors: ${JSON.stringify(aura._state.errors)})`)
  assert.notEqual(canvas.style.opacity, '', 'the canvas opacity was never written')
  return { aura, canvas }
}

await record('a saved opacity of 0 still paints a faint canvas', async () => {
  const { aura, canvas } = await bootedAura({ enabled: true, opacity: 0, motion: 'both' })
  const painted = Number(canvas.style.opacity)
  assert.equal(aura.snapshot().opacity, 0, 'the saved 0 must stay the saved 0')
  assert.equal(aura.snapshot().silent, false, 'the silence gate is not the cause here')
  assert.ok(Number.isFinite(painted), `canvas opacity is not a number: ${canvas.style.opacity}`)
  assert.ok(painted >= 0.1, `the canvas faded to ${canvas.style.opacity}: a black stage`)
  assert.ok(painted <= 1, `the canvas opacity ${painted} is out of range`)
})

await record('the Aura-off look is floored too', async () => {
  const { canvas } = await bootedAura({ enabled: false, opacity: 0, motion: 'both' })
  const painted = Number(canvas.style.opacity)
  assert.ok(painted >= 0.1, `the dimmed look faded to ${canvas.style.opacity}`)
})

await record('a normal opacity is painted unchanged', async () => {
  const { canvas } = await bootedAura({ enabled: true, opacity: 0.6, motion: 'both' })
  assert.equal(Number(canvas.style.opacity), 0.6, 'a real value must not be lifted to the floor')
})

await record('the silence fade still reaches 0', () => {
  // pauseVisual clears the drawing buffer, so revealing it would paint black:
  // that fade is deliberate and must stay a hard 0.
  assert.match(SOURCE, /dom\.canvas\.style\.opacity = '0';\s*\n\s*\}\s*\n\s*clearVisual\(\);/,
    'pauseVisual no longer fades the canvas out')
})

console.log(results.join('\n'))
if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log(`\n${results.length} passed`)
