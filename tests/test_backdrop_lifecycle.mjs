/**
 * The "Behind chat" backdrop's own lifecycle — desktop/plugin.js.
 *
 * Three review findings, each a check that fails on the reviewed code:
 *
 *   B1. An Off pressed while its /control POST is still in flight must not be
 *       undone by a backdrop remount. Leaving the Aura page or flipping Gentle
 *       motion calls syncBackdrop(); that path used to trust the stale
 *       $live.enabled (the server still said "on") and painted the film back
 *       over the chat. The user's own setting decides, exactly as poll() does.
 *   B2. A replaced server (new port and token, same film) must re-point the
 *       iframe at it — and the same server must NOT restart the film.
 *   B3. The backdrop's box is the layout viewport: inset:0 only, never
 *       100vw/100vh (a classic scrollbar on Windows makes them wider/taller
 *       than the layout viewport and the box then overflows).
 *
 * Same fake host as tests/test_no_backdrop.mjs: a temp copy of the plugin has
 * its import specifiers rewritten to local stubs, and the copy exposes the few
 * internals these checks drive.
 *
 * Run: node tests/test_backdrop_lifecycle.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGIN = path.join(ROOT, 'desktop', 'plugin.js')
const FILM = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'

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

const bodyAppends = []
const headChildren = []
const bodyChildren = []

function makeParent(children) {
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
    appendChild(node) {
      if (this === document.body) bodyAppends.push(node)
      node.parentNode = this
      children.push(node)
      return node
    },
    removeChild(node) {
      const index = children.indexOf(node)
      if (index >= 0) children.splice(index, 1)
      node.parentNode = null
      return node
    },
    querySelector() { return null },
    querySelectorAll() { return [] }
  }
}

function makeElement(tagName) {
  return {
    tagName: String(tagName).toUpperCase(),
    style: {},
    attributes: {},
    children: [],
    parentNode: null,
    textContent: '',
    value: '',
    src: '',
    dataset: {},
    className: '',
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
    getBoundingClientRect() { return { width: 320, height: 180, left: 0, top: 0, right: 320, bottom: 180 } },
    remove() { if (this.parentNode) this.parentNode.removeChild(this) },
    querySelector() { return null },
    querySelectorAll() { return [] },
    get firstChild() { return this.children[0] || null }
  }
}

const documentElement = {
  style: {},
  attributes: {},
  setAttribute(name, value) { this.attributes[name] = String(value) },
  getAttribute(name) { return this.attributes[name] },
  removeAttribute(name) { delete this.attributes[name] },
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) }
}

globalThis.document = {
  hidden: false,
  visibilityState: 'visible',
  documentElement,
  head: makeParent(headChildren),
  body: makeParent(bodyChildren),
  createElement: makeElement,
  addEventListener() {},
  removeEventListener() {},
  querySelector() { return null },
  querySelectorAll() { return [] },
  getElementById() { return null }
}
globalThis.getComputedStyle = () => ({ backgroundColor: 'rgba(0,0,0,0)', getPropertyValue: () => '' })

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aura-backdrop-life-'))
const pluginCopy = path.join(tmp, 'plugin.mjs')
fs.writeFileSync(
  pluginCopy,
  fs.readFileSync(PLUGIN, 'utf8')
    .replace(/from\s+'@hermes\/plugin-sdk'/g, "from './sdk-stub.mjs'")
    .replace(/from\s+'react'/g, "from './react-stub.mjs'")
    .replace(/from\s+'react\/jsx-runtime'/g, "from './jsx-stub.mjs'") +
  '\nexport const backdropLifeTest = { setEnabled, setReducedMotion, setFilmBehind, poll, syncBackdrop, settings: $settings, live: $live, surface: () => $backdropSurface.get() }\n'
)

fs.writeFileSync(path.join(tmp, 'sdk-stub.mjs'), `
function makeAtom(initial) {
  let value = initial
  return { get: () => value, set: next => { value = next }, listen: () => () => {} }
}
export const calls = { navigations: [] }
export const atom = makeAtom
export const $accentOverride = makeAtom(null)
export const setAccentOverride = () => {}
export const requestTheme = () => true
export const host = {
  state: { focusedStoredSessionId: { get: () => 'chat/1' } },
  navigate: route => { calls.navigations.push(route) },
  notify: () => {},
  undismissPane: () => {},
  revealPane: () => {},
  composer: { focus: () => {} }
}
export const useValue = store => store.get()
export const useTheme = () => ({
  themeName: 'nous', theme: { name: 'nous', colors: { accent: '#8b7cff' } },
  setTheme: () => {}, mode: 'dark', resolvedMode: 'dark', renderedMode: 'dark',
  availableThemes: [], setMode: () => {}, previewTheme: () => {}, clearThemePreview: () => {}
})
export const Button = () => null
export const Switch = () => null
export const Popover = () => null
export const PopoverTrigger = () => null
export const PopoverContent = () => null
export const PALETTE_AREA = 'palette'
export const BACKDROP_AREA = 'backdrop'
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
const api = plugin.backdropLifeTest

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// The contribution Aura registers in the host's backdrop layer. Nothing about
// Behind chat touches the page any more: these checks read the registration and
// the element its render produces.
const backdropContribs = bucket => bucket.contributions.filter(item => item.area === 'backdrop')
const oneContribution = bucket => {
  const list = backdropContribs(bucket)
  assert.equal(list.length, 1, `expected exactly one backdrop contribution, got ${list.length}`)
  return list[0]
}
const oneFrame = bucket => {
  const entry = oneContribution(bucket)
  const element = entry.render()
  assert.ok(element && element.props, 'the backdrop contribution rendered nothing')
  return element
}

function makeCtx(settings) {
  const contributions = []
  const storage = new Map()
  if (settings) storage.set('settings', settings)
  // A /control gate a check can hold open to model a POST in flight.
  const gate = { wait: null }
  const ctx = {
    source: 'plugin:aura',
    register(contribution) {
      const record = { ...contribution, removed: false }
      contributions.push(record)
      return () => {
        record.removed = true
        const index = contributions.indexOf(record)
        if (index >= 0) contributions.splice(index, 1)
      }
    },
    registerSettingsPage(page) {
      return ctx.register({ id: page.id, area: 'settings.plugins', render: page.render })
    },
    onDispose() {},
    setInterval() { return () => {} },
    setTimeout() { return () => {} },
    addEventListener() { return () => {} },
    storage: {
      get(key, fallback) { return storage.has(key) ? storage.get(key) : fallback },
      set(key, value) { storage.set(key, value) },
      remove(key) { storage.delete(key) }
    },
    async rest(route) {
      if (route === '/control') {
        if (gate.wait) await gate.wait.promise
        return { ok: true }
      }
      if (route === '/status') {
        return {
          ok: true,
          port: server.port,
          url: server.url,
          capture: 'none',
          enabled: server.enabled !== false
        }
      }
      if (route === '/state') {
        return { level: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0], silence: true, mood: 'idle' }
      }
      if (route === '/version') return { version: '1.2.3' }
      if (route === '/window') return { ok: true, available: true, open: false }
      if (route === '/player') return { ok: true }
      return { ok: true }
    }
  }
  return { ctx, contributions, storage, gate }
}

const server = { port: 4321, url: 'http://127.0.0.1:4321/?token=first-token', enabled: true }

const BEHIND = {
  enabled: true, backdropMode: 'video', panelEnabled: true, filmBehind: true, videoUrl: FILM
}

// ------------------------------------------------------------------ checks

await record('B1. off never remounts Behind chat while the switch POST is in flight', async () => {
  server.port = 4321
  server.url = 'http://127.0.0.1:4321/?token=first-token'
  server.enabled = true
  const bucket = makeCtx({ ...BEHIND })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(40)
    oneFrame(bucket)   // precondition: the film is behind the chat while Aura is on

    // The user presses Off. The POST is held open: controlPushPending is 1 and
    // $live still says the server has Aura on.
    let release
    bucket.gate.wait = { promise: new Promise(resolve => { release = resolve }) }
    const off = api.setEnabled(false)
    await sleep(20)
    assert.equal(api.settings.get().enabled, false, 'precondition: the Off was not recorded')
    assert.equal(backdropContribs(bucket).length, 0, 'the Off itself left the backdrop registered')
    assert.equal(api.live.get().enabled, true,
      'precondition: the stale /status answer is what the live state still reports')

    // Leaving the page, or flipping Gentle motion, calls syncBackdrop().
    void api.setReducedMotion(true)
    await sleep(20)
    assert.equal(backdropContribs(bucket).length, 0,
      'Gentle motion re-registered Behind chat while the Off POST was still in flight')
    assert.equal(documentElement.hasAttribute('data-aura-backdrop'), false,
      'the host root was written to while the Off POST was still in flight')

    // A /status that shares the Off's epoch but read the old switch must not
    // bring it back either.
    await api.poll()
    assert.equal(backdropContribs(bucket).length, 0, 'a stale /status re-registered Behind chat after the Off')

    release()
    await off
    await api.poll()
    assert.equal(backdropContribs(bucket).length, 0, 'Behind chat came back once the Off settled')
    assert.equal(api.settings.get().enabled, false, 'the Off was undone')
  } finally {
    dispose()
  }
})

await record('B2. a replaced server re-points the backdrop; the same server does not restart it', async () => {
  server.port = 4321
  server.url = 'http://127.0.0.1:4321/?token=first-token'
  server.enabled = true
  const bucket = makeCtx({ ...BEHIND })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(40)
    const entry = oneContribution(bucket)
    const frame = oneFrame(bucket)
    assert.match(String(frame.props.src), /127\.0\.0\.1:4321/, `backdrop src is ${frame.props.src}`)
    assert.match(String(frame.props.src), /token=first-token/, `backdrop src is ${frame.props.src}`)
    // What the layer paints, as one atom: a poll that changes nothing must not
    // write it, or React re-points the frame and the film restarts.
    const before = api.surface()

    // The same server, same film: a poll must not reload the page.
    await api.poll()
    assert.equal(api.surface(), before, 'a plain poll re-pointed the film')
    assert.equal(oneContribution(bucket), entry, 'a plain poll re-registered the contribution')

    // The server restarts on a new port with a new token; the film is unchanged.
    server.port = 5555
    server.url = 'http://127.0.0.1:5555/?token=second-token'
    await api.poll()
    const after = oneFrame(bucket)
    assert.equal(oneContribution(bucket), entry, 'the backdrop contribution was replaced instead of re-pointed')
    assert.match(String(after.props.src), /127\.0\.0\.1:5555/,
      `the backdrop kept the dead server: ${after.props.src}`)
    assert.match(String(after.props.src), /token=second-token/,
      `the backdrop kept the old token: ${after.props.src}`)
  } finally {
    dispose()
  }
})

await record('B3. the backdrop fills the host layer and never positions itself', async () => {
  server.port = 4321
  server.url = 'http://127.0.0.1:4321/?token=first-token'
  server.enabled = true
  const bucket = makeCtx({ ...BEHIND })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(40)
    const frame = oneFrame(bucket)
    const style = frame.props.style || {}
    // The host's layer is already fixed, full-window and click-through; the
    // iframe paints inside that box and nothing else.
    assert.equal(style.width, '100%', `the backdrop does not fill the layer (width ${style.width})`)
    assert.equal(style.height, '100%', `the backdrop does not fill the layer (height ${style.height})`)
    assert.equal(style.position, undefined, 'the backdrop positions itself inside the layer')
    assert.equal(style.inset, undefined, 'the backdrop pins itself inside the layer')
    for (const key of ['position', 'inset', 'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight']) {
      const value = String(style[key] == null ? '' : style[key])
      assert.doesNotMatch(value, /v(w|h)\b/, `the backdrop sets ${key}: ${value}`)
    }
    const css = Object.keys(style).map(key => `${key}:${style[key]}`).join(';')
    assert.doesNotMatch(css, /\d+v(w|h)\b/, `the backdrop uses viewport units: ${css}`)
    // Nothing was written to the host page for it.
    assert.equal(bodyChildren.filter(node => node.tagName === 'IFRAME').length, 0,
      'the backdrop put an iframe on the host body')
    assert.equal(headChildren.length, 0, 'the backdrop put a stylesheet in <head>')
  } finally {
    dispose()
  }
})

for (const line of results) console.log(line)
console.log(`\nbackdrop lifecycle: ${results.length - failed}/${results.length}`)
process.exit(failed ? 1 : 0)
