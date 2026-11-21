/**
 * "Behind chat": the fourth place the film (or the visualiser) can play.
 *
 * On a host that exposes the SDK backdrop area (`BACKDROP_AREA`) it is ONE
 * contribution in that layer, and nothing else: Aura's own iframe, rendered
 * inside the box the host gives it, with `{ opacity, dimApp }` clamped. Picking
 * the pill registers exactly one backdrop; picking another place, turning Aura
 * Off or unloading the plugin calls the disposer; and document.body, <head> and
 * <html> never see a write from it.
 *
 * On a host WITHOUT the area, Behind chat stays what the catalog shows today:
 * a disabled, greyed "coming soon" pill. No registration, no host-page writes,
 * and a saved filmBehind:true from another host reads as "not chosen", so the
 * film stays in Aura's own surfaces instead of vanishing.
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
const SOURCE = fs.readFileSync(PLUGIN, 'utf8')

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
const domByAria = (root, label) => domFind(root, node => node.attributes && node.attributes['aria-label'] === label)
const clickHandlers = node => (node.__handlers && node.__handlers.click) || []
const clickDom = node => {
  const handlers = clickHandlers(node)
  assert.ok(handlers.length, 'this node has no click handler')
  handlers.forEach(fn => fn({ preventDefault() {} }))
}

/** A host ctx. `disposed()` counts disposer calls, so "did Aura hand the layer
 *  back?" is exact. */
function makeCtx(settings) {
  const contributions = []
  const timers = []
  const controls = []
  const storage = new Map()
  const disposerCalls = []
  if (settings) storage.set('settings', settings)
  let serverEnabled = settings && typeof settings.enabled === 'boolean' ? settings.enabled : true
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
        disposerCalls.push(entry.id)
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
      if (route === '/status') {
        return { ok: true, port: 4321, url: 'http://127.0.0.1:4321/?token=not-shown-in-ui', capture: 'pipewire', enabled: serverEnabled }
      }
      if (route === '/state') {
        return {
          ...serverFrame, bands: [...serverFrame.bands], intensity: 0.5, opacity: 0.35,
          behavior: 'balanced', motion: 'agent_music', reduced_motion: false, enabled: serverEnabled
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
      return { ok: true }
    }
  }

  return { ctx, contributions, timers, controls, storage, disposerCalls }
}

// --------------------------------------------------------------- temp module

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aura-behind-'))

/** A fake host. `withArea` is the whole point: a desktop build with the backdrop
 *  layer exports BACKDROP_AREA from the SDK, an older one does not. */
function makeHarness(name, withArea) {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  const pluginCopy = path.join(dir, 'plugin.mjs')
  const sdkStub = path.join(dir, 'sdk-stub.mjs')
  const reactStub = path.join(dir, 'react-stub.mjs')
  const jsxStub = path.join(dir, 'jsx-runtime-stub.mjs')

  fs.writeFileSync(pluginCopy, SOURCE
    .replace(/from\s+'@hermes\/plugin-sdk'/g, "from './sdk-stub.mjs'")
    .replace(/from\s+'react'/g, "from './react-stub.mjs'")
    .replace(/from\s+'react\/jsx-runtime'/g, "from './jsx-runtime-stub.mjs'") +
    '\nexport const wiringTest = { video: $video, frame: () => filmFrame, surface: () => $filmSurface.get(), backdrop: () => $backdropSurface.get(), registration: () => backdropRegistration, setEnabled, lastPollAt: () => (typeof lastPollAt === "number" ? lastPollAt : 0) };\n')

  fs.writeFileSync(sdkStub, `// Stub of @hermes/plugin-sdk: records what the plugin asks the host to do.
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
${withArea ? "export const BACKDROP_AREA = 'backdrop'\n" : ''}export const PANES_AREA = 'panes'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
export const SETTINGS_PLUGINS_AREA = 'settings.plugins'
export const THEMES_AREA = 'themes'
export const TITLEBAR_AREAS = { center: 'titleBar.center', left: 'titleBar.left', right: 'titleBar.right' }
`)

  fs.writeFileSync(reactStub, `// Stub of react: hooks are synchronous no-ops so a component can be called
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
`)

  fs.writeFileSync(jsxStub, `// Stub of react/jsx-runtime: plain element descriptors.
export function jsx(type, props, key) { return { type, props, key } }
export const jsxs = jsx
export const Fragment = Symbol.for('react.fragment')
`)

  return { pluginPath: pluginCopy, sdkPath: sdkStub }
}

