/**
 * "Only while active" must not fade a visualiser that is still drawing.
 *
 * The page wakes from its own PCM stream on a peak floor (web/aura.js
 * SILENCE_PEAK); the desktop used to fade the frame on the server's level,
 * whose 0.02 gate is the -58.8 dBFS silence line. A continuous tone sits
 * between the two gates: loud enough that the page keeps rendering, quiet
 * enough that its RMS maps below 0.02. With the agent idle the iframe then
 * fades to opacity 0 over a page that is visibly drawing.
 *
 * This feeds that tone as the server reports it (level + its silence bit) with
 * the agent idle, advances the show delay and the whole fade ramp, and requires
 * the iframe to be visible. The harness is the one tests/test_no_backdrop.mjs
 * uses: a temp copy of the plugin with its three import specifiers rewritten to
 * local stubs, a fake DOM, and the panel film mounted through its real ref.
 *
 * Run: node tests/test_show_quiet_music.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGIN = path.join(ROOT, 'desktop', 'plugin.js')

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
    querySelector() { throw new Error('querySelector') },
    querySelectorAll() { throw new Error('querySelector') }
  }
}

function makeElement(tagName) {
  const node = {
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
    querySelector() { throw new Error('querySelector') },
    querySelectorAll() { throw new Error('querySelector') },
    get firstChild() { return this.children[0] || null }
  }
  return node
}

const headChildren = []
const bodyChildren = []
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
  querySelector() { throw new Error('querySelector') },
  querySelectorAll() { throw new Error('querySelector') },
  getElementById() { throw new Error('getElementById') }
}
globalThis.getComputedStyle = () => ({ backgroundColor: 'rgba(0,0,0,0)', getPropertyValue: () => '' })

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aura-quiet-music-'))
const pluginCopy = path.join(tmp, 'plugin.mjs')
fs.writeFileSync(
  pluginCopy,
  fs.readFileSync(PLUGIN, 'utf8')
    .replace(/from\s+'@hermes\/plugin-sdk'/g, "from './sdk-stub.mjs'")
    .replace(/from\s+'react'/g, "from './react-stub.mjs'")
    .replace(/from\s+'react\/jsx-runtime'/g, "from './jsx-stub.mjs'") +
  '\nexport const quietMusicTest = { updateShow, applyVideoOpacity, poll, settings: $settings, live: $live, surface: $filmSurface }\n'
)

fs.writeFileSync(path.join(tmp, 'sdk-stub.mjs'), `
export const calls = { navigations: [] }
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

function makeCtx(settings) {
  const contributions = []
  const storage = new Map()
  const timers = []
  const serverFrame = {
    level: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0], silence: true, mood: 'idle', enabled: true
  }
  if (settings) storage.set('settings', settings)
  const ctx = {
    source: 'plugin:aura',
    register(contribution) {
      const entry = { ...contribution, removed: false }
      contributions.push(entry)
      return () => {
        entry.removed = true
        const index = contributions.indexOf(entry)
        if (index >= 0) contributions.splice(index, 1)
      }
    },
    registerSettingsPage(page) {
      return ctx.register({ id: page.id, area: 'settings.plugins', render: page.render })
    },
    onDispose() {},
    setInterval() { return () => {} },
    setTimeout(fn, ms) {
      const entry = { fn, ms, cleared: false }
      timers.push(entry)
      return () => { entry.cleared = true }
    },
    addEventListener() { return () => {} },
    storage: {
      get(key, fallback) { return storage.has(key) ? storage.get(key) : fallback },
      set(key, value) { storage.set(key, value) },
      remove(key) { storage.delete(key) }
    },
    async rest(route) {
      if (route === '/status') {
        return { ok: true, port: 4321, url: 'http://127.0.0.1:4321/?token=not-shown-in-ui', capture: 'none', enabled: true }
      }
      if (route === '/state') return { ...serverFrame, bands: [...serverFrame.bands] }
      if (route === '/version') return { version: '1.2.3' }
      if (route === '/window') return { ok: true, available: true, open: false }
      return { ok: true }
    }
  }
  return { ctx, contributions, storage, timers, serverFrame }
}

function expand(node, acc) {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) expand(child, acc)
    return
  }
  acc.push(node)
  const kids = node.props && node.props.children
  if (kids) expand(kids, acc)
  if (typeof node.type === 'function') {
    const rendered = node.type(node.props || {})
    if (rendered) expand(rendered, acc)
  }
}

function nodesOf(contribution) {
  const acc = []
  if (contribution && typeof contribution.render === 'function') expand(contribution.render(), acc)
  return acc
}

function filmsIn(contribution) {
  return nodesOf(contribution).filter(node =>
    node.props && ['panel', 'page', 'window'].includes(node.props.placement) && typeof node.type === 'function'
  )
}

function iframeOf(film) {
  const view = film.type(film.props)
  assert.equal(view && view.type, 'iframe', 'AuraFilm did not render an iframe')
  return view
}

function adopt(view) {
  const node = makeElement('iframe')
  node.src = view.props.src
  node.contentWindow = { postMessage: () => {} }
  view.props.ref(node)
  return node
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The page's own wake floor, read out of the page that consumes the PCM. */
function pageSilencePeak() {
  const page = fs.readFileSync(path.join(ROOT, 'web', 'aura.js'), 'utf8')
  const match = /const SILENCE_PEAK = ([0-9.]+);/.exec(page)
  assert.ok(match, 'web/aura.js no longer declares SILENCE_PEAK')
  return Number(match[1])
}

