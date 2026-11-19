/**
 * "Behind chat" as a coming-soon signpost, with no behaviour.
 *
 * The owner asked to see the next place the film could go without it existing
 * yet. This file proves the whole of that promise:
 *
 *   1. the Right panel's Watch in row offers four pills, in reading order:
 *      Panel, Window, Desktop, Behind chat,
 *   2. the Behind chat pill is disabled (attribute + aria-disabled), greyed by
 *      Aura's own .ap-pill-soon rule, titled "Coming soon" and labelled
 *      "Behind chat (coming soon)",
 *   3. it is never marked active, has no click handler, and clicking it moves
 *      the film nowhere and writes no settings (it is not in FILM_PLACES, so
 *      currentFilmPlace()/moveFilmTo() cannot see it),
 *   4. the watch window's "Send to" row carries the same disabled pill, last, after
 *      Right panel and Desktop, also inert,
 *   5. nothing about it touches the host page: plugin.js contains no
 *      'data-aura-backdrop' and no 'data-hermes-glass-on', and no filmBehind
 *      setting was added.
 *
 * The harness is the same fake host tests/test_desktop_plugin.mjs and
 * tests/test_fresh_install.mjs use: a temp copy of the plugin has its three
 * import specifiers rewritten to local stub modules, a fake DOM stands in for
 * document/getComputedStyle, makeCtx provides the host ctx, and the docked
 * panel is mounted through its real ref exactly as the host lays it out.
 *
 * Run: node tests/test_behind_chat_soon.mjs
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

function record(name, fn) {
  try {
    fn()
    results.push(`PASS ${name}`)
  } catch (error) {
    failed += 1
    results.push(`FAIL ${name}: ${error && error.message ? error.message : error}`)
  }
}

async function recordAsync(name, fn) {
  try {
    await fn()
    results.push(`PASS ${name}`)
  } catch (error) {
    failed += 1
    results.push(`FAIL ${name}: ${error && error.message ? error.message : error}`)
  }
}

// ------------------------------------------------------------------ helpers

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if ('type' in node && 'props' in node) {
    visit(node)
    walk(node.props && node.props.children, visit)
  }
}

// Host nodes of mounted floating panes (the strip / watch window card body).
const floatingHosts = []
const floatingRecords = new Set()
const rerenderFloating = () => { for (const record of floatingRecords) record.rerender() }
function mountFloatingPane(record) {
  if (!record || !record.data || record.data.placement !== 'floating' || typeof record.render !== 'function') return null
  const refs = []
  let slot = 0
  const walkNode = element => {
    if (!element || typeof element !== 'object') return
    if (Array.isArray(element)) { element.forEach(walkNode); return }
    if (typeof element.type === 'function') { walkNode(element.type(element.props || {})); return }
    if (isFilmIframe(element)) { sdk.SandboxedFrame(element.props); return }
    const props = element.props || {}
    if (typeof props.ref === 'function' && typeof element.type === 'string') {
      const existing = refs[slot]
      slot += 1
      if (existing) { existing.ref = props.ref; props.ref(existing.host); walkNode(props.children); return }
      const host = globalThis.document.createElement(element.type)
      floatingHosts.push(host)
      refs.push({ ref: props.ref, host })
      props.ref(host)
    }
    walkNode(props.children)
  }
  walkNode(record.render())
  record.rerender = () => { slot = 0; walkNode(record.render()) }
  floatingRecords.add(record)
  return () => {
    floatingRecords.delete(record)
    for (const { ref, host } of refs) {
      ref(null)
      const index = floatingHosts.indexOf(host)
      if (index >= 0) floatingHosts.splice(index, 1)
    }
  }
}
const floatingNodes = () => floatingHosts.flatMap(host => host.children)

const isFilmIframe = el => !!el && el.type === 'iframe' && !!el.props && el.props.title === 'Aura film'

// Aura's surfaces render inside a display:contents wrapper that carries their
// stylesheet; render the surface itself.
function unwrapStyled(element) {
  if (!element || element.type !== 'div' || !element.props || !element.props.style ||
    element.props.style.display !== 'contents') return element
  const kids = [].concat(element.props.children || [])
  return kids.find(kid => kid && typeof kid.type === 'function') || element
}

function renderContribution(contribution) {
  const element = unwrapStyled(contribution.render())
  assert.ok(element && typeof element === 'object', `contribution ${contribution.id} did not render an element`)
  return typeof element.type === 'function' ? element.type(element.props) : element
}

// Walk a plugin-created DOM tree (fake document elements, not descriptors).
function domWalk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const child of node.children || []) domWalk(child, visit)
}
function domFind(root, predicate) {
  let found = null
  domWalk(root, node => {
    if (!found && predicate(node)) found = node
  })
  return found
}
function domFindAll(root, predicate) {
  const out = []
  domWalk(root, node => {
    if (predicate(node)) out.push(node)
  })
  return out
}
const domByAria = (root, label) => domFind(root, node => node.attributes && node.attributes['aria-label'] === label)
const clickHandlers = node => (node.__handlers && node.__handlers.click) || []

/** A host ctx. Only what these scenarios touch. */
function makeCtx(settings) {
  const contributions = []
  const timers = []
  const controls = []
  const requests = []
  const storage = new Map()
  if (settings) storage.set('settings', settings)
  let serverEnabled = settings && typeof settings.enabled === 'boolean' ? settings.enabled : true
  const serverSettings = { motion: 'agent_music', behavior: 'balanced', intensity: 0.5, opacity: 0.35, reduced_motion: false }
  const serverFrame = {
    level: 0.55, bands: [0, 0, 0, 0, 0, 0, 0, 0], onset: false, centroid: 0.4,
    flatness: 0.2, silence: false, mood: 'thinking'
  }

  const ctx = {
    source: 'plugin:aura',
    register(contribution) {
      const entry = { ...contribution, removed: false }
      contributions.push(entry)
      const unmount = mountFloatingPane(entry)
      return () => {
        if (entry.removed) return
        entry.removed = true
        if (unmount) unmount()
        const index = contributions.indexOf(entry)
        if (index >= 0) contributions.splice(index, 1)
      }
    },
    registerSettingsPage(page) {
      return ctx.register({
        id: page.id, area: 'settings.plugins', title: page.title,
        data: { children: page.children || [], icon: page.icon }, render: page.render
      })
    },
    onDispose() {},
    setInterval(fn, ms) {
      const entry = { fn, ms, kind: 'interval', cleared: false }
      timers.push(entry)
      return () => { entry.cleared = true }
    },
    setTimeout(fn, ms) {
      const entry = { fn, ms, kind: 'timeout', cleared: false }
      timers.push(entry)
      return () => { entry.cleared = true }
    },
    addEventListener() { return () => {} },
    storage: {
      get(key, fallback) { return storage.has(key) ? storage.get(key) : fallback },
      set(key, value) { storage.set(key, value) },
      remove(key) { storage.delete(key) }
    },
    async rest(route, options = {}) {
      requests.push({ route, options })
      if (route === '/status') {
        return { ok: true, port: 4321, url: 'http://127.0.0.1:4321/?token=not-shown-in-ui', capture: 'pipewire', enabled: serverEnabled }
      }
      if (route === '/state') {
        return {
          ...serverFrame, bands: [...serverFrame.bands],
          intensity: serverSettings.intensity, opacity: serverSettings.opacity,
          behavior: serverSettings.behavior, motion: serverSettings.motion,
          reduced_motion: serverSettings.reduced_motion, enabled: serverEnabled
        }
      }
      if (route === '/control') {
        controls.push(options.body)
        if (options.body && typeof options.body.enabled === 'boolean') serverEnabled = options.body.enabled
        return { ok: true }
      }
      if (route === '/window') return { ok: true, available: true, open: false }
      if (route === '/window/open') return { ok: true, open: true, url: options.body ? options.body.url : '' }
      if (route === '/window/close') return { ok: true, window: { open: false }, closed: true }
      if (route === '/version') {
        return { version: '1.2.3', commit: 'abcdef1234567890', commit_short: 'abcdef12', commit_date: '2026-11-09', channel: 'dev', dirty: false }
      }
      throw new Error(`unexpected route ${route}`)
    }
  }

  return { ctx, contributions, timers, controls, requests, storage }
}

