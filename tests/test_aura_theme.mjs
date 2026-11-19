/**
 * The Aura Desktop theme (prototype) — desktop/plugin.js.
 *
 * One DesktopTheme registered through THEMES_AREA, plus a low-power WebGL glow
 * mounted behind the app that exists only while that theme is the active one.
 * The shader's energy comes from the state the existing /status + /state poll
 * already stores, so the theme adds no request, no token and no URL.
 *
 * This file proves, headlessly and with a fake host:
 *
 *   a. the theme registers: one contribution, area 'themes', data.name 'aura',
 *      both palettes, and CSS scoped on data-hermes-theme,
 *   b. its CSS never addresses body, #root or #app,
 *   c. no canvas exists while another theme is active,
 *   d. a canvas appears when the theme is chosen, at 1 pixel per 3 CSS px,
 *      behind the app (position fixed, z-index -1, pointer-events none),
 *   e. an accent retint (aura-accent-<hex>) keeps the canvas; aura-live does not,
 *   f. switching to another theme removes the canvas, and dispose removes it too,
 *   g. the runtime never writes a style onto body / documentElement / #app,
 *   h. activating the theme and running frames adds no network request,
 *   i. the loop pauses while document.hidden and resumes when visible,
 *   j. prefers-reduced-motion draws one still frame and schedules no loop,
 *   k. level / silence / mood reach the shader as uniforms, and nothing
 *      playing reports silence (a calm glow),
 *   l. webglcontextlost stops the loop; the restored event brings it back,
 *   m. with no WebGL the canvas still mounts as a flat colour (no throw),
 *   n. the fragment shader is short and reads only the uniforms it declares.
 *
 * Same wiring as tests/test_idle_poll.mjs: a temp copy has its three import
 * specifiers rewritten to local stubs, and the copy exposes the few
 * modules-internal functions this test drives.
 *
 * Run: node tests/test_aura_theme.mjs
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
// Everything the plugin may touch: <html>, body, head, created elements, the
// document-level listeners, and a controllable animation frame queue.

const documentListeners = {}
const windowListeners = {}
const createdElements = []
const glContexts = []

let glMode = 'ok'                 // 'ok' | 'none' (no WebGL) | 'fail' (no compile)
let mediaReduced = false
let frameSeq = 0
let frames = []
let nowMs = 0

const makeStyleProbe = () => {
  const writes = []
  const style = new Proxy({}, {
    set(target, key, value) {
      writes.push(String(key))
      target[key] = value
      return true
    }
  })
  return { style, writes }
}

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
    fire(type, event) { for (const fn of handlers[type] || []) fn(event) },
    handlerCount: type => (handlers[type] || []).length,
    remove() { if (node.parentNode) node.parentNode.removeChild(node) }
  }
  if (String(tagName).toLowerCase() === 'canvas') {
    node.getContext = kind => {
      if (kind !== 'webgl' || glMode === 'none') return null
      const gl = makeGl(glMode === 'fail')
      gl.canvas = node
      glContexts.push(gl)
      return gl
    }
  }
  createdElements.push(node)
  return node
}

function makeGl(fail) {
  const gl = {
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    COMPILE_STATUS: 35713,
    LINK_STATUS: 35714,
    ARRAY_BUFFER: 34962,
    STATIC_DRAW: 35044,
    FLOAT: 5126,
    TRIANGLES: 4,
    uniforms: {},
    draws: 0,
    viewportSize: null,
    lost: 0,
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => !fail,
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
    viewport(x, y, width, height) { gl.viewportSize = [width, height] },
    uniform2f(name, x, y) { gl.uniforms[name] = [x, y] },
    uniform1f(name, value) { gl.uniforms[name] = value },
    uniform3fv(name, value) { gl.uniforms[name] = [...value] },
    drawArrays() { gl.draws += 1 },
    getExtension: () => ({ loseContext: () => { gl.lost += 1 } })
  }
  return gl
}

const htmlClasses = new Set()
const html = makeElement('html')
html.classList = {
  add: name => htmlClasses.add(name),
  remove: (...names) => names.forEach(name => htmlClasses.delete(name)),
  contains: name => htmlClasses.has(name)
}
const bodyProbe = makeStyleProbe()
const appProbe = makeStyleProbe()
const body = makeElement('body')
body.style = bodyProbe.style
const app = makeElement('div')
app.id = 'app'
app.style = appProbe.style
body.appendChild(app)

const documentElementProbe = makeStyleProbe()
html.style = documentElementProbe.style

globalThis.document = {
  hidden: false,
  visibilityState: 'visible',
  documentElement: html,
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
    get matches() { return mediaReduced && String(query).includes('reduced-motion') },
    addEventListener() {},
    removeEventListener() {}
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

const fireDocument = type => { for (const fn of documentListeners[type] || []) fn() }
const pendingFrames = () => frames.length

/** Run one queued frame at `nowMs`, the way the host would. */
function flushFrame(step = 100) {
  const next = frames.shift()
  if (!next) return false
  nowMs += step
  next.fn(nowMs)
  return true
}