// Fake DOM: enough for the panel DOM, the floating strip, and the Aura theme's
// glow canvas on <html>.
const bodyChildren = []
const headChildren = []
const rootChildren = []
const documentElement = {
  style: {},
  attributes: {},
  children: rootChildren,
  appendChild(node) {
    node.parentNode = this
    rootChildren.push(node)
    return node
  },
  removeChild(node) {
    const index = rootChildren.indexOf(node)
    if (index >= 0) rootChildren.splice(index, 1)
    node.parentNode = null
    return node
  },
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

const withArea = makeHarness('with-area', true)
const withoutArea = makeHarness('without-area', false)
const pluginModule = await import(pathToFileURL(withArea.pluginPath).href)
const oldModule = await import(pathToFileURL(withoutArea.pluginPath).href)
const sdk = await import(pathToFileURL(withArea.sdkPath).href)

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
function mountPane(bucket, module = pluginModule) {
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
  const surface = module.wiringTest.surface()
  const frame = module.wiringTest.frame()
  if (surface && surface.placement === 'panel' && frame && !frame.parentNode) {
    const stage = domFind(hostNode, node => node.className === 'ap-stage')
    if (stage) stage.appendChild(frame)
  }
  return hostNode
}

async function fireTick(bucket, module = pluginModule) {
  const tick = bucket.timers.find(t => t.kind === 'interval' && !t.cleared)
  assert.ok(tick, 'no polling interval registered')
  const since = Date.now() - module.wiringTest.lastPollAt()
  if (since < 250) await sleep(250 - since)
  tick.fn()
}

async function tickPoll(bucket, module = pluginModule) {
  await fireTick(bucket, module)
  await sleep(40)
  rerenderFloating()
}

const videoBar = () => [...bodyChildren, ...floatingNodes()].find(node => node.attributes && node.attributes.role === 'toolbar')
const bodyIframes = () => bodyChildren.filter(node => node.tagName === 'IFRAME')
const glassStyle = () => headChildren.find(node => node.attributes && node.attributes.id === 'aura-glass')
const backdrops = bucket => bucket.contributions.filter(item => item.area === 'backdrop')

// -------------------------------------------------------------- static rules

record('plugin.js feature-detects the backdrop area and never writes the host page for it', () => {
  assert.match(SOURCE, /typeof pluginSdk\.BACKDROP_AREA === 'string'/, 'the area is not feature-detected')
  assert.match(SOURCE, /area: BACKDROP_AREA/, 'nothing registers in the backdrop area')
  assert.match(SOURCE, /dimApp: BACKDROP_DIM_APP/, 'the contribution carries no dimApp')
  assert.doesNotMatch(SOURCE, /data-aura-backdrop/, 'the old host-page backdrop attribute is still in the source')
  assert.doesNotMatch(SOURCE, /aura-glass/, 'the old glass stylesheet is still in the source')
  assert.doesNotMatch(SOURCE, /doc\.body\.appendChild\(backdrop/, 'the old body-iframe path is still in the source')
})

record('Behind chat is a real place, last in FILM_PLACES', () => {
  const places = /const FILM_PLACES = \[([\s\S]*?)\n\]/.exec(SOURCE)
  assert.ok(places, 'FILM_PLACES is gone')
  const labels = [...places[1].matchAll(/\['([a-z]+)', '([^']+)'/g)].map(match => [match[1], match[2]])
  assert.deepEqual(labels, [
    ['panel', 'Panel'],
    ['window', 'Window'],
    ['desktop', 'Desktop'],
    ['behind', 'Behind chat']
  ], 'FILM_PLACES is not Panel, Window, Desktop, Behind chat')
})

// ===================================================================
// A host WITH the backdrop area: a real pill and ONE contribution.
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
  const behindPill = domByAria(pane, 'Watch the film behind the chat')

  record('1. Watch in offers four real pills, Panel, Window, Desktop, Behind chat last', () => {
    assert.equal(pills.length, 4, `Watch in has ${pills.length} pills: ${pills.map(pill => pill.textContent).join(', ')}`)
    assert.deepEqual(pills.map(pill => pill.textContent), ['Panel', 'Window', 'Desktop', 'Behind chat'],
      'the Behind chat pill is not last')
  })

  record('2. with the area, the Behind chat pill is enabled and has no coming-soon dressing', () => {
    assert.ok(behindPill, 'no Behind chat pill')
    assert.equal(behindPill.attributes['aria-label'], 'Watch the film behind the chat')
    assert.notEqual(behindPill.disabled, true, 'the pill is disabled')
    assert.equal(Object.prototype.hasOwnProperty.call(behindPill.attributes, 'disabled'), false,
      'the disabled attribute is still set')
    assert.equal(behindPill.attributes['aria-disabled'], undefined, 'aria-disabled is still set')
    assert.doesNotMatch(String(behindPill.className), /ap-pill-soon/, 'the pill still carries the greyed class')
    assert.doesNotMatch(String(behindPill.title || ''), /coming soon/i, 'the tooltip still says coming soon')
    assert.equal(clickHandlers(behindPill).length > 0, true, 'the pill has no click handler')
  })

  record('3. with the film in the panel, no backdrop is registered (the default)', () => {
    assert.equal(backdrops(bucket).length, 0, 'a backdrop is registered without Behind chat')
    assert.equal(bodyIframes().length, 0, 'an iframe exists on the host body without Behind chat')
    assert.equal(glassStyle(), undefined, 'a #aura-glass style exists without Behind chat')
    assert.equal(documentElement.getAttribute('data-aura-backdrop'), undefined,
      'the scoping attribute exists without Behind chat')
    assert.equal(behindPill.attributes['data-active'], 'false', 'Behind chat is marked active')
    assert.equal(domByAria(pane, 'Watch the film in the Right panel').attributes['data-active'], 'true',
      'the film is not marked in the Right panel')
  })

  await recordAsync('4. clicking it registers exactly one backdrop with render and clamped data', async () => {
    clickDom(behindPill)
    await sleep(80)
    await tickPoll(bucket)
    assert.equal(bucket.storage.get('settings').filmBehind, true, 'Behind chat wrote no filmBehind')
    const list = backdrops(bucket)
    assert.equal(list.length, 1, `Behind chat registered ${list.length} backdrops, not one`)
    const entry = list[0]
    assert.equal(entry.id, 'behind-chat', 'the contribution is not Aura\'s Behind chat')
    assert.equal(typeof entry.render, 'function', 'the contribution has no render')
    assert.ok(entry.data, 'the contribution carries no data')
    for (const key of ['opacity', 'dimApp']) {
      const value = entry.data[key]
      assert.equal(Number.isFinite(value), true, `data.${key} is not a finite number`)
      assert.ok(value >= 0 && value <= 1, `data.${key} is not clamped: ${value}`)
    }
    // The layer paints the player page, sized to the host's box.
    const frame = entry.render()
    assert.ok(frame && frame.props, 'the contribution rendered nothing')
    assert.equal(frame.type, 'iframe', 'the backdrop is not a frame')
    assert.match(String(frame.props.src), /\/player\.html/, 'the backdrop is not the film player page')
    assert.equal(frame.props['aria-hidden'], 'true', 'the backdrop is exposed to assistive tech')
    assert.equal(frame.props.sandbox, 'allow-scripts allow-same-origin', 'the backdrop sandbox is wrong')
    assert.equal(frame.props.style.width, '100%', 'the backdrop does not fill the layer')
    assert.equal(frame.props.style.height, '100%', 'the backdrop does not fill the layer')
    assert.equal(frame.props.style.pointerEvents, 'none', 'the backdrop takes clicks meant for the chat')
    // Nothing on the host page was written for it.
    assert.equal(bodyIframes().length, 0, 'Behind chat mounted an iframe on the host body')
    assert.equal(glassStyle(), undefined, 'Behind chat mounted a stylesheet in <head>')
    assert.equal(documentElement.getAttribute('data-aura-backdrop'), undefined,
      'Behind chat wrote an attribute on <html>')
    // The panel is the remote: no second picture, and Behind chat is the
    // marked place.
    assert.equal(pluginModule.wiringTest.surface().placement, '', 'the film is drawn inside Hermes as well')
    assert.equal(domByAria(pane, 'Watch the film behind the chat').attributes['data-active'], 'true',
      'Behind chat is not marked as the current place')
    const stage = domFind(pane, node => node.className === 'ap-stage')
    assert.equal(stage.style.display, 'none', 'the panel still shows a second picture')
  })

  await recordAsync('5. Panel takes the backdrop away and calls its disposer', async () => {
    clickDom(domByAria(pane, 'Watch the film in the Right panel'))
    await sleep(80)
    await tickPoll(bucket)
    assert.equal(bucket.storage.get('settings').filmBehind, false, 'Panel did not write filmBehind: false')
    assert.equal(backdrops(bucket).length, 0, 'the backdrop contribution survived the move to the panel')
    assert.equal(bucket.disposerCalls.includes('behind-chat'), true, 'the backdrop disposer was never called')
    assert.equal(pluginModule.wiringTest.registration(), null, 'Aura still holds a backdrop disposer')
    assert.equal(bodyIframes().length, 0, 'an iframe appeared on the host body')
    assert.equal(documentElement.getAttribute('data-aura-backdrop'), undefined,
      'an attribute appeared on <html>')
    assert.equal(pluginModule.wiringTest.surface().placement, 'panel', 'the film did not come back to the panel')
  })

  await recordAsync('6. turning Aura Off disposes the backdrop', async () => {
    clickDom(domByAria(pane, 'Watch the film behind the chat'))
    await sleep(80)
    await tickPoll(bucket)
    assert.equal(backdrops(bucket).length, 1, 'precondition: no backdrop to turn off')
    const before = bucket.disposerCalls.filter(id => id === 'behind-chat').length
    await pluginModule.wiringTest.setEnabled(false)
    await sleep(40)
    await tickPoll(bucket)
    assert.equal(backdrops(bucket).length, 0, 'an Off left the backdrop registered')
    assert.ok(bucket.disposerCalls.filter(id => id === 'behind-chat').length > before,
      'the Off did not call the backdrop disposer')
  })

  await recordAsync('7. dispose takes the contribution with it', async () => {
    dispose()
    assert.equal(backdrops(bucket).length, 0, 'dispose left the backdrop registered')
    assert.equal(pluginModule.wiringTest.registration(), null, 'dispose left a backdrop disposer')
    assert.equal(bodyIframes().length, 0, 'dispose left an iframe on the host body')
    assert.equal(glassStyle(), undefined, 'dispose left a stylesheet in <head>')
  })
}

// ===================================================================
// A host WITHOUT the backdrop area: the greyed pill, and nothing else.
// ===================================================================

{
  const bucket = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: true, videoWindow: false,
    videoUrl: SINTEL_URL, panelCollapsed: false
  })
  const dispose = oldModule.default.register(bucket.ctx)
  await tickPoll(bucket, oldModule)
  const pane = mountPane(bucket, oldModule)
  await tickPoll(bucket, oldModule)

  const pillsRow = domFind(pane, node => node.className === 'ap-pills')
  const pills = pillsRow ? pillsRow.children.slice() : []
  const soon = pills[3]

  record('8. without the area, Watch in still lists Behind chat, greyed and disabled', () => {
    assert.equal(pills.length, 4, `Watch in has ${pills.length} pills`)
    assert.deepEqual(pills.map(pill => pill.textContent), ['Panel', 'Window', 'Desktop', 'Behind chat'],
      'the Behind chat pill is not last')
    assert.ok(soon, 'no fourth pill')
    assert.equal(soon.disabled, true, 'the pill is not disabled')
    assert.equal(soon.attributes['disabled'], '', 'the disabled attribute is not set')
    assert.equal(soon.attributes['aria-disabled'], 'true', 'aria-disabled is not set')
    assert.equal(soon.attributes['aria-label'], 'Watch the film behind the chat (coming soon)')
    assert.match(String(soon.title), /coming soon/i, 'the tooltip does not say coming soon')
    assert.match(String(soon.className), /\bap-pill-soon\b/, 'the pill is not greyed')
    assert.equal(clickHandlers(soon).length, 0, 'the greyed pill still has a click handler')
  })

  await recordAsync('9. without the area, choosing Behind chat registers nothing', async () => {
    // There is no click handler to reach it; moving the film there directly
    // (a caller, a stale setting) must still land in an Aura surface.
    await sleep(40)
    await tickPoll(bucket, oldModule)
    assert.equal(backdrops(bucket).length, 0, 'a host without the area got a backdrop registration')
    assert.equal(oldModule.wiringTest.registration(), null, 'a host without the area got a backdrop disposer')
    assert.equal(bodyIframes().length, 0, 'the host body got an iframe')
    assert.equal(glassStyle(), undefined, 'the host <head> got a stylesheet')
    assert.equal(documentElement.getAttribute('data-aura-backdrop'), undefined, 'the host root was written to')
    assert.equal(oldModule.wiringTest.surface().placement, 'panel', 'the film did not stay in the panel')
  })

  await recordAsync('10. without the area, a saved filmBehind:true from another host boots in the panel', async () => {
    dispose()
    const saved = makeCtx({
      enabled: true, backdropMode: 'video', panelEnabled: true, videoWindow: false,
      videoUrl: SINTEL_URL, filmBehind: true
    })
    const stop = oldModule.default.register(saved.ctx)
    try {
      await sleep(40)
      await tickPoll(saved, oldModule)
      assert.equal(backdrops(saved).length, 0, 'a stale filmBehind registered a backdrop')
      assert.equal(oldModule.wiringTest.surface().placement, 'panel', 'the film vanished instead of staying in the panel')
      assert.equal(bodyIframes().length, 0, 'the host body got an iframe')
    } finally {
      stop()
    }
  })
}