/** A continuous sine's peak -> the server's level (aura_core.analysis). */
function levelOfSine(peak) {
  const rms = peak / Math.SQRT2
  const db = 20 * Math.log10(rms)
  return Math.max(0, Math.min(1, (db + 60) / 60))
}

/** Run every show delay / fade step the plugin schedules, in order. */
function advanceShow(bucket) {
  let cursor = 0
  for (let guard = 0; guard < 40; guard += 1) {
    const pending = bucket.timers.slice(cursor).filter(timer => timer.ms === 300 || timer.ms === 250)
    cursor = bucket.timers.length
    if (!pending.length) return
    for (const timer of pending) {
      if (timer.cleared !== true) timer.fn()
    }
  }
}

await record('a quiet tone the page is drawing keeps the in-pane visualiser visible', async () => {
  const tonePeak = 0.0016
  const wakePeak = pageSilencePeak()
  assert.ok(tonePeak > wakePeak,
    `the tone (${tonePeak}) is below the page's wake floor (${wakePeak}), so this is not the reported case`)
  const toneLevel = levelOfSine(tonePeak)
  assert.ok(toneLevel < 0.02,
    `the tone maps to level ${toneLevel.toFixed(4)}, which the old 0.02 gate would have accepted anyway`)

  const bucket = makeCtx({
    enabled: true, backdropMode: 'aura', panelEnabled: true, showWhen: 'active', motion: 'music'
  })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(40)
    const panel = bucket.contributions.find(item => item.id === 'panel')
    const film = filmsIn(panel)
    assert.equal(film.length, 1, 'the visualiser is not in the panel')
    const frame = adopt(iframeOf(film[0]))
    plugin.quietMusicTest.updateShow()
    plugin.quietMusicTest.applyVideoOpacity()
    assert.equal(frame.style.opacity, '0', 'an idle visualiser started out visible')

    // The tone as the server reports it: its RMS level, flagged silent because
    // it sits under the analyser's silence line. The agent is idle.
    bucket.serverFrame.mood = 'idle'
    bucket.serverFrame.silence = true
    bucket.serverFrame.level = toneLevel
    await plugin.quietMusicTest.poll()
    plugin.quietMusicTest.updateShow()
    advanceShow(bucket)

    assert.equal(frame.style.opacity, '1',
      `the iframe faded to ${frame.style.opacity} while the page was still drawing the tone`)
  } finally {
    dispose()
  }
})

await record('a genuinely silent frame still fades the visualiser out', async () => {
  const bucket = makeCtx({
    enabled: true, backdropMode: 'aura', panelEnabled: true, showWhen: 'active', motion: 'music'
  })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(40)
    const panel = bucket.contributions.find(item => item.id === 'panel')
    const frame = adopt(iframeOf(filmsIn(panel)[0]))
    bucket.serverFrame.mood = 'idle'
    bucket.serverFrame.silence = false
    bucket.serverFrame.level = 0.8
    await plugin.quietMusicTest.poll()
    plugin.quietMusicTest.updateShow()
    advanceShow(bucket)
    assert.equal(frame.style.opacity, '1', 'a loud frame did not show the visualiser')

    bucket.serverFrame.silence = true
    bucket.serverFrame.level = 0
    await plugin.quietMusicTest.poll()
    plugin.quietMusicTest.updateShow()
    const idle = bucket.timers.filter(timer => timer.ms === 2500 && timer.cleared !== true).pop()
    assert.ok(idle, 'silence did not arm the fade-out timer')
    idle.fn()
    advanceShow(bucket)
    assert.equal(frame.style.opacity, '0', 'a silent frame left the visualiser on screen')
  } finally {
    dispose()
  }
})

for (const line of results) console.log(line)
if (failed) {
  console.log(`\n${failed} failed`)
  process.exitCode = 1
} else {
  console.log('\nall passed')
}