// ------------------------------------------------------------- temp module

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aura-theme-test-'))
const pluginCopy = path.join(tmp, 'plugin.mjs')

const source = fs.readFileSync(PLUGIN, 'utf8')
fs.writeFileSync(
  pluginCopy,
  source
    .replace(/from\s+'@hermes\/plugin-sdk'/g, "from './sdk-stub.mjs'")
    .replace(/from\s+'react'/g, "from './react-stub.mjs'")
    .replace(/from\s+'react\/jsx-runtime'/g, "from './jsx-stub.mjs'") +
  '\nexport const auraTest = {' +
  ' sync: typeof syncAuraGlow === "function" ? syncAuraGlow : null,' +
  ' energy: typeof auraEnergy === "function" ? auraEnergy : null,' +
  ' theme: typeof AURA_THEME === "object" ? AURA_THEME : null,' +
  ' fragment: typeof AURA_FRAGMENT === "string" ? AURA_FRAGMENT : "",' +
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
  navigate: route => { calls.navigations.push(route) },
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

// ------------------------------------------------------------------- harness

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function mount() {
  const contributions = []
  const requests = []
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
      requests.push(route)
      if (route === '/status') {
        return { ok: true, port: 4321, url: 'http://127.0.0.1:4321/?token=x', capture: 'none', enabled: false }
      }
      if (route === '/state') {
        return { level: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0], silence: true, mood: 'idle' }
      }
      if (route === '/version') return { version: '1.0.0', commit: 'aura-theme' }
      if (route === '/player') return { ok: true, window: { open: false }, player: {}, seq: 0 }
      return { ok: true }
    }
  }
  const dispose = plugin.default.register(ctx)
  return { dispose, contributions, requests }
}

/** A fresh page: no canvas, no listeners, no frames, no theme attribute. */
function resetPage() {
  for (const node of [...html.children]) html.removeChild(node)
  for (const node of [...document.body.children]) document.body.removeChild(node)
  // Our #app stand-in is part of the page, not an Aura leftover.
  document.body.appendChild(app)
  createdElements.length = 0
  glContexts.length = 0
  frames = []
  glMode = 'ok'
  mediaReduced = false
  globalThis.document.hidden = false
  globalThis.document.visibilityState = 'visible'
  html.removeAttribute('data-hermes-theme')
  htmlClasses.clear()
  for (const key of Object.keys(documentListeners)) delete documentListeners[key]
  for (const key of Object.keys(windowListeners)) delete windowListeners[key]
  bodyProbe.writes.length = 0
  appProbe.writes.length = 0
  documentElementProbe.writes.length = 0
}

const canvasInPage = () => html.children.filter(node => node.tagName === 'CANVAS')
const glNow = () => glContexts.at(-1) || null

// ------------------------------------------------------------------ the checks

const themeContribution = () => mount()

await record('a. the theme registers through THEMES_AREA: one "aura" theme, both palettes, scoped CSS', async () => {
  resetPage()
  const bucket = themeContribution()
  const themes = bucket.contributions.filter(item => item.area === 'themes')
  assert.equal(themes.length, 1, `expected exactly one themes contribution, got ${themes.length}`)
  const theme = themes[0].data
  assert.equal(theme.name, 'aura')
  assert.equal(theme.label, 'Aura')
  assert.equal(typeof theme.customCSS, 'string')
  assert.ok(theme.colors && theme.colors.background, 'no light palette')
  assert.ok(theme.darkColors && theme.darkColors.background, 'no dark palette')
  // Scoped the way the theme contract wants: keyed on the active theme name.
  assert.match(theme.customCSS, /data-hermes-theme="aura"/)
  assert.match(theme.customCSS, /data-hermes-theme\^="aura-accent-"/)
  // Every rule block starts from that scope.
  const blocks = theme.customCSS.split('}').filter(part => part.trim() && part.includes('{'))
  for (const block of blocks) {
    const selector = block.slice(0, block.indexOf('{')).trim()
    if (/^@media/.test(selector)) continue
    assert.ok(selector.includes('data-hermes-theme'), `unscoped selector: ${selector}`)
  }
  bucket.dispose()
})