// ===================================================================
// The watch window's "Send to" row: the same answer, last.
// ===================================================================

{
  const bucket = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: true, videoWindow: true,
    videoUrl: SINTEL_URL
  })
  const dispose = pluginModule.default.register(bucket.ctx)
  await tickPoll(bucket)
  mountPane(bucket)
  // The strip and the watch window are drawn by the status-bar contribution.
  renderDeep(renderContribution(bucket.contributions.find(c => c.id === 'quick-menu')))
  await tickPoll(bucket)

  const bar = videoBar()
  assert.ok(bar, 'the watch window has no strip')
  const right = domByAria(bar, 'Send the film to the Right panel')
  assert.ok(right, 'the strip has no Right panel send')
  const sendChildren = right.parentNode.children.slice()
  const behind = domByAria(bar, 'Send the film behind the chat')

  record('11. with the area, the Send to row ends with a real Behind chat pill', () => {
    assert.ok(behind, 'the strip has no Behind chat pill')
    assert.notEqual(behind.disabled, true, 'the strip pill is disabled')
    assert.equal(behind.attributes['aria-disabled'], undefined, 'aria-disabled is still set')
    assert.doesNotMatch(String(behind.className), /ap-pill-soon/, 'the strip pill still carries the greyed class')
    const labels = sendChildren.map(node => (node.attributes && node.attributes['aria-label']) || node.textContent)
    assert.deepEqual(labels, [
      'Send to',
      'Send the film to the Right panel',
      'Pop the film out to the desktop',
      'Send the film behind the chat'
    ], 'the strip order is not Right panel, Desktop, Behind chat')
  })

  await recordAsync('12. clicking the strip pill registers the backdrop and closes the watch window', async () => {
    clickDom(behind)
    await sleep(80)
    const saved = bucket.storage.get('settings')
    assert.equal(saved.filmBehind, true, 'the film was not sent behind the chat')
    assert.equal(saved.videoWindow, false, 'the watch window stayed open over the backdrop')
    assert.equal(backdrops(bucket).length, 1, 'Behind chat registered no backdrop')
    assert.equal(bodyIframes().length, 0, 'Behind chat mounted an iframe on the host body')
    assert.equal(pluginModule.wiringTest.surface().placement, '', 'the film is still drawn inside Hermes as well')
  })

  dispose()
  record('13. disposing leaves nothing registered and nothing on the host page', () => {
    assert.equal(backdrops(bucket).length, 0, 'dispose left the backdrop registered')
    assert.equal(bodyIframes().length, 0, 'dispose left an iframe on the host body')
    assert.equal(glassStyle(), undefined, 'dispose left a stylesheet in <head>')
    assert.equal(documentElement.getAttribute('data-aura-backdrop'), undefined, 'dispose left <html> written to')
  })
}

