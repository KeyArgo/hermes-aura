/**
 * The body backdrop is gone from this build. These checks fail on a plugin
 * that still paints the host page, and pass once the visualiser and the film
 * share Aura's own iframe.
 *
 * Run: node tests/test_no_backdrop.mjs
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
const headAppends = []
const glassReads = []
const backdropAttrs = []
const glassStyles = []

function makeParent(children) {
  const classes = new Set()
  const parent = {
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
      if (this === document.head) headAppends.push(node)
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
  return parent
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
    setAttribute(name, value) {
      this.attributes[name] = String(value)
      if (this.tagName === 'STYLE' && name === 'id' && String(value) === 'aura-glass') glassStyles.push(this)
    },
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
  setAttribute(name, value) {
    this.attributes[name] = String(value)
    if (name === 'data-aura-backdrop') backdropAttrs.push('set')
  },
  getAttribute(name) { return this.attributes[name] },
  removeAttribute(name) {
    if (name === 'data-aura-backdrop') backdropAttrs.push('remove')
    delete this.attributes[name]
  },
  hasAttribute(name) {
    glassReads.push(name)
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
  }
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

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aura-nobackdrop-'))
const pluginCopy = path.join(tmp, 'plugin.mjs')
fs.writeFileSync(
  pluginCopy,
  fs.readFileSync(PLUGIN, 'utf8')
    .replace(/from\s+'@hermes\/plugin-sdk'/g, "from './sdk-stub.mjs'")
    .replace(/from\s+'react'/g, "from './react-stub.mjs'")
    .replace(/from\s+'react\/jsx-runtime'/g, "from './jsx-stub.mjs'") +
  '\nexport const nobackdropTest = { setBackdropMode, setPanelEnabled, playAudioSource, settings: $settings, surface: $filmSurface }\n'
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
  if (settings) storage.set('settings', settings)
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
    async rest(route, options = {}) {
      if (route === '/status') {
        return { ok: true, port: 4321, url: 'http://127.0.0.1:4321/?token=not-shown-in-ui', capture: 'none', enabled: true }
      }
      if (route === '/state') {
        return { level: 0.2, bands: [0, 0, 0, 0, 0, 0, 0, 0], silence: false, mood: 'thinking', enabled: true }
      }
      if (route === '/version') return { version: '1.2.3' }
      if (route === '/control') return { ok: true }
      return { ok: true }
    }
  }
  return { ctx, contributions, storage }
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
  assert.equal(view.props.title, 'Aura film')
  assert.equal(view.props.sandbox, 'allow-scripts allow-same-origin allow-presentation')
  return view
}

function adopt(view) {
  const node = makeElement('iframe')
  node.src = view.props.src
  node.__sent = []
  node.contentWindow = { postMessage: message => { node.__sent.push(message) } }
  view.props.ref(node)
  return node
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

await record('after register, radio, mode switches and dispose, Aura never touches the host page', async () => {
  const bucket = makeCtx({
    enabled: true, backdropMode: 'aura', panelEnabled: true, windowVisual: true, videoUrl: FILM
  })
  const dispose = plugin.default.register(bucket.ctx)
  await sleep(30)
  const panel = bucket.contributions.find(item => item.id === 'panel')
  const host = makeElement('div')
  const theatre = nodesOf(panel).find(node => node.props && node.props.ref)
  assert.equal(typeof (theatre && theatre.props.ref), 'function', 'the panel has no host ref')
  theatre.props.ref(host)
  await plugin.nobackdropTest.playAudioSource('https://ice.example/live.mp3', 'Example')
  await plugin.nobackdropTest.setBackdropMode('video')
  await plugin.nobackdropTest.setBackdropMode('aura')
  dispose()
  assert.equal(bodyAppends.length, 0, 'Aura appended a node to document.body')
  assert.equal(bodyChildren.length, 0, 'document.body still holds an Aura node')
  assert.equal(glassStyles.length, 0, 'a #aura-glass style was created')
  assert.equal(headChildren.some(node => node.attributes && node.attributes.id === 'aura-glass'), false)
  assert.equal(documentElement.hasAttribute('data-aura-backdrop'), false)
  assert.equal(backdropAttrs.length, 0, 'data-aura-backdrop was set or removed')
  assert.equal(glassReads.includes('data-hermes-glass-on'), false, 'Aura read data-hermes-glass-on')
})

await record('Visualizer mode renders the visualiser page in the Right panel, Video swaps it, panel off removes it', async () => {
  const bucket = makeCtx({
    enabled: true, backdropMode: 'aura', panelEnabled: true, videoWindow: false, videoUrl: FILM
  })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    const panel = () => bucket.contributions.find(item => item.id === 'panel')
    let film = filmsIn(panel())
    assert.equal(film.length, 1, 'Visualizer mode did not render an Aura iframe in the panel')
    assert.equal(film[0].props.placement, 'panel')
    let view = iframeOf(film[0])
    assert.match(view.props.src, /overlay=1/, 'the panel iframe is not the visualiser page')
    assert.doesNotMatch(view.props.src, /player\.html/, 'Visualizer mode rendered the player page')
    assert.match(view.props.src, /127\.0\.0\.1:4321/, 'the visualiser URL lost the live server')
    await plugin.nobackdropTest.setBackdropMode('video')
    film = filmsIn(panel())
    assert.equal(film.length, 1, 'Video mode dropped the panel iframe')
    view = iframeOf(film[0])
    assert.match(view.props.src, /player\.html/, 'Video mode did not swap to the player page')
    assert.doesNotMatch(view.props.src, /overlay=1/, 'Video mode kept the visualiser page')
    plugin.nobackdropTest.setPanelEnabled(false)
    assert.equal(panel(), undefined, 'switching the panel off left the panel contribution')
    assert.equal(plugin.nobackdropTest.surface.get().placement, '', 'switching the panel off left the iframe placed')
    assert.equal(bodyAppends.length, 0, 'the panel iframe was appended to document.body')
  } finally {
    dispose()
  }
})

await record('radio plays into the in-pane visualiser frame and survives a Visualizer <-> Video swap', async () => {
  const bucket = makeCtx({
    enabled: true, backdropMode: 'aura', panelEnabled: true, videoUrl: FILM, audioVolume: 0.4
  })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    const panel = () => bucket.contributions.find(item => item.id === 'panel')
    const visual = adopt(iframeOf(filmsIn(panel())[0]))
    const played = await plugin.nobackdropTest.playAudioSource('https://ice.example/swap.mp3', 'Swap')
    assert.equal(played, true)
    await sleep(0)
    assert.ok(
      visual.__sent.some(message => message.aura === 'audio' && message.cmd === 'play' && message.url === 'https://ice.example/swap.mp3'),
      'play was not posted to the in-pane visualiser frame'
    )
    await plugin.nobackdropTest.setBackdropMode('video')
    const playerView = iframeOf(filmsIn(panel())[0])
    assert.match(playerView.props.src, /player\.html/)
    const player = adopt(playerView)
    playerView.props.onLoad()
    assert.ok(
      player.__sent.some(message => message.aura === 'audio' && message.cmd === 'play'),
      'the video frame did not resume the radio'
    )
    assert.ok(
      visual.__sent.some(message => message.aura === 'audio' && message.cmd === 'stop'),
      'the visualiser frame kept playing after the swap'
    )
    await plugin.nobackdropTest.setBackdropMode('aura')
    const backView = iframeOf(filmsIn(panel())[0])
    assert.match(backView.props.src, /overlay=1/)
    const again = adopt(backView)
    backView.props.onLoad()
    assert.ok(again.__sent.some(message => message.aura === 'audio' && message.cmd === 'play'), 'the visualiser did not resume the radio')
    assert.ok(player.__sent.some(message => message.aura === 'audio' && message.cmd === 'stop'), 'the player kept a second stream')
  } finally {
    dispose()
  }
})

await record('the Video URL apply button uses the typed value without querySelector', async () => {
  const bucket = makeCtx({ enabled: true, backdropMode: 'video', panelEnabled: true, videoUrl: '' })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(20)
    const menu = bucket.contributions.find(item => item.area === 'statusBar.right')
    const tree = nodesOf(menu)
    const input = tree.find(node => node.props && node.props['aria-label'] === 'Video URL' && node.props.ref)
    const apply = tree.find(node => node.props && node.props['aria-label'] === 'Apply video URL')
    assert.ok(input, 'the Video URL field has no ref')
    assert.ok(apply && typeof apply.props.onClick === 'function', 'the Apply button is missing')
    const typed = 'https://example.com/typed.mp4'
    input.props.ref.current = { value: typed }
    apply.props.onClick()
    await sleep(20)
    assert.equal(plugin.nobackdropTest.settings.get().videoUrl, typed, 'Apply did not use the typed value')
  } finally {
    dispose()
  }
})

await record('Aura adds nothing to the app <head>; each surface carries its own stylesheet', async () => {
  const before = headAppends.length
  const bucket = makeCtx({ enabled: true, backdropMode: 'aura', panelEnabled: true })
  const dispose = plugin.default.register(bucket.ctx)
  await sleep(30)
  const panel = bucket.contributions.find(item => item.id === 'panel')
  const host = makeElement('div')
  const theatre = nodesOf(panel).find(node => node.props && node.props.ref)
  if (theatre) theatre.props.ref(host)
  await sleep(30)
  let styled = 0
  for (const item of bucket.contributions) {
    if (typeof item.render !== 'function' || item.id === 'theme-probe') continue
    const root = item.render()
    if (!root || root.type !== 'div' || !root.props || !root.props.style || root.props.style.display !== 'contents') continue
    const kids = [].concat(root.props.children || [])
    assert.ok(kids.some(kid => kid && kid.type === 'style'), `${item.id} renders without its stylesheet`)
    styled += 1
  }
  assert.ok(styled >= 2, `only ${styled} Aura surface(s) carry their stylesheet`)
  dispose()
  assert.equal(headAppends.length, before, `Aura appended ${headAppends.length - before} node(s) to the app <head>`)
})

await record('old saved settings with windowVisual:true boot and render nothing on document.body', async () => {
  const before = bodyAppends.length
  const bucket = makeCtx({
    enabled: true, windowVisual: true, backdropMode: 'aura', panelEnabled: true, frostLook: true, filmBehind: true
  })
  const dispose = plugin.default.register(bucket.ctx)
  await sleep(30)
  const panel = bucket.contributions.find(item => item.id === 'panel')
  const host = makeElement('div')
  const theatre = nodesOf(panel).find(node => node.props && node.props.ref)
  theatre.props.ref(host)
  assert.equal(plugin.nobackdropTest.settings.get().windowVisual, true, 'a saved windowVisual did not boot')
  assert.equal(bodyAppends.length, before, 'windowVisual:true appended a node to document.body')
  assert.equal(glassStyles.length, 0, 'windowVisual:true created #aura-glass')
  assert.equal(backdropAttrs.length, 0, 'windowVisual:true set data-aura-backdrop')
  dispose()
})

for (const line of results) console.log(line)
const summary = `${failed === 0 ? 'PASS' : 'FAIL'} no backdrop: ${results.length - failed}/${results.length}`
console.log(summary)
process.exit(failed === 0 ? 0 : 1)
