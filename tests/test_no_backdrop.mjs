/**
 * Nothing is painted on the host page unless the user picks "Behind chat".
 * These checks fail on a plugin that paints the host page by default (a saved
 * windowVisual, the visualiser, a panel film, an Off) and pass while the one
 * opt-in backdrop — and the glass that goes with it — exists only for that
 * place, and only while the film is actually behind the chat.
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
// Every glass stylesheet ever created (a record of churn), and the one that is
// actually mounted right now.
const glassStyles = []
const liveGlass = () => headChildren.some(node => node.attributes && node.attributes.id === 'aura-glass')

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
  '\nexport const nobackdropTest = { setBackdropMode, setFilmBehind, setPanelEnabled, setVideoWindow, setShowWhen, setOpacity, playAudioSource, closeVideo, setDesktopWindow, updateShow, applyVideoOpacity, poll, settings: $settings, surface: $filmSurface, live: $live, audioFrame: () => audioFrame }\n'
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
    setTimeout(fn, ms) {
      const record = { fn, ms, cleared: false }
      timers.push(record)
      return () => { record.cleared = true }
    },
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
      if (route === '/state') return { ...serverFrame, bands: [...serverFrame.bands] }
      if (route === '/version') return { version: '1.2.3' }
      if (route === '/control') return { ok: true }
      if (route === '/window') return { ok: true, available: true, open: false }
      if (route === '/window/open') return { ok: true, open: true }
      if (route === '/window/close') return { ok: true, closed: true }
      if (route === '/player') return { ok: true }
      return { ok: true }
    }
  }
  return { ctx, contributions, storage, timers, serverFrame }
}

function domFind(node, pred) {
  if (!node || typeof node !== 'object') return null
  if (pred(node)) return node
  for (const child of node.children || []) {
    const found = domFind(child, pred)
    if (found) return found
  }
  return null
}

function shown(node) {
  let current = node
  while (current) {
    if (current.style && current.style.display === 'none') return false
    current = current.parentNode
  }
  return true
}

function byAria(nodes, label) {
  return nodes.find(node => node.props && node.props['aria-label'] === label) || null
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

function filmInside(root, className, placement) {
  let found = null
  const visit = (node, inside) => {
    if (found || node == null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child, inside)
      return
    }
    if (!node.props) return
    const here = inside || String(node.props.className || '').split(/\s+/).includes(className)
    if (here && node.props.placement === placement && node.props.key === 'film' && typeof node.type === 'function') {
      found = node
      return
    }
    if (node.props.children) visit(node.props.children, here)
    if (!found && typeof node.type === 'function' && node.props.placement !== placement) {
      visit(node.type(node.props), here)
    }
  }
  visit(root, false)
  return found
}

await record('the panel film is absolute inside the stage, and Visualizer <-> Video still swaps src', async () => {
  const bucket = makeCtx({
    enabled: true, backdropMode: 'aura', panelEnabled: true, videoWindow: false, videoUrl: FILM
  })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    const panel = () => bucket.contributions.find(item => item.id === 'panel')
    const host = makeElement('div')
    const theatre = nodesOf(panel()).find(node => node.props && node.props.ref)
    theatre.props.ref(host)
    const visual = filmInside(panel().render(), 'ap-stage', 'panel')
    assert.ok(visual, 'the panel film is not a descendant of the panel stage')
    assert.equal(visual.props.key, 'film')
    let view = iframeOf(visual)
    assert.notEqual(view.props.style.position, 'fixed', 'the panel film is position:fixed over the window')
    assert.equal(view.props.style.position, 'absolute')
    assert.ok(Number(view.props.style.zIndex) <= 1, `panel film z-index ${view.props.style.zIndex} sits above the pane`)
    const node = adopt(view)
    // The stage is already in the host. React would commit the iframe inside
    // it; the plugin must not move the node to get there.
    const stage = domFind(host, item => item.className === 'ap-stage')
    if (stage && !node.parentNode) stage.appendChild(node)
    let parent = node.parentNode
    let inStage = false
    while (parent) {
      if (parent.className === 'ap-stage') inStage = true
      parent = parent.parentNode
    }
    assert.equal(inStage, true, 'the mounted panel film is not inside .ap-stage')
    assert.notEqual(node.style.position, 'fixed')
    assert.ok(node.style.zIndex == null || node.style.zIndex === '' || Number(node.style.zIndex) <= 1)
    const visualSrc = view.props.src
    await plugin.nobackdropTest.setBackdropMode('video')
    const video = filmInside(panel().render(), 'ap-stage', 'panel')
    assert.ok(video, 'Video mode took the film out of the panel stage')
    assert.equal(video.props.key, 'film', 'switching Visualizer <-> Video changed the film key')
    view = iframeOf(video)
    assert.match(view.props.src, /player\.html/, 'Video mode did not swap the film src')
    assert.notEqual(view.props.src, visualSrc)
    assert.notEqual(view.props.style.position, 'fixed')
    await plugin.nobackdropTest.setBackdropMode('aura')
    const back = filmInside(panel().render(), 'ap-stage', 'panel')
    assert.equal(back.props.key, 'film')
    assert.match(iframeOf(back).props.src, /overlay=1/, 'Visualizer mode did not swap the film src back')

    const page = bucket.contributions.find(item => item.id === 'aura-page')
    const pageTree = nodesOf(page)
    const stageRef = pageTree.find(item => item.props && item.props.className === 'aura-stage' && item.props.ref)
    assert.ok(stageRef, 'the Aura page has no stage')
    stageRef.props.ref(makeElement('div'))
    const onPage = filmInside(page.render(), 'aura-stage', 'page')
    assert.ok(onPage, 'the page film is not a descendant of the page stage')
    const pageView = iframeOf(onPage)
    assert.notEqual(pageView.props.style.position, 'fixed', 'the page film is position:fixed')
    assert.equal(pageView.props.style.position, 'absolute')

    stageRef.props.ref(null)
    await plugin.nobackdropTest.setVideoWindow(true)
    const watch = bucket.contributions.find(item => item.data && item.data.placement === 'floating' && item.removed !== true)
    assert.ok(watch, 'the watch window did not register')
    const inWindow = filmsIn(watch).find(item => item.props.placement === 'window')
    assert.ok(inWindow, 'the watch window has no film')
    const windowView = iframeOf(inWindow)
    assert.notEqual(windowView.props.style.position, 'fixed', 'the watch-window film is position:fixed over the viewport')
    assert.equal(windowView.props.style.position, 'absolute')
    assert.ok(Number(windowView.props.style.zIndex) <= 1, `watch film z-index ${windowView.props.style.zIndex} leaves the pane`)
  } finally {
    dispose()
  }
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

await record('old saved settings with windowVisual:true and Behind chat off boot and render nothing on document.body', async () => {
  const before = bodyAppends.length
  const bucket = makeCtx({
    enabled: true, windowVisual: true, backdropMode: 'aura', panelEnabled: true, frostLook: true, filmBehind: false
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

// "Behind chat" is the one opt-in: with it chosen for an open film, exactly one
// click-through iframe and the scoped glass appear; Panel takes both away.
await record('Behind chat is opt-in: one backdrop iframe and the scoped glass, and Panel removes them', async () => {
  const before = bodyAppends.length
  const bucket = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: true, filmBehind: true, videoUrl: FILM
  })
  const dispose = plugin.default.register(bucket.ctx)
  await sleep(40)
  assert.equal(bodyAppends.length, before + 1, 'Behind chat did not mount exactly one host node')
  const frame = bodyAppends[bodyAppends.length - 1]
  assert.equal(frame.tagName, 'IFRAME', 'the host node is not the film iframe')
  assert.match(String(frame.src), /\/player\.html/, 'the host node is not the player page')
  assert.equal(frame.style.position, 'fixed')
  assert.equal(frame.style.zIndex, '-1', 'the film is not behind the app')
  assert.equal(frame.style.pointerEvents, 'none', 'the backdrop takes clicks meant for the chat')
  assert.equal(liveGlass(), true, 'Behind chat did not mount the glass stylesheet')
  assert.equal(documentElement.getAttribute('data-aura-backdrop'), '', 'the glass is not scoped to the backdrop')
  assert.equal(plugin.nobackdropTest.surface.get().placement, '', 'the film is drawn inside Hermes as well')
  plugin.nobackdropTest.setVideoWindow(false)
  await plugin.nobackdropTest.poll()
  assert.equal(plugin.nobackdropTest.settings.get().filmBehind, true, 'precondition: the place is still Behind chat')
  // Panel is the way back.
  await plugin.nobackdropTest.setFilmBehind(false)
  assert.equal(bodyChildren.filter(node => node.tagName === 'IFRAME').length, 0,
    'the backdrop iframe survived the move back to the panel')
  assert.equal(liveGlass(), false, 'the glass survived the move back to the panel')
  assert.equal(documentElement.getAttribute('data-aura-backdrop'), undefined,
    'the scoping attribute survived the move back to the panel')
  dispose()
})

await record('Behind chat yields to the Aura page, and comes back when the page closes', async () => {
  const bucket = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: false, filmBehind: true, videoUrl: FILM
  })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(40)
    assert.equal(bodyChildren.filter(node => node.tagName === 'IFRAME').length, 1,
      'precondition: no backdrop with the panel closed')
    // The page is Aura's own surface: it wins over the film behind the chat.
    const page = bucket.contributions.find(item => item.id === 'aura-page')
    const stageRef = nodesOf(page).find(item => item.props && item.props.className === 'aura-stage' && item.props.ref)
    assert.ok(stageRef, 'the Aura page has no stage')
    stageRef.props.ref(makeElement('div'))
    await plugin.nobackdropTest.poll()
    assert.equal(bodyChildren.filter(node => node.tagName === 'IFRAME').length, 0,
      'the backdrop stayed up under the Aura page (two pictures)')
    assert.equal(plugin.nobackdropTest.surface.get().placement, 'page', 'the film did not move onto the page')
    assert.equal(plugin.nobackdropTest.settings.get().filmBehind, true, 'opening the page forgot the chosen place')
    // Leaving the page returns the film to where the user put it.
    stageRef.props.ref(null)
    await plugin.nobackdropTest.poll()
    assert.equal(bodyChildren.filter(node => node.tagName === 'IFRAME').length, 1,
      'the backdrop did not come back after the page closed')
  } finally {
    dispose()
  }
})

await record('a closed film behind the chat leaves the radio its carrier in the panel', async () => {
  const bucket = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: true, filmBehind: true, videoUrl: FILM
  })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(40)
    assert.equal(bodyChildren.filter(node => node.tagName === 'IFRAME').length, 1,
      'precondition: no backdrop to close')
    await plugin.nobackdropTest.playAudioSource('https://ice.example/behind.mp3', 'Behind')
    plugin.nobackdropTest.closeVideo()
    await plugin.nobackdropTest.poll()
    assert.equal(bodyChildren.filter(node => node.tagName === 'IFRAME').length, 0,
      'a closed film left the backdrop on the host page')
    assert.equal(liveGlass(), false, 'a closed film kept the glass')
    const panel = bucket.contributions.find(item => item.id === 'panel')
    const film = filmsIn(panel)
    assert.equal(film.length, 1, 'the radio lost its carrier when the film was closed')
    assert.match(iframeOf(film[0]).props.src, /overlay=1/, 'the carrier is not the visualiser page')
  } finally {
    dispose()
  }
})

await record('F1. the visualiser watch window is a 16:9 stage and Watch in sends it back', async () => {
  const bucket = makeCtx({
    enabled: true, backdropMode: 'aura', panelEnabled: true, videoWindow: true, videoUrl: ''
  })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(40)
    const pane = bucket.contributions.find(item => item.id === 'watch' && item.removed !== true)
    assert.ok(pane, 'Visualizer mode did not open the watch pane')
    const width = parseFloat(pane.data.width)
    const height = parseFloat(pane.data.height)
    assert.ok(width >= 480, `watch pane is a strip (${pane.data.width} wide), not a stage`)
    assert.equal(height - 30, Math.round(width * 9 / 16),
      `watch pane ${width}x${height} is not a 16:9 stage under the host header`)
    const frame = filmsIn(pane)
    assert.equal(frame.length, 1, 'the watch pane has no visualiser frame')
    assert.match(iframeOf(frame[0]).props.src, /overlay=1/)
    const panel = bucket.contributions.find(item => item.id === 'panel')
    const host = makeElement('div')
    const theatre = nodesOf(panel).find(node => node.props && node.props.ref)
    theatre.props.ref(host)
    const back = domFind(host, node => node.attributes && node.attributes['aria-label'] === 'Watch the film in the Right panel')
    assert.ok(back, 'the Right panel has no Watch in control in Visualizer mode')
    assert.equal(shown(back), true, 'Watch in is in the tree but hidden in Visualizer mode')
    const menu = nodesOf(bucket.contributions.find(item => item.id === 'quick-menu'))
    const menuBack = byAria(menu, 'Watch the film in the Right panel (quick menu)')
    assert.ok(menuBack, 'the quick menu has no Watch in control in Visualizer mode')
    const settings = nodesOf(bucket.contributions.find(item => item.area === 'settings.plugins'))
    assert.ok(byAria(settings, 'Watch the film in the Right panel (settings)'),
      'Settings has no Watch in control in Visualizer mode')
    const page = nodesOf(bucket.contributions.find(item => item.area === 'routes'))
    const pop = byAria(page, 'Bring back')
    assert.ok(pop, 'the Aura page still says Pop out while the visualiser is in the watch window')
    assert.equal(pop.props.children, 'Bring back')
    back.attributes && back.click && back.click()
    const click = (back.__handlers.click || [])[0]
    assert.equal(typeof click, 'function', 'the Panel pill has no click handler')
    click({ preventDefault() {} })
    await sleep(20)
    assert.equal(plugin.nobackdropTest.settings.get().videoWindow, false, 'Panel did not leave the watch window')
    assert.equal(plugin.nobackdropTest.surface.get().placement, 'panel', 'the visualiser did not return to the panel')
  } finally {
    dispose()
  }
})

await record('F2. radio stays up with no film, after close, and on the desktop — and nowhere with no surface', async () => {
  const bucket = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: true, videoUrl: '', videoClosed: false
  })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(40)
    const panel = () => bucket.contributions.find(item => item.id === 'panel')
    const played = await plugin.nobackdropTest.playAudioSource('https://ice.example/bare.mp3', 'Bare')
    assert.equal(played, true)
    await sleep(20)
    let film = filmsIn(panel())
    assert.equal(film.length, 1, 'Video mode with no film unmounted the audio carrier')
    let view = iframeOf(film[0])
    assert.match(view.props.src, /overlay=1/, 'the carrier is not the visualiser page (audio.js)')
    assert.doesNotMatch(view.props.src, /player\.html/)
    const carrier = adopt(view)
    view.props.onLoad()
    assert.ok(carrier.__sent.some(message => message.aura === 'audio' && message.cmd === 'play' &&
      message.url === 'https://ice.example/bare.mp3'), 'the carrier did not start the radio')

    // A film, then Close, must keep the carrier (Stop uses the same close).
    plugin.nobackdropTest.settings.set({ ...plugin.nobackdropTest.settings.get(), videoUrl: FILM, videoClosed: false })
    await plugin.nobackdropTest.poll()
    film = filmsIn(panel())
    assert.match(iframeOf(film[0]).props.src, /player\.html/, 'opening a film did not mount the player')
    const player = adopt(iframeOf(film[0]))
    iframeOf(film[0]).props.onLoad()
    plugin.nobackdropTest.closeVideo()
    film = filmsIn(panel())
    assert.equal(film.length, 1, 'closing the film dropped the radio carrier')
    view = iframeOf(film[0])
    assert.match(view.props.src, /overlay=1/)
    const afterClose = adopt(view)
    view.props.onLoad()
    assert.ok(afterClose.__sent.some(message => message.cmd === 'play'), 'close did not resume the radio')
    assert.ok(player.__sent.some(message => message.cmd === 'stop'), 'the closed film kept a second stream')

    plugin.nobackdropTest.settings.set({ ...plugin.nobackdropTest.settings.get(), videoUrl: FILM, videoClosed: false })
    await plugin.nobackdropTest.poll()
    film = filmsIn(panel())
    const desktopView = iframeOf(film[0])
    const beforeDesktop = adopt(desktopView)
    desktopView.props.onLoad()
    await plugin.nobackdropTest.setDesktopWindow(true)
    film = filmsIn(panel())
    assert.equal(film.length, 1, 'popping the film to the desktop dropped the radio')
    view = iframeOf(film[0])
    assert.match(view.props.src, /overlay=1/, 'the desktop hand-off left the player mounted in the panel')
    const parked = adopt(view)
    view.props.onLoad()
    assert.ok(parked.__sent.some(message => message.cmd === 'play'), 'the desktop hand-off did not resume radio')
    assert.ok(beforeDesktop.__sent.some(message => message.cmd === 'stop'), 'desktop pop-out left the in-app player streaming')
    assert.equal(filmsIn(panel()).length, 1, 'two in-app frames were mounted')

    plugin.nobackdropTest.setPanelEnabled(false)
    plugin.nobackdropTest.live.set({ ...plugin.nobackdropTest.live.get(), error: '' })
    await plugin.nobackdropTest.playAudioSource('https://ice.example/nowhere.mp3', 'Nowhere')
    await sleep(20)
    assert.equal(plugin.nobackdropTest.surface.get().placement, '', 'a frame mounted with no Aura surface')
    assert.match(plugin.nobackdropTest.live.get().error, /Music needs Aura.s panel or page open/)
    dispose()
    assert.equal(plugin.nobackdropTest.audioFrame(), null, 'dispose left the previous radio frame registered')
  } finally {
    dispose()
  }
})

await record('F3. Visualizer mode does not stretch an empty panel or show film hints', async () => {
  const bucket = makeCtx({
    enabled: true, backdropMode: 'aura', panelEnabled: true, videoUrl: FILM, videoClosed: true
  })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    const panel = bucket.contributions.find(item => item.id === 'panel')
    const tree = nodesOf(panel)
    const theatre = tree.find(node => node.props && node.props.ref && node.props.style && node.props.style.flex)
    assert.equal(theatre.props.style.flex, '0 0 auto', 'the visualiser theatre still grows to fill the window')
    const host = makeElement('div')
    theatre.props.ref(host)
    const root = domFind(host, node => node.attributes && node.attributes.id === 'aura-panel')
    assert.equal(root.style.height, 'auto', 'the visualiser panel is stretched to the full pane')
    const hint = domFind(host, node => node.className === 'ap-hint')
    assert.ok(hint, 'the stage hint is missing')
    assert.equal(hint.textContent, '', `Visualizer mode shows a film hint: ${hint.textContent}`)
    const page = nodesOf(bucket.contributions.find(item => item.area === 'routes'))
    const off = page.find(node => node.props && typeof node.props.children === 'string' && /Aura is off/.test(node.props.children))
    assert.equal(off, undefined, 'Aura is on, so the page must not say it is off')
    plugin.nobackdropTest.settings.set({ ...plugin.nobackdropTest.settings.get(), enabled: false })
    plugin.nobackdropTest.live.set({ ...plugin.nobackdropTest.live.get(), ok: true, enabled: false })
    const pageOff = nodesOf(bucket.contributions.find(item => item.area === 'routes'))
    const offHint = pageOff.find(node => node.props && typeof node.props.children === 'string' && /Aura is off/.test(node.props.children))
    assert.ok(offHint, 'Visualizer mode hides the Aura-is-off hint')
  } finally {
    dispose()
  }
})

await record('F4. a hidden panel with no film surface does not float a dead control strip', async () => {
  const bucket = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: false, videoWindow: false,
    videoUrl: FILM, videoClosed: false
  })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(40)
    const floating = bucket.contributions.filter(item => item.removed !== true &&
      (item.id === 'strip' || item.id === 'watch'))
    assert.equal(floating.length, 0, `a control strip mounted with nothing to control (${floating.map(item => item.id).join(',')})`)
    const route = bucket.contributions.find(item => item.area === 'routes')
    const page = nodesOf(route)
    const stage = page.find(node => node.props && typeof node.props.ref === 'function' && node.props.className === 'aura-stage')
    assert.ok(stage, 'the page has no stage')
    stage.props.ref({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 450 }) })
    await plugin.nobackdropTest.poll()
    const overPage = bucket.contributions.filter(item => item.removed !== true && item.id === 'strip')
    assert.equal(overPage.length, 0, 'the control strip floats over the Aura page')
  } finally {
    dispose()
  }
})

await record('F5. Only while active fades the in-pane visualiser, and Visual opacity still reaches it', async () => {
  const bucket = makeCtx({
    enabled: true, backdropMode: 'aura', panelEnabled: true, showWhen: 'active', opacity: 0.4
  })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(40)
    const panel = bucket.contributions.find(item => item.id === 'panel')
    const film = filmsIn(panel)
    assert.equal(film.length, 1, 'the visualiser is not in the panel')
    const view = iframeOf(film[0])
    const frame = adopt(view)
    plugin.nobackdropTest.updateShow()
    plugin.nobackdropTest.applyVideoOpacity()
    assert.equal(frame.style.opacity, '0', 'an idle visualiser stayed fully visible under Only while active')
    bucket.serverFrame.mood = 'thinking'
    bucket.serverFrame.silence = false
    bucket.serverFrame.level = 0.8
    await plugin.nobackdropTest.poll()
    const delay = bucket.timers.find(timer => timer.ms === 300 && timer.cleared !== true)
    assert.ok(delay, 'activity did not schedule the show delay')
    delay.fn()
    const step = bucket.timers.filter(timer => timer.ms === 250 && timer.cleared !== true).pop()
    assert.ok(step, 'the visualiser did not start fading back in')
    step.fn()
    assert.ok(Number(frame.style.opacity) > 0, 'the active visualiser stayed faded out')
    const menu = nodesOf(bucket.contributions.find(item => item.id === 'quick-menu'))
    const strength = byAria(menu, 'Visual strength')
    assert.ok(strength, 'Visual strength was removed')
    strength.props.onChange({ target: { value: '25' } })
    await sleep(20)
    assert.equal(plugin.nobackdropTest.settings.get().opacity, 0.25, 'Visual strength did not change opacity')
    const page = fs.readFileSync(path.join(ROOT, 'web', 'aura.js'), 'utf8')
    assert.match(page, /setOpacityUI\(clamp\(cfg\.opacity, 0, 1\)\)/,
      'the visualiser page no longer applies Visual opacity')
  } finally {
    dispose()
  }
})

function htmlCollection(items) {
  const list = {
    length: items.length,
    item(index) {
      const i = index >>> 0
      return i < items.length ? items[i] : null
    }
  }
  items.forEach((node, i) => { list[i] = node })
  return list
}

function walkDom(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  const kids = node.children
  if (!kids || typeof kids.length !== 'number') return
  for (let i = 0; i < kids.length; i += 1) walkDom(kids[i], visit)
}

await record('an HTMLCollection of host children still finds the React stage, and no second panel is created', async () => {
  const bucket = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: true, videoWindow: false, videoUrl: FILM
  })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    const head = makeElement('div')
    head.className = 'ap-head'
    head.setAttribute('data-aura-slot', 'head')
    const stage = makeElement('div')
    stage.className = 'ap-stage'
    const hint = makeElement('div')
    hint.className = 'ap-hint'
    stage.appendChild(hint)
    const watch = makeElement('div')
    watch.setAttribute('data-aura-slot', 'watch')
    const body = makeElement('div')
    body.className = 'ap-body'
    body.setAttribute('data-aura-slot', 'body')
    const items = []
    const host = makeElement('div')
    host.setAttribute('id', 'aura-panel')
    const publish = () => { host.children = htmlCollection(items) }
    host.appendChild = child => {
      child.parentNode = host
      items.push(child)
      publish()
      return child
    }
    host.removeChild = child => {
      const index = items.indexOf(child)
      if (index >= 0) items.splice(index, 1)
      if (child.parentNode === host) child.parentNode = null
      publish()
      return child
    }
    for (const child of [head, stage, watch, body]) host.appendChild(child)
    assert.equal(Array.isArray(host.children), false, 'the fixture children are a real Array')
    assert.equal(typeof host.children.item, 'function')
    assert.equal(host.children.length, 4)
    assert.equal(host.children.item(1), stage)
    assert.equal(host.children[1], stage)
    const panel = bucket.contributions.find(item => item.id === 'panel')
    const theatre = nodesOf(panel).find(node => node.props && node.props.ref && node.props.id === 'aura-panel')
    assert.equal(typeof (theatre && theatre.props.ref), 'function', 'the panel has no host ref')
    theatre.props.ref(host)
    const modes = []
    const stages = []
    walkDom(host, node => {
      if (node.getAttribute && node.getAttribute('data-mode')) modes.push(node.getAttribute('data-mode'))
      if (node.className === 'ap-stage') stages.push(node)
    })
    assert.deepEqual(modes, ['aura', 'video'], 'the React head slot was not filled')
    assert.equal(stages.length, 1, 'a second panel stage was created')
    assert.equal(stages[0], stage, 'the React stage was replaced')
    assert.equal(items.length, 4, 'a second panel was appended to the host')
    assert.equal(items.some(node => node.__auraImperative), false, 'the fallback panel was built')
  } finally {
    dispose()
  }
})

await record('a React-created film iframe is never passed to appendChild or removeChild across re-render, mode switch and unmount', async () => {
  const bucket = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: true, videoWindow: false, videoUrl: FILM
  })
  const dispose = plugin.default.register(bucket.ctx)
  const origCreate = document.createElement
  const restore = []
  const ops = []
  let arm = false
  let film = null
  const instrument = node => {
    if (!node || node.__filmSpy || typeof node.appendChild !== 'function') return node
    node.__filmSpy = true
    const append = node.appendChild
    const remove = node.removeChild
    restore.push(() => {
      node.appendChild = append
      if (typeof remove === 'function') node.removeChild = remove
      delete node.__filmSpy
    })
    node.appendChild = function(child) {
      if (arm && child === film) ops.push('appendChild')
      return append.call(this, child)
    }
    if (typeof remove === 'function') {
      node.removeChild = function(child) {
        if (arm && child === film) ops.push('removeChild')
        return remove.call(this, child)
      }
    }
    return node
  }
  document.createElement = function(tagName) {
    return instrument(origCreate.call(document, tagName))
  }
  try {
    await sleep(30)
    assert.equal(plugin.nobackdropTest.surface.get().placement, 'panel', 'precondition: the film is not in the panel')
    const panel = () => bucket.contributions.find(item => item.id === 'panel')
    const theatre = nodesOf(panel()).find(node => node.props && node.props.ref)
    assert.equal(typeof (theatre && theatre.props.ref), 'function', 'the panel has no host ref')
    const view = iframeOf(filmInside(panel().render(), 'ap-stage', 'panel'))
    assert.equal(view.props.style.position, 'absolute')
    assert.notEqual(view.props.style.position, 'fixed')
    // React created this iframe and parented it. The stage Aura mounts comes
    // after this ref; Aura must not move the node to catch up.
    film = makeElement('iframe')
    const reactParent = makeElement('div')
    instrument(film)
    instrument(reactParent)
    instrument(document.body)
    instrument(document.head)
    reactParent.appendChild(film)
    const host = makeElement('div')
    arm = true
    view.props.ref(film)
    theatre.props.ref(host)
    const again = () => {
      const next = filmInside(panel().render(), 'ap-stage', 'panel')
      assert.ok(next, 'the panel film left the stage in the React tree')
      const rendered = iframeOf(next)
      assert.equal(rendered.props.style.position, 'absolute')
      assert.notEqual(rendered.props.style.position, 'fixed')
      return rendered
    }
    again()
    await plugin.nobackdropTest.setBackdropMode('aura')
    again()
    await plugin.nobackdropTest.setBackdropMode('video')
    again()
    await plugin.nobackdropTest.poll()
    view.props.ref(null)
    theatre.props.ref(null)
    arm = false
    assert.deepEqual(ops, [], `Aura passed the React film iframe to ${ops.join(', ')}`)
    assert.equal(film.parentNode, reactParent, 'the React film was reparented')
  } finally {
    arm = false
    document.createElement = origCreate
    for (const undo of restore) undo()
    dispose()
  }
})

await record('F7. the docs describe the film behind the chat as opt-in, never a visual behind the work', async () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const manifest = fs.readFileSync(path.join(ROOT, 'plugin.yaml'), 'utf8')
  const source = fs.readFileSync(PLUGIN, 'utf8')
  for (const text of [readme, manifest]) {
    assert.doesNotMatch(text, /behind your work/)
    assert.doesNotMatch(text, /behind the interface/)
  }
  assert.doesNotMatch(readme, /Backdrop opacity that follows the room/)
  // The one host-page surface is documented, and as a choice the user makes.
  assert.match(readme, /Behind chat/)
  assert.match(readme, /#155903/)
  // In the code it exists only behind the opt-in gate.
  assert.match(source, /function behindChatWanted/)
  assert.match(source, /#155903/)
})

for (const line of results) console.log(line)
const summary = `${failed === 0 ? 'PASS' : 'FAIL'} no backdrop: ${results.length - failed}/${results.length}`
console.log(summary)
process.exit(failed === 0 ? 0 : 1)