// ===================================================================
// The Aura theme's glow and the film behind the chat are both the window's
// background, and the glow canvas is opaque: only one of them paints.
// ===================================================================

{
  const bucket = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: true, videoUrl: SINTEL_URL
  })
  const dispose = pluginModule.default.register(bucket.ctx)
  await tickPoll(bucket)
  // The permanent theme probe is what reports the active theme.
  sdk.themeState.name = 'aura'
  renderDeep(renderContribution(bucket.contributions.find(c => c.id === 'theme-probe')))
  await tickPoll(bucket)
  const glow = () => rootChildren.find(node => node.attributes && node.attributes['data-aura-glow'] !== undefined)
  const menuChoice = label => {
    const tree = renderContribution(bucket.contributions.find(c => c.id === 'quick-menu'))
    let found = null
    walk(tree, node => {
      if (!found && node.props && node.props['aria-label'] === label) found = node
    })
    return found
  }

  record('14. the Aura theme glow mounts behind the app', () => {
    assert.ok(glow(), 'the Aura theme mounted no glow canvas')
  })

  await recordAsync('15. Behind chat takes the glow down, and Panel brings it back', async () => {
    menuChoice('Watch the film behind the chat (quick menu)').props.onClick()
    await sleep(40)
    await tickPoll(bucket)
    assert.equal(backdrops(bucket).length, 1, 'precondition: no film behind the chat')
    assert.equal(glow(), undefined, 'the glow canvas still paints over the film behind the chat')
    menuChoice('Watch the film in the Right panel (quick menu)').props.onClick()
    await sleep(40)
    await tickPoll(bucket)
    assert.equal(backdrops(bucket).length, 0, 'precondition: the film left the backdrop')
    assert.ok(glow(), 'the glow canvas did not come back with the panel film')
  })

  dispose()
  sdk.themeState.name = 'nous'
  record('16. dispose takes the glow canvas with it', () => {
    assert.equal(glow(), undefined, 'dispose left the glow canvas on <html>')
  })
}