await record('b. the theme CSS never addresses body, #root or #app', async () => {
  resetPage()
  const bucket = themeContribution()
  const css = bucket.contributions.find(item => item.area === 'themes').data.customCSS
  for (const forbidden of ['body', '#root', '#app']) {
    const pattern = forbidden.startsWith('#')
      ? new RegExp(`(^|[},\\s])${forbidden.replace('#', '#')}\\b`)
      : /(^|[},\s])body\b/
    assert.doesNotMatch(css, pattern, `customCSS targets ${forbidden}`)
  }
  bucket.dispose()
})

await record('c. no canvas exists while another theme is active', async () => {
  resetPage()
  html.setAttribute('data-hermes-theme', 'nous')
  const bucket = themeContribution()
  await settle()
  assert.equal(canvasInPage().length, 0, 'a canvas was mounted under a foreign theme')
  assert.equal(pendingFrames(), 0, 'a render loop started under a foreign theme')
  bucket.dispose()
})

await record('d. choosing "aura" mounts one canvas behind the app, at 1 px per 3 CSS px', async () => {
  resetPage()
  const bucket = themeContribution()
  await settle()
  plugin.auraTest.sync('aura')
  const canvases = canvasInPage()
  assert.equal(canvases.length, 1, `expected one canvas, got ${canvases.length}`)
  const canvas = canvases[0]
  assert.equal(canvas.getAttribute('aria-hidden'), 'true')
  assert.equal(canvas.getAttribute('data-aura-glow'), '')
  assert.match(String(canvas.style.cssText), /position:fixed/)
  assert.match(String(canvas.style.cssText), /z-index:-1/)
  assert.match(String(canvas.style.cssText), /pointer-events:none/)
  // 1200 CSS px / 3 = 400 rendered pixels; 800 / 3 -> 267.
  assert.equal(canvas.width, 400, `canvas width is ${canvas.width}, expected 1200/3`)
  assert.equal(canvas.height, 267, `canvas height is ${canvas.height}, expected 800/3`)
  // Nothing on body, #root or #app, and no node was appended to body.
  assert.equal(document.body.children.length, 1, 'a node was added to body (the #app stand-in is the only child)')
  bucket.dispose()
})

await record('e. an accent retint keeps the canvas; the retired aura-live theme does not', async () => {
  resetPage()
  const bucket = themeContribution()
  await settle()
  plugin.auraTest.sync('aura-accent-6ea8ff')
  assert.equal(canvasInPage().length, 1, 'an aura-accent retint lost the glow')
  plugin.auraTest.sync('aura-live')
  assert.equal(canvasInPage().length, 0, 'the retired aura-live theme got the glow')
  plugin.auraTest.sync('aura')
  assert.equal(canvasInPage().length, 1, 'returning to aura did not remount the glow')
  bucket.dispose()
})

await record('f. a theme switch removes the canvas, and so does dispose', async () => {
  resetPage()
  const bucket = themeContribution()
  await settle()
  plugin.auraTest.sync('aura')
  assert.equal(canvasInPage().length, 1)
  assert.equal(pendingFrames(), 1, 'a looping frame was not scheduled')
  plugin.auraTest.sync('nous')
  assert.equal(canvasInPage().length, 0, 'switching themes left the canvas behind')
  assert.equal(pendingFrames(), 0, 'switching themes left a frame queued')
  assert.equal(glNow().lost, 1, 'the WebGL context was not released on the theme switch')

  plugin.auraTest.sync('aura')
  assert.equal(canvasInPage().length, 1)
  bucket.dispose()
  await settle()
  assert.equal(canvasInPage().length, 0, 'dispose left the canvas on <html>')
  assert.equal(pendingFrames(), 0, 'dispose left a frame queued')
  assert.equal(documentListeners.visibilitychange ? documentListeners.visibilitychange.length : 0, 0,
    'dispose left the visibility listener registered')
})

