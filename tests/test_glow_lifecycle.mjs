/**
 * The Aura theme's WebGL glow — its life and its shutdown — desktop/plugin.js.
 *
 * Three review findings, each a check that fails on the reviewed code:
 *
 *   G1. A failed mount must leave nothing behind. When the shader would not
 *       build AND the canvas could not be appended, the matchMedia change
 *       listener and the two canvas context listeners stayed registered, and
 *       the WebGL context was never released. Cleanup must match the other
 *       failure branch: every listener off, loseContext() called.
 *   G2. The rAF loop must not run while Aura is Off or nothing is playing.
 *       It draws one static frame and stops, and resumes when the poll reports
 *       activity again.
 *   G3. The fragment shader's precision follows the context: mediump where
 *       highp is not available in fragment shaders, highp where it is.
 *
 * Same fake host as tests/test_aura_theme.mjs: a temp copy of the plugin has
 * its import specifiers rewritten to local stubs, and the copy exposes the few
 * internals these checks drive.
 *
 * Run: node tests/test_glow_lifecycle.mjs
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

// ------------------------------------------------------------------- the DOM

const documentListeners = {}
const windowListeners = {}
const glContexts = []
const motionListenerCount = { count: 0 }

let glMode = 'ok'          // 'ok' (builds) | 'fail' (no compile)
let fragmentHighp = true   // what getShaderPrecisionFormat reports for HIGH_FLOAT
let mountFails = false     // <html>.appendChild throws
let frameSeq = 0
let frames = []
let nowMs = 0
let shaderSources = []

function makeElement(tagName) {
  const handlers = {}
  const attributes = {}
  const node = {
    tagName: String(tagName).toUpperCase(),
    style: {},
    attributes,
    children: [],
    parentNode: null,
    width: 0,
    height: 0,
    dataset: {},
    setAttribute(name, value) { attributes[name] = String(value) },
    getAttribute(name) { return attributes[name] },
    removeAttribute(name) { delete attributes[name] },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attributes, name) },
    appendChild(child) { child.parentNode = node; node.children.push(child); return child },
    removeChild(child) {
      const index = node.children.indexOf(child)
      if (index >= 0) node.children.splice(index, 1)
      child.parentNode = null
      return child
    },
    addEventListener(type, fn) { (handlers[type] || (handlers[type] = [])).push(fn) },
    removeEventListener(type, fn) { handlers[type] = (handlers[type] || []).filter(h => h !== fn) },
    handlerCount: type => (handlers[type] || []).length,
    remove() { if (node.parentNode) node.parentNode.removeChild(node) }
  }
  if (String(tagName).toLowerCase() === 'canvas') {
    node.getContext = kind => {
      if (kind !== 'webgl') return null
      const gl = makeGl(glMode === 'fail')
      gl.canvas = node
      glContexts.push(gl)
      return gl
    }
  }
  return node
}

function makeGl(fail) {
  const gl = {
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    HIGH_FLOAT: 36338,
    COMPILE_STATUS: 35713,
    LINK_STATUS: 35714,
    ARRAY_BUFFER: 34962,
    STATIC_DRAW: 35044,
    FLOAT: 5126,
    TRIANGLES: 4,
    uniforms: {},
    draws: 0,
    lost: 0,
    lostContextCalls: 0,
    createShader: () => ({}),
    shaderSource(shader, text) { shaderSources.push({ shader, text }) },
    compileShader() {},
    getShaderParameter: () => !fail,
    getShaderPrecisionFormat: () => ({ precision: fragmentHighp ? 23 : 0 }),
    createProgram: () => ({}),
    attachShader() {},
    bindAttribLocation() {},
    linkProgram() {},
    getProgramParameter: () => !fail,
    useProgram() {},
    createBuffer: () => ({}),
    bindBuffer() {},
    bufferData() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    getUniformLocation: (program, name) => name,
    viewport() {},
    uniform2f(name, x, y) { gl.uniforms[name] = [x, y] },
    uniform1f(name, value) { gl.uniforms[name] = value },
    uniform3fv(name, value) { gl.uniforms[name] = [...value] },
    drawArrays() { gl.draws += 1 },
    getExtension: () => ({ loseContext: () => { gl.lostContextCalls += 1; gl.lost += 1 } })
  }
  return gl
}

const htmlClasses = new Set()
const html = makeElement('html')
html.appendChild = child => {
  if (mountFails) throw new Error('appendChild refused')
  html.children.push(child)
  child.parentNode = html
  return child
}
html.classList = {
  add: name => htmlClasses.add(name),
  remove: (...names) => names.forEach(name => htmlClasses.delete(name)),
  contains: name => htmlClasses.has(name)
}
const body = makeElement('body')
const documentElement = html
documentElement.style = {}

globalThis.document = {
  hidden: false,
  visibilityState: 'visible',
  documentElement,
  head: makeElement('head'),
  body,
  createElement: makeElement,
  addEventListener(type, fn) { (documentListeners[type] || (documentListeners[type] = [])).push(fn) },
  removeEventListener(type, fn) {
    documentListeners[type] = (documentListeners[type] || []).filter(h => h !== fn)
  }
}

globalThis.window = {
  innerWidth: 1200,
  innerHeight: 800,
  devicePixelRatio: 1,
  matchMedia: query => ({
    media: query,
    matches: false,
    addEventListener() { motionListenerCount.count += 1 },
    removeEventListener() { motionListenerCount.count -= 1 }
  }),
  requestAnimationFrame(fn) {
    frameSeq += 1
    frames.push({ id: frameSeq, fn })
    return frameSeq
  },
  cancelAnimationFrame(id) { frames = frames.filter(item => item.id !== id) },
  addEventListener(type, fn) { (windowListeners[type] || (windowListeners[type] = [])).push(fn) },
  removeEventListener(type, fn) {
    windowListeners[type] = (windowListeners[type] || []).filter(h => h !== fn)
  }
}

Object.defineProperty(globalThis, 'performance', {
  configurable: true,
  value: { now: () => nowMs }
})
globalThis.getComputedStyle = () => ({ backgroundColor: 'rgba(0, 0, 0, 0)', getPropertyValue: () => '' })

const pendingFrames = () => frames.length

function flushFrame(step = 100) {
  const next = frames.shift()
  if (!next) return false
  nowMs += step
  next.fn(nowMs)
  return true
}

// ------------------------------------------------------------- temp module

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aura-glow-life-'))
const pluginCopy = path.join(tmp, 'plugin.mjs')

const source = fs.readFileSync(PLUGIN, 'utf8')
fs.writeFileSync(
  pluginCopy,
  source
    .replace(/from\s+'@hermes\/plugin-sdk'/g, "from './sdk-stub.mjs'")
    .replace(/from\s+'react'/g, "from './react-stub.mjs'")
    .replace(/from\s+'react\/jsx-runtime'/g, "from './jsx-stub.mjs'") +
  '\nexport const glowTest = {' +
  ' sync: syncAuraGlow,' +
  ' refresh: typeof refreshAuraGlow === "function" ? refreshAuraGlow : null,' +
  ' setEnabled,' +
  ' canvas: () => (auraGlow && auraGlow.canvas) || null,' +
  ' setLive: frame => { liveFrame = frame },' +
  ' settings: $settings, audio: $audio, video: $video };\n'
)

fs.writeFileSync(path.join(tmp, 'sdk-stub.mjs'), `
function makeAtom(initial) {
  let value = initial
  return { get: () => value, set: next => { value = next }, listen: () => () => {} }
}
export const calls = { navigations: [], external: [] }
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
export function useEffect(fn) { fn() }
export function useLayoutEffect(fn) { fn() }
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
const api = plugin.glowTest

// ------------------------------------------------------------------- harness

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function mount() {
  const contributions = []
  const disposers = []
  const ctx = {
    source: 'plugin:aura',
    os: { openExternal: () => true },
    register(contribution) {
      contributions.push(contribution)
      return () => { contribution.removed = true }
    },
    registerSettingsPage(page) { return ctx.register(page) },
    onDispose(fn) { disposers.push(fn) },
    setInterval() { return () => {} },
    setTimeout() { return () => {} },
    addEventListener() { return () => {} },
    storage: { get(key, fallback) { return fallback }, set() {}, remove() {} },
    async rest(route) {
      if (route === '/status') {
        return { ok: true, port: 4321, url: 'http://127.0.0.1:4321/?token=x', capture: 'none', enabled: true }
      }
      if (route === '/state') {
        return { level: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0], silence: true, mood: 'idle' }
      }
      if (route === '/version') return { version: '1.0.0', commit: 'aura-glow' }
      if (route === '/player') return { ok: true, window: { open: false }, player: {}, seq: 0 }
      return { ok: true }
    }
  }
  const dispose = plugin.default.register(ctx)
  return { dispose, contributions }
}

function resetPage() {
  for (const node of [...html.children]) html.removeChild(node)
  for (const node of [...document.body.children]) document.body.removeChild(node)
  for (const key of Object.keys(documentListeners)) delete documentListeners[key]
  for (const key of Object.keys(windowListeners)) delete windowListeners[key]
  glContexts.length = 0
  shaderSources = []
  frames = []
  glMode = 'ok'
  fragmentHighp = true
  mountFails = false
  motionListenerCount.count = 0
  globalThis.document.hidden = false
  globalThis.document.visibilityState = 'visible'
  html.removeAttribute('data-hermes-theme')
  htmlClasses.clear()
}

const listenerCount = registry => Object.values(registry).reduce((sum, list) => sum + list.length, 0)
const canvasInPage = () => html.children.filter(node => node.tagName === 'CANVAS')
const glNow = () => glContexts.at(-1) || null

const playing = () => {
  const audio = api.audio.get()
  api.audio.set({ ...audio, playing: true })
}
const quiet = () => {
  const audio = api.audio.get()
  api.audio.set({ ...audio, playing: false })
  api.video.set({ ...api.video.get(), playing: false })
  api.setLive({ level: 0, silence: true, mood: 'idle' })
}
const loud = () => {
  playing()
  api.setLive({ level: 0.62, silence: false, mood: 'thinking' })
}

const fragmentText = () => {
  const found = shaderSources.find(item => /gl_FragColor/.test(item.text))
  return found ? found.text : ''
}

// ------------------------------------------------------------------ checks

await record('G1. a failed glow mount drops every listener and releases the context', async () => {
  resetPage()
  glMode = 'fail'      // the shader will not build
  mountFails = true    // and the canvas cannot be appended either
  quiet()
  const bucket = mount()
  await settle()
  api.sync('aura')

  assert.equal(canvasInPage().length, 0, 'precondition: the canvas should not be on <html>')
  const gl = glNow()
  assert.ok(gl, 'no WebGL context was created, so the mount never got far enough to fail')
  assert.equal(glMode, 'fail')
  assert.equal((documentListeners.visibilitychange || []).length, 0,
    'a failed mount left the visibility listener registered')
  assert.equal((windowListeners.resize || []).length, 0,
    'a failed mount left the resize listener registered')
  assert.equal(motionListenerCount.count, 0,
    'a failed mount left the prefers-reduced-motion listener registered')
  const canvas = gl.canvas
  assert.equal(canvas.handlerCount('webglcontextlost'), 0,
    'a failed mount left the webglcontextlost listener registered')
  assert.equal(canvas.handlerCount('webglcontextrestored'), 0,
    'a failed mount left the webglcontextrestored listener registered')
  assert.equal(gl.lostContextCalls, 1,
    `a failed mount never released the WebGL context (${gl.lostContextCalls} loseContext calls)`)
  bucket.dispose()
})

await record('G2. the glow draws one still frame and stops while Aura is Off or idle, and resumes on activity', async () => {
  resetPage()
  quiet()
  api.settings.set({ ...api.settings.get(), enabled: true })
  const bucket = mount()
  await settle()
  api.sync('aura')
  const gl = glNow()

  // Nothing playing: one static frame, no loop.
  assert.equal(pendingFrames(), 0, 'the glow started an animation loop with nothing playing')
  assert.equal(gl.draws, 1, `idle mount drew ${gl.draws} frames, expected one still frame`)

  // Activity: the poll reports a playing source, the loop resumes.
  loud()
  api.refresh()
  assert.equal(pendingFrames(), 1, 'activity did not resume the glow loop')
  const before = gl.draws
  flushFrame(40)
  flushFrame(40)
  assert.ok(gl.draws > before, 'the resumed loop never drew')
  assert.equal(pendingFrames(), 1, 'the running loop stopped on its own')

  // Activity ends: the next frame is the last, then nothing is scheduled.
  quiet()
  flushFrame(200)
  assert.equal(pendingFrames(), 0, 'the glow kept its loop running after the activity stopped')

  // Aura Off with a source still reported as playing: still no loop.
  loud()
  await api.setEnabled(false)
  api.refresh()
  assert.equal(pendingFrames(), 0, 'the glow loop ran while Aura was off')
  const offDraws = gl.draws
  flushFrame(200)
  assert.equal(pendingFrames(), 0, 'the glow loop came back with Aura off')
  assert.ok(gl.draws >= offDraws, 'the Off still frame was never drawn')
  await api.setEnabled(true)
  quiet()
  bucket.dispose()
})

await record('G3. the fragment shader picks mediump when highp is unavailable', async () => {
  resetPage()
  quiet()
  fragmentHighp = false
  const bucket = mount()
  await settle()
  api.sync('aura')
  const text = fragmentText()
  assert.ok(text, 'the fragment shader was never compiled')
  assert.match(text, /precision\s+mediump\s+float\s*;/, `the fragment shader did not fall back to mediump:\n${text.slice(0, 120)}`)
  assert.doesNotMatch(text, /precision\s+highp\s+float\s*;/,
    'the fragment shader still declares highp on a context without it')

  // The same build on a context that does support highp keeps it.
  api.sync('nous')
  resetPage()
  quiet()
  fragmentHighp = true
  api.sync('aura')
  const high = fragmentText()
  assert.ok(high, 'the fragment shader was never compiled on the highp context')
  assert.match(high, /precision\s+highp\s+float\s*;/, 'a highp-capable context lost highp')
  bucket.dispose()
})

for (const line of results) console.log(line)
console.log(`\nglow lifecycle: ${results.length - failed}/${results.length}`)
process.exit(failed ? 1 : 0)