// --------------------------------------------------------------- temp module

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aura-behind-soon-'))
const pluginCopy = path.join(tmp, 'plugin.mjs')
const sdkStub = path.join(tmp, 'sdk-stub.mjs')
const reactStub = path.join(tmp, 'react-stub.mjs')
const jsxStub = path.join(tmp, 'jsx-runtime-stub.mjs')

const source = fs.readFileSync(PLUGIN, 'utf8')
const rewritten = source
  .replace(/from\s+'@hermes\/plugin-sdk'/g, "from './sdk-stub.mjs'")
  .replace(/from\s+'react'/g, "from './react-stub.mjs'")
  .replace(/from\s+'react\/jsx-runtime'/g, "from './jsx-runtime-stub.mjs'")

fs.writeFileSync(pluginCopy, rewritten + '\nexport const wiringTest = { video: $video, frame: () => filmFrame, surface: () => $filmSurface.get(), lastPollAt: () => (typeof lastPollAt === "number" ? lastPollAt : 0) };\n')

fs.writeFileSync(
  sdkStub,
  `// Stub of @hermes/plugin-sdk: records what the plugin asks the host to do.
export const calls = { accent: [], themes: [], navigations: [], notifications: [], undismissed: [], revealed: [] }

function makeAtom(initial) {
  let value = initial
  return { get: () => value, set: next => { value = next }, listen: () => () => {} }
}

export const atom = makeAtom
export const $accentOverride = makeAtom(null)

export const setAccentOverride = color => {
  calls.accent.push(color)
  $accentOverride.set(color)
}

export const requestTheme = name => {
  calls.themes.push(name)
  return true
}

export const host = {
  state: { focusedStoredSessionId: { get: () => 'chat/123' } },
  navigate: route => { calls.navigations.push(route) },
  notify: message => { calls.notifications.push(message) },
  undismissPane: paneId => { calls.undismissed.push(paneId) },
  revealPane: paneId => { calls.revealed.push(paneId) }
}

export const useValue = store => store.get()

export const themeState = { name: 'nous', accent: '#8b7cff' }

export const useTheme = () => ({
  themeName: themeState.name,
  theme: { name: themeState.name, colors: { accent: themeState.accent, primary: themeState.accent, ring: themeState.accent } },
  setTheme: () => {},
  mode: 'dark',
  resolvedMode: 'dark',
  renderedMode: 'dark',
  availableThemes: [],
  setMode: () => {},
  previewTheme: () => {},
  clearThemePreview: () => {}
})

export const Button = () => null
export const Switch = () => null
export const StatusDot = () => null

export const SandboxedFrame = props => {
  const posted = []
  const node = {
    tagName: 'IFRAME',
    src: props.src,
    style: { ...(props.style || {}) },
    attributes: {},
    dataset: {},
    contentWindow: { posted, postMessage: (message, origin) => posted.push({ message, origin }) },
    getBoundingClientRect: () => ({ width: 320, height: 180, left: 0, top: 0, right: 320, bottom: 180 })
  }
  if (typeof props.ref === 'function') props.ref(node)
  else if (props.ref && typeof props.ref === 'object') props.ref.current = node
  return node
}

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
`
)