// ===================================================================
// Visualizer mode: the same layer, painting the visualiser page.
// ===================================================================

{
  const bucket = makeCtx({
    enabled: true, backdropMode: 'aura', panelEnabled: true, filmBehind: true,
    videoUrl: '', videoWindow: false
  })
  const dispose = pluginModule.default.register(bucket.ctx)
  try {
    await recordAsync('17. in Visualizer mode Behind chat paints the visualiser page', async () => {
      await sleep(40)
      await tickPoll(bucket)
      const list = backdrops(bucket)
      assert.equal(list.length, 1, `Behind chat registered ${list.length} backdrops, not one`)
      const frame = list[0].render()
      assert.ok(frame && frame.props, 'the contribution rendered nothing')
      assert.match(String(frame.props.src), /overlay=1/, 'the backdrop is not the visualiser page')
      assert.equal(String(frame.props.src).includes('player.html'), false, 'the backdrop is still the film page')
      assert.equal(frame.props.style.opacity, '1', 'the visualiser page should not be washed out by the film strength')
      assert.equal(pluginModule.wiringTest.surface().placement, '', 'the visualiser is drawn in the panel as well')
      assert.equal(bodyIframes().length, 0, 'the host body got an iframe')
      assert.equal(glassStyle(), undefined, 'the host <head> got a stylesheet')
    })
  } finally {
    dispose()
  }
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
