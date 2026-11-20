/**
 * The visualiser's watch window (owner bug): in Visualizer mode Aura's own
 * floating pane carried only the visualiser, with none of the controls the
 * film's watch window has. It must offer the same Size presets and the same
 * "Send to" row — Panel, Window, Desktop, Behind chat — with Panel returning
 * the visualiser to the Right panel, Desktop opening the desktop OS window on
 * the visualiser page, and Behind chat going behind the chat like the film's
 * own row.
 * Video mode must be byte-for-byte what it was: film rows, Right panel and
 * Desktop sends, five sizes.
 *
 * The harness is the one tests/test_behind_chat_soon.mjs uses: a temp copy of
 * the plugin has its three import specifiers rewritten to local stub modules,
 * a fake DOM stands in for document/getComputedStyle, makeCtx provides the
 * host ctx, and floating panes are mounted through their real refs.
 *
 * Run: node tests/test_visualiser_watch_bar.mjs
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
// ===================================================================
// The visualiser's watch window: the same Size presets and the same Send to
// row the film's watch window has.
// ===================================================================

const rowWith = (bar, aria) => bar.children.find(row => domByAria(row, aria) !== null) || null
const allNodes = root => {
  const nodes = []
  const collect = node => {
    for (const child of node.children || []) {
      nodes.push(child)
      collect(child)
    }
  }
  collect(root)
  return nodes
}

{
  const bucket = makeCtx({
    enabled: true, backdropMode: 'aura', panelEnabled: true, videoWindow: true, videoUrl: ''
  })
  const dispose = pluginModule.default.register(bucket.ctx)
  await tickPoll(bucket)

  const bar = videoBar()
  const pane = bucket.contributions.find(c => c.id === 'watch' && c.removed !== true)
  const nodes = bar ? allNodes(bar) : []
  const sizePills = nodes.filter(node => node.attributes && /^Watch window size: /.test(node.attributes['aria-label'] || ''))
  const visualRow = bar ? rowWith(bar, 'Send the visualiser to the Right panel') : null
  const filmRow = bar ? rowWith(bar, 'Send the film to the Right panel') : null
  const transportRow = bar
    ? bar.children.find(row => (row.children || []).some(child => child.textContent === '▶' || child.textContent === '⏸'))
    : null
  const titleRow = bar
    ? bar.children.find(row => (row.children || []).some(child => child.textContent === '⠿'))
    : null

  record('A1. the visualiser watch window carries a strip inside its floating pane, never on document.body', () => {
    assert.ok(bar, 'the visualiser watch window has no control strip')
    assert.equal(bodyChildren.includes(bar), false, 'the strip was appended to document.body')
    assert.ok(pane, 'the visualiser watch window is not an SDK floating pane')
    assert.equal(pane.id, 'watch', 'the visualiser window did not register as the watch window')
    assert.ok(floatingNodes().includes(bar), 'the strip is not inside the floating pane')
    assert.equal(bar.style.flexDirection, 'column', 'the strip is not stacked')
  })

  record('A2. the visualiser watch window shows the same Size presets as the film window', () => {
    assert.deepEqual(
      sizePills.map(node => node.attributes['aria-label']),
      ['Small', 'Medium', 'Large', 'X-Large', 'Huge'].map(label => `Watch window size: ${label}`),
      'the visualiser strip does not offer the film window\'s five sizes'
    )
    const sizeRow = sizePills[0].parentNode
    assert.equal(sizeRow.style.display, 'flex', 'the Size row is hidden in the visualiser watch window')
    assert.equal(sizeRow.children[0].textContent, 'Size', 'the row has no Size label')
    assert.equal(bar.children[bar.children.length - 1], sizeRow, 'Size is not the last row')
  })

  record('A3. the visualiser watch window shows Send to, with the four places in order', () => {
    assert.ok(visualRow, 'the visualiser watch window has no Send to row')
    assert.equal(visualRow.style.display, 'flex', 'the Send to row is hidden in the visualiser watch window')
    const labels = visualRow.children.map(node => (node.attributes && node.attributes['aria-label']) || node.textContent)
    assert.deepEqual(labels, [
      'Send to',
      'Send the visualiser to the Right panel',
      'Keep the visualiser in the watch window',
      'Pop the visualiser out to the desktop',
      'Send the visualiser behind the chat'
    ], 'the Send to row is not Panel, Window, Desktop, Behind chat')
    const behind = visualRow.children[visualRow.children.length - 1]
    assert.notEqual(behind.disabled, true, 'the Behind chat pill is still disabled')
    assert.equal(behind.textContent, 'Behind chat')
    assert.equal(visualRow.children[1].textContent, 'Panel')
    assert.equal(visualRow.children[2].textContent, 'Window')
    assert.equal(visualRow.children[3].textContent, 'Desktop')
    assert.equal(visualRow.children[4].textContent, 'Behind chat')
  })

  record('A4. the film\'s own rows stay out of the visualiser strip', () => {
    assert.ok(titleRow, 'the film title row vanished from the markup')
    assert.equal(titleRow.style.display, 'none', 'the film\'s title/scrub row is showing on the visualiser')
    assert.ok(transportRow, 'the strip has no transport row at all')
    assert.equal(transportRow.style.display, 'none', 'the film transport is showing on the visualiser')
    assert.ok(filmRow, 'the film Send to row vanished from the markup')
    assert.equal(filmRow.style.display, 'none', 'the film\'s Send to row is showing on the visualiser')
  })

  record('A5. a Size pill resizes the visualiser watch window from itself', () => {
    const huge = sizePills.find(node => node.attributes['aria-label'] === 'Watch window size: Huge')
    const before = parseFloat(pane.data.width)
    const handlers = huge.__handlers.click || []
    assert.equal(handlers.length, 1, 'the Huge pill has no click handler')
    handlers[0]({ preventDefault() {} })
    assert.equal(bucket.storage.get('settings').videoWindowSize, 'huge', 'Huge did not save the size')
    const next = bucket.contributions.find(c => c.id === 'watch' && c.removed !== true)
    assert.ok(next, 'resizing dropped the visualiser watch window')
    assert.ok(parseFloat(next.data.width) > before,
      `the window is still ${next.data.width} after asking for Huge (was ${before}px)`)
  })

  dispose()
}

// -------------------------------------------------------------------
// Panel returns the visualiser to the Right panel.
// -------------------------------------------------------------------

{
  const bucket = makeCtx({
    enabled: true, backdropMode: 'aura', panelEnabled: true, videoWindow: true, videoUrl: ''
  })
  const dispose = pluginModule.default.register(bucket.ctx)
  await tickPoll(bucket)
  mountPane(bucket)
  await tickPoll(bucket)

  await recordAsync('A6. Send to Panel puts the visualiser back in the Right panel', async () => {
    const panelPill = domByAria(videoBar(), 'Send the visualiser to the Right panel')
    assert.ok(panelPill, 'the visualiser strip has no Panel send')
    const handler = (panelPill.__handlers.click || [])[0]
    assert.equal(typeof handler, 'function', 'the Panel pill has no click handler')
    handler({ preventDefault() {} })
    await sleep(40)
    assert.equal(bucket.storage.get('settings').videoWindow, false, 'the watch window stayed open')
    assert.equal(pluginModule.wiringTest.surface().placement, 'panel', 'the visualiser did not return to the panel')
    assert.equal(videoBar(), undefined, 'the strip outlived the watch window')
  })

  dispose()
}

// -------------------------------------------------------------------
// Desktop pops the visualiser out into the desktop OS window (page
// "visualizer"), never the film page.
// -------------------------------------------------------------------

{
  const bucket = makeCtx({
    enabled: true, backdropMode: 'aura', panelEnabled: true, videoWindow: true, videoUrl: ''
  })
  const dispose = pluginModule.default.register(bucket.ctx)
  await tickPoll(bucket)

  await recordAsync('A7. Send to Desktop opens the desktop window with the visualiser page', async () => {
    const desktopPill = domByAria(videoBar(), 'Pop the visualiser out to the desktop')
    assert.ok(desktopPill, 'the visualiser strip has no Desktop send')
    const handler = (desktopPill.__handlers.click || [])[0]
    assert.equal(typeof handler, 'function', 'the Desktop pill has no click handler')
    handler({ preventDefault() {} })
    await sleep(120)
    const opens = bucket.requests.filter(r => r.route === '/window/open')
    assert.equal(opens.length, 1, 'Send to Desktop never asked for a desktop window')
    assert.equal(opens[0].options.body.page, 'visualizer', 'the desktop window was not the visualiser page')
    assert.ok(!opens[0].options.body.url, 'the visualiser pop-out still carried a film url')
    assert.equal(bucket.storage.get('settings').backdropMode, 'aura', 'the mode changed on the way out')
  })

  dispose()
}

// ===================================================================
// Video mode is untouched: the film's rows, its two-place Send to, its sizes.
// ===================================================================

{
  const bucket = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: false, videoWindow: true,
    videoUrl: SINTEL_URL, videoClosed: false
  })
  const dispose = pluginModule.default.register(bucket.ctx)
  await tickPoll(bucket)

  const bar = videoBar()
  const nodes = bar ? allNodes(bar) : []
  const filmRow = bar ? rowWith(bar, 'Send the film to the Right panel') : null
  const visualRow = bar ? rowWith(bar, 'Send the visualiser to the Right panel') : null
  const transportRow = bar
    ? bar.children.find(row => (row.children || []).some(child => child.textContent === '▶' || child.textContent === '⏸'))
    : null
  const titleRow = bar
    ? bar.children.find(row => (row.children || []).some(child => child.textContent === '⠿'))
    : null
  const sizePills = nodes.filter(node => node.attributes && /^Watch window size: /.test(node.attributes['aria-label'] || ''))

  record('A8. the film watch window still shows its transport, its Send to pair and its sizes', () => {
    assert.ok(bar, 'the film watch window has no strip')
    assert.ok(transportRow, 'the film strip has no transport row')
    assert.equal(transportRow.style.display, 'flex', 'the film transport row is hidden')
    assert.ok(titleRow, 'the film title row vanished')
    assert.equal(titleRow.style.display, 'flex', 'the film title row is hidden')
    assert.ok(filmRow, 'the film Send to row vanished')
    assert.equal(filmRow.style.display, 'flex', 'the film Send to row is hidden in its own window')
    const labels = filmRow.children.map(node => (node.attributes && node.attributes['aria-label']) || node.textContent)
    assert.deepEqual(labels, [
      'Send to',
      'Send the film to the Right panel',
      'Pop the film out to the desktop',
      'Send the film behind the chat'
    ], 'the film Send to row changed')
    // The visualiser row did not exist before this change; if it is present it
    // must stay hidden on the film.
    if (visualRow) assert.equal(visualRow.style.display, 'none', 'the visualiser Send to row shows on the film')
    assert.equal(sizePills.length, 5, `the film window offers ${sizePills.length} sizes, not five`)
    assert.equal(sizePills[0].parentNode.style.display, 'flex', 'the film Size row is hidden')
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