fs.writeFileSync(
  reactStub,
  `// Stub of react: hooks are synchronous no-ops so a component can be called
// outside a renderer.
export const Fragment = Symbol.for('react.fragment')
export function useState(initial) {
  const value = typeof initial === 'function' ? initial() : initial
  return [value, () => {}]
}
export function useEffect(fn) { fn() }
export function useLayoutEffect(fn) { fn() }
export function useRef(value) { return { current: value } }
export function useMemo(fn) { return fn() }
export function useCallback(fn) { return fn }
`
)

fs.writeFileSync(
  jsxStub,
  `// Stub of react/jsx-runtime: plain element descriptors.
export function jsx(type, props, key) { return { type, props, key } }
export const jsxs = jsx
export const Fragment = Symbol.for('react.fragment')
`
)

// Fake DOM: enough for the panel DOM, the floating strip and the stylesheet.
const bodyChildren = []
const headChildren = []
const documentElement = {
  style: {},
  attributes: {},
  setAttribute(name, value) { this.attributes[name] = String(value) },
  getAttribute(name) { return this.attributes[name] },
  removeAttribute(name) { delete this.attributes[name] },
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) }
}
function makeChildList(children) {
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
    }
  }
}
globalThis.document = {
  hidden: false,
  visibilityState: 'visible',
  documentElement,
  head: makeChildList(headChildren),
  body: makeChildList(bodyChildren),
  createElement(tagName) {
    return {
      tagName: String(tagName).toUpperCase(),
      style: {},
      attributes: {},
      children: [],
      parentNode: null,
      src: '',
      textContent: '',
      dataset: {},
      setAttribute(name, value) { this.attributes[name] = String(value) },
      getAttribute(name) { return this.attributes[name] },
      appendChild(child) {
        child.parentNode = this
        this.children.push(child)
        return child
      },
      removeChild(child) {
        const index = this.children.indexOf(child)
        if (index >= 0) this.children.splice(index, 1)
        child.parentNode = null
        return child
      },
      __handlers: {},
      addEventListener(type, fn) {
        const list = this.__handlers[type] || (this.__handlers[type] = [])
        list.push(fn)
      },
      removeEventListener(type, fn) {
        const list = this.__handlers[type]
        if (list) this.__handlers[type] = list.filter(entry => entry !== fn)
      },
      getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 } },
      get firstChild() { return this.children[0] || null },
      removeAttribute(name) { delete this.attributes[name] },
      remove() { if (this.parentNode) this.parentNode.removeChild(this) }
    }
  },
  addEventListener() {},
  removeEventListener() {}
}
globalThis.getComputedStyle = () => ({
  backgroundColor: 'rgba(0, 0, 0, 0)',
  getPropertyValue: () => ''
})