await record('g. the runtime writes no style onto body, #root or #app', async () => {
  resetPage()
  const bucket = themeContribution()
  await settle()
  plugin.auraTest.sync('aura')
  for (let i = 0; i < 6; i += 1) flushFrame()
  plugin.auraTest.sync('nous')
  bucket.dispose()
  await settle()
  assert.deepEqual(bodyProbe.writes, [], `body style was written: ${bodyProbe.writes.join(', ')}`)
  assert.deepEqual(appProbe.writes, [], `#app style was written: ${appProbe.writes.join(', ')}`)
  assert.deepEqual(documentElementProbe.writes, [], `<html> style was written: ${documentElementProbe.writes.join(', ')}`)
  assert.equal(html.hasAttribute('data-aura-backdrop'), false, 'data-aura-backdrop was set')
  assert.equal(html.hasAttribute('data-hermes-glass-on'), false, 'data-hermes-glass-on was set')
})

await record('h. activating the theme and drawing adds no network request', async () => {
  resetPage()
  const bucket = themeContribution()
  await settle()
  bucket.requests.length = 0
  plugin.auraTest.sync('aura')
  for (let i = 0; i < 8; i += 1) flushFrame()
  plugin.auraTest.setLive({ level: 0.7, silence: false, mood: 'thinking' })
  for (let i = 0; i < 4; i += 1) flushFrame()
  plugin.auraTest.sync('nous')
  await settle()
  assert.deepEqual(bucket.requests, [],
    `the theme made network requests of its own: ${bucket.requests.join(', ')}`)
  bucket.dispose()
})

await record('i. the loop pauses while the window is hidden and resumes when visible', async () => {
  resetPage()
  const bucket = themeContribution()
  await settle()
  plugin.auraTest.sync('aura')
  assert.equal(pendingFrames(), 1, 'no frame was scheduled while visible')
  flushFrame(40)
  assert.equal(pendingFrames(), 1, 'the loop stopped on its own')
  const drawsBefore = glNow().draws

  globalThis.document.hidden = true
  globalThis.document.visibilityState = 'hidden'
  fireDocument('visibilitychange')
  assert.equal(pendingFrames(), 0, 'a hidden window kept a frame queued')
  assert.equal(glNow().draws, drawsBefore, 'a hidden window kept drawing')

  globalThis.document.hidden = false
  globalThis.document.visibilityState = 'visible'
  fireDocument('visibilitychange')
  assert.equal(pendingFrames(), 1, 'showing the window did not resume the loop')
  flushFrame(80)
  assert.ok(glNow().draws > drawsBefore, 'the resumed loop never drew')
  bucket.dispose()
})

await record('j. prefers-reduced-motion draws one still frame and schedules no loop', async () => {
  resetPage()
  mediaReduced = true
  const bucket = themeContribution()
  await settle()
  plugin.auraTest.sync('aura')
  assert.equal(canvasInPage().length, 1, 'reduced motion lost the glow entirely')
  assert.equal(pendingFrames(), 0, 'reduced motion still scheduled an animation loop')
  const gl = glNow()
  assert.equal(gl.draws, 1, `reduced motion drew ${gl.draws} frames, expected exactly one still frame`)
  // The still frame is a fixed moment, not the running clock.
  assert.equal(gl.uniforms.uTime, 12, 'the reduced-motion frame is not held still')
  bucket.dispose()
})