const pluginModule = await import(pathToFileURL(pluginCopy).href)
const sdk = await import(pathToFileURL(sdkStub).href)

const SINTEL_URL = 'https://www.youtube.com/watch?v=eRsGyueVLvQ'

// SDK components stay as descriptors (the stubs render() to null); Aura's own
// function components are rendered so their DOM-building effects run.
const SDK_COMPONENTS = new Set([
  sdk.Button, sdk.Switch, sdk.StatusDot, sdk.Popover, sdk.PopoverTrigger, sdk.PopoverContent
])
const renderDeep = node => {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(renderDeep)
  if (typeof node !== 'object' || !('type' in node) || !('props' in node)) return node
  if (isFilmIframe(node)) return sdk.SandboxedFrame(node.props)
  if (typeof node.type === 'function' && !SDK_COMPONENTS.has(node.type)) {
    return renderDeep(node.type(node.props))
  }
  return { ...node, props: { ...node.props, children: renderDeep(node.props.children) } }
}

/** Mount the docked pane's real DOM: render the pane contribution, take the
 *  theatre ref and hand it a fake host node, exactly like the host layout. */
function mountPane(bucket) {
  const pane = bucket.contributions.find(c => c.area === 'panes')
  assert.ok(pane, 'no panes contribution to mount')
  const tree = renderContribution(pane)
  let ref = null
  walk(tree, node => {
    if (!ref && node.props && typeof node.props.ref === 'function') ref = node.props.ref
  })
  assert.ok(typeof ref === 'function', 'the pane offers no mount ref')
  const hostNode = globalThis.document.createElement('div')
  ref(hostNode)
  renderDeep(tree)
  const surface = pluginModule.wiringTest.surface()
  const frame = pluginModule.wiringTest.frame()
  if (surface && surface.placement === 'panel' && frame && !frame.parentNode) {
    const stage = domFind(hostNode, node => node.className === 'ap-stage')
    if (stage) stage.appendChild(frame)
  }
  return hostNode
}

async function fireTick(bucket) {
  const tick = bucket.timers.find(t => t.kind === 'interval' && !t.cleared)
  assert.ok(tick, 'no polling interval registered')
  const since = Date.now() - pluginModule.wiringTest.lastPollAt()
  if (since < 250) await sleep(250 - since)
  tick.fn()
}