await record('k. level, silence and mood reach the shaders as uniforms; quiet means calm', async () => {
  resetPage()
  const bucket = themeContribution()
  await settle()
  // Nothing playing: even a loud stale level must read as silence.
  plugin.auraTest.setLive({ level: 0.9, silence: false, mood: 'idle' })
  const calm = plugin.auraTest.energy()
  assert.equal(calm.silence, 1, 'nothing playing did not report silence')

  const audio = plugin.auraTest.audio.get()
  plugin.auraTest.audio.set({ ...audio, playing: true })
  plugin.auraTest.setLive({ level: 0.62, silence: false, mood: 'thinking' })
  plugin.auraTest.sync('aura')
  flushFrame(40)
  let gl = glNow()
  assert.equal(gl.uniforms.uLevel, 0.62, `uLevel is ${gl.uniforms.uLevel}, expected 0.62`)
  assert.equal(gl.uniforms.uSilence, 0, 'playing audio reported silence')
  assert.equal(gl.uniforms.uMood, 0.55, `uMood is ${gl.uniforms.uMood}, expected 0.55 for a working mood`)

  plugin.auraTest.setLive({ level: 0.62, silence: false, mood: 'approval' })
  flushFrame(40)
  assert.equal(glNow().uniforms.uMood, 1, 'an approval did not lift the mood uniform')

  // The film/radio stops: the glow is calm again even before the next poll.
  plugin.auraTest.audio.set({ ...plugin.auraTest.audio.get(), playing: false })
  flushFrame(40)
  gl = glNow()
  assert.equal(gl.uniforms.uSilence, 1, 'a stopped channel left the glow at full energy')
  bucket.dispose()
})

await record('l. webglcontextlost stops the loop; restore brings it back', async () => {
  resetPage()
  const bucket = themeContribution()
  await settle()
  plugin.auraTest.sync('aura')
  const canvas = canvasInPage()[0]
  let prevented = 0
  canvas.fire('webglcontextlost', { preventDefault() { prevented += 1 } })
  assert.equal(prevented, 1, 'the lost event was not handled')
  assert.equal(pendingFrames(), 0, 'the loop kept running after the context was lost')
  canvas.fire('webglcontextrestored', {})
  assert.equal(pendingFrames(), 1, 'the restored event did not resume the loop')
  bucket.dispose()
})

await record('m. with no WebGL the canvas still mounts as a flat colour and nothing throws', async () => {
  resetPage()
  glMode = 'none'
  const bucket = themeContribution()
  await settle()
  plugin.auraTest.sync('aura')
  const canvases = canvasInPage()
  assert.equal(canvases.length, 1, 'a WebGL-less host got no background at all')
  assert.match(String(canvases[0].style.backgroundColor), /^#(0b0d12|f4f7fb)$/,
    `no flat fallback colour, got "${canvases[0].style.backgroundColor}"`)
  assert.equal(pendingFrames(), 0, 'a WebGL-less canvas started a render loop')
  plugin.auraTest.sync('nous')
  assert.equal(canvasInPage().length, 0, 'the fallback canvas survived the theme switch')
  bucket.dispose()
})

await record('n. the fragment shader is short and reads only the uniforms it declares', async () => {
  const fragment = plugin.auraTest.fragment
  assert.ok(fragment.length > 200, 'the fragment shader is missing')
  assert.ok(fragment.length <= 2200, `the fragment shader is ${fragment.length} chars: not a short shader`)
  for (const uniform of ['uRes', 'uTime', 'uLevel', 'uSilence', 'uMood', 'uNight', 'uBase', 'uGlowA', 'uGlowB']) {
    assert.match(fragment, new RegExp(`uniform[^\\n]*${uniform}\\b`), `the shader does not declare ${uniform}`)
  }
  assert.match(fragment, /gl_FragColor/)
  assert.doesNotMatch(fragment, /texture2D|sampler2D/, 'the shader samples a texture: nothing is uploaded')
})

await record('o. the theme code carries no URL, token, fetch or extra request', async () => {
  const start = source.indexOf('Aura theme (prototype)')
  const end = source.indexOf('/** One control that returns the host to the user')
  assert.ok(start > 0 && end > start, 'the Aura theme block was not found in plugin.js')
  const block = source.slice(start, end)
  assert.doesNotMatch(block, /https?:\/\//, 'a URL appeared in the theme code')
  assert.doesNotMatch(block, /\btoken\s*[=:]|Authorization|Bearer/i, 'a credential appeared in the theme code')
  assert.doesNotMatch(block, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/, 'network code appeared in the theme code')
  assert.doesNotMatch(block, /\/status|['"]\/state['"]/, 'the glow polls the server itself')
  assert.doesNotMatch(block, /\.body\b/, 'the theme code reaches for document.body')
})

// ------------------------------------------------------------------ report

for (const line of results) console.log(line)
console.log(`\naura theme: ${results.length - failed}/${results.length}`)
process.exit(failed ? 1 : 0)