async function tickPoll(bucket) {
  await fireTick(bucket)
  await sleep(40)
  rerenderFloating()
}

const videoBar = () => [...bodyChildren, ...floatingNodes()].find(node => node.attributes && node.attributes.role === 'toolbar')

// -------------------------------------------------------------- static rules

record('plugin.js carries no backdrop hook for Behind chat', () => {
  assert.ok(!source.includes('data-aura-backdrop'), 'plugin.js mentions data-aura-backdrop')
  assert.ok(!source.includes('data-hermes-glass-on'), 'plugin.js mentions data-hermes-glass-on')
})
record('Behind chat is not a real place: FILM_PLACES still holds only the three', () => {
  const places = /const FILM_PLACES = \[([\s\S]*?)\n\]/.exec(source)
  assert.ok(places, 'FILM_PLACES is gone')
  assert.equal((places[1].match(/\['/g) || []).length, 3, 'FILM_PLACES grew a fourth place')
  assert.ok(!/behind/i.test(places[1]), 'Behind chat was added to FILM_PLACES')
})

// ===================================================================
// The Right panel's Watch in row: four pills, the new one inert.
// ===================================================================

{
  const bucket = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: true, videoWindow: false,
    videoUrl: SINTEL_URL, panelCollapsed: false
  })
  const dispose = pluginModule.default.register(bucket.ctx)
  await tickPoll(bucket)
  const pane = mountPane(bucket)
  await tickPoll(bucket)

  const pillsRow = domFind(pane, node => node.className === 'ap-pills')
  assert.ok(pillsRow, 'the panel has no Watch in pills row')
  const pills = pillsRow.children.slice()
  const soon = domByAria(pane, 'Behind chat (coming soon)')

  record('1. Watch in offers four pills: Panel, Window, Desktop, Behind chat', () => {
    assert.equal(pills.length, 4, `Watch in has ${pills.length} pills: ${pills.map(pill => pill.textContent).join(', ')}`)
    assert.deepEqual(pills.map(pill => pill.textContent), ['Panel', 'Window', 'Desktop', 'Behind chat'],
      'the Behind chat pill is not last')
  })

  record('2. the Behind chat pill is disabled, greyed by Aura\'s own rule, and labelled as coming soon', () => {
    assert.ok(soon, 'no Behind chat pill')
    assert.equal(soon.attributes['aria-label'], 'Behind chat (coming soon)')
    assert.equal(soon.title, 'Coming soon', `tooltip is "${soon.title}"`)
    assert.equal(soon.disabled, true, 'the pill is not disabled')
    assert.equal(Object.prototype.hasOwnProperty.call(soon.attributes, 'disabled'), true,
      'the disabled attribute is missing')
    assert.equal(soon.attributes['aria-disabled'], 'true', 'aria-disabled is not set')
    assert.match(String(soon.className), /\bap-pill-soon\b/, 'the pill does not carry the greyed class')
    const style = domFind(pane, node => node.tagName === 'STYLE' && node.attributes && node.attributes.id === 'aura-panel-style')
    assert.ok(style, 'the panel stylesheet is missing')
    const css = String(style.textContent || '')
    const rule = /\.ap-pill-soon\s*\{([^}]*)\}/.exec(css)
    assert.ok(rule, 'no .ap-pill-soon rule in Aura\'s stylesheet')
    assert.match(rule[1], /opacity:\s*0\.45/, 'the pill is not greyed in the stylesheet')
    assert.match(rule[1], /cursor:\s*not-allowed/, 'the pill does not show the not-allowed cursor')
  })

  record('3. the Behind chat pill is never marked active', () => {
    assert.notEqual(soon.attributes['data-active'], 'true', 'Behind chat is marked as the current place')
    assert.equal(domByAria(pane, 'Watch the film in the Right panel').attributes['data-active'], 'true',
      'the film is not marked in the Right panel')
  })

  await recordAsync('4. clicking it moves nothing and writes no settings', async () => {
    assert.equal(clickHandlers(soon).length, 0, 'the disabled pill has a click handler')
    const settingsBefore = JSON.stringify(bucket.storage.get('settings'))
    const controlsBefore = bucket.controls.length
    const storageBefore = new Map(bucket.storage)
    // Even if something did dispatch a click, the disabled pill must stay put.
    for (const handler of clickHandlers(soon)) handler({ preventDefault() {} })
    await sleep(60)
    await tickPoll(bucket)
    assert.equal(JSON.stringify(bucket.storage.get('settings')), settingsBefore, 'the film\'s settings changed')
    assert.equal(bucket.controls.length, controlsBefore, 'clicking Behind chat sent a /control command')
    assert.deepEqual([...bucket.storage.entries()], [...storageBefore.entries()], 'storage was written')
    assert.equal(bucket.storage.get('settings').filmBehind, false, 'Behind chat wrote filmBehind')
    assert.equal(bucket.storage.get('settings').videoWindow, false, 'the film moved to the watch window')
    assert.equal(domByAria(pane, 'Watch the film in the Right panel').attributes['data-active'], 'true',
      'the film left the Right panel')
    assert.equal(domByAria(pane, 'Watch the film in the watch window').attributes['data-active'], 'false',
      'the watch window is marked as the current place')
  })

  dispose()
}

// ===================================================================
// The watch window's "Send to" row: the same disabled pill, after the two
// real places, and equally inert.
// ===================================================================

{
  const bucket = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: true, videoWindow: true,
    videoUrl: SINTEL_URL
  })
  const dispose = pluginModule.default.register(bucket.ctx)
  await tickPoll(bucket)
  const pane = mountPane(bucket)
  // The strip and the watch window are drawn by the status-bar contribution.
  renderDeep(renderContribution(bucket.contributions.find(c => c.id === 'quick-menu')))
  await tickPoll(bucket)

  const bar = videoBar()
  assert.ok(bar, 'the watch window has no strip')
  const right = domByAria(bar, 'Send the film to the Right panel')
  assert.ok(right, 'the strip has no Right panel send')
  const sendRow = right.parentNode
  const sendChildren = sendRow.children.slice()
  const soon = domByAria(bar, 'Behind chat (coming soon)')

  record('5. the Send to row ends with the disabled Behind chat pill', () => {
    assert.ok(soon, 'the strip has no Behind chat pill')
    assert.equal(soon.title, 'Coming soon')
    assert.equal(soon.disabled, true, 'the strip pill is not disabled')
    assert.equal(soon.attributes['aria-disabled'], 'true')
    assert.equal(soon.attributes['disabled'], '')
    assert.match(String(soon.className), /\bap-pill-soon\b/, 'the strip pill does not carry the greyed class')
    const labels = sendChildren.map(node => (node.attributes && node.attributes['aria-label']) || node.textContent)
    assert.deepEqual(labels, [
      'Send to',
      'Send the film to the Right panel',
      'Pop the film out to the desktop',
      'Behind chat (coming soon)'
    ], 'the strip order is not Right panel, Desktop, Behind chat')
    assert.notEqual(soon.attributes['data-active'], 'true', 'the strip pill is marked active')
  })

  await recordAsync('6. clicking the strip pill sends the film nowhere and writes no settings', async () => {
    assert.equal(clickHandlers(soon).length, 0, 'the strip pill has a click handler')
    const settingsBefore = JSON.stringify(bucket.storage.get('settings'))
    const controlsBefore = bucket.controls.length
    for (const handler of clickHandlers(soon)) handler({ preventDefault() {} })
    await sleep(60)
    await tickPoll(bucket)
    assert.equal(JSON.stringify(bucket.storage.get('settings')), settingsBefore, 'the strip pill changed settings')
    assert.equal(bucket.controls.length, controlsBefore, 'clicking the strip pill sent a /control command')
    assert.equal(bucket.storage.get('settings').filmBehind, false, 'the film was sent behind the chat')
    assert.equal(bucket.storage.get('settings').videoWindow, true, 'the watch window closed')
  })

  dispose()
}

// --------------------------------------------------------------- reporting

console.log(results.join('\n'))
console.log(`\n${results.length - failed} passed, ${failed} failed`)

try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch {
  // the scratch dir is pruned anyway
}

if (failed > 0) process.exitCode = 1
