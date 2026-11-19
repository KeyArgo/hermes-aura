/**
 * "Behind chat": the fourth place the film can play, and the only one Aura
 * paints on the host page. This file proves the whole of that promise:
 *
 *   1. the Right panel's Watch in row offers four real pills, in reading
 *      order: Panel, Window, Desktop, Behind chat (last), and the Send to row
 *      ends with Behind chat too,
 *   2. the Behind chat pill is a real control: not disabled, not greyed, no
 *      "coming soon" label, and it is the one that is marked active while the
 *      film is behind the chat,
 *   3. clicking it writes filmBehind: true and mounts exactly ONE click-through
 *      iframe at z-index -1 on document.body (the player page), plus the one
 *      glass stylesheet scoped by data-aura-backdrop on <html>; the panel then
 *      shows no second picture,
 *   4. the default surface is still the Right panel: with filmBehind false
 *      nothing at all is drawn on the host page (no iframe, no glass, no
 *      attribute),
 *   5. Panel takes the film back: filmBehind false, the iframe and the glass
 *      gone with it, and the film in the panel again,
 *   6. dispose leaves no backdrop iframe and no glass behind.
 *
 * The filename keeps its old name (the pill it once described was a greyed
 * "coming soon" signpost); Behind chat ships now.
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
const domByAria = (root, label) => domFind(root, node => node.attributes && node.attributes['aria-label'] === label)
const clickHandlers = node => (node.__handlers && node.__handlers.click) || []
const clickDom = node => {
  const handlers = clickHandlers(node)
  assert.ok(handlers.length, 'this node has no click handler')
  handlers.forEach(fn => fn({ preventDefault() {} }))
}

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

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aura-behind-'))
const pluginCopy = path.join(tmp, 'plugin.mjs')
const sdkStub = path.join(tmp, 'sdk-stub.mjs')
const reactStub = path.join(tmp, 'react-stub.mjs')
const jsxStub = path.join(tmp, 'jsx-runtime-stub.mjs')

const source = fs.readFileSync(PLUGIN, 'utf8')
const rewritten = source
  .replace(/from\s+'@hermes\/plugin-sdk'/g, "from './sdk-stub.mjs'")
  .replace(/from\s+'react'/g, "from './react-stub.mjs'")
  .replace(/from\s+'react\/jsx-runtime'/g, "from './jsx-runtime-stub.mjs'")

fs.writeFileSync(pluginCopy, rewritten + '\nexport const wiringTest = { video: $video, frame: () => filmFrame, surface: () => $filmSurface.get(), backdrop: () => backdropEl, lastPollAt: () => (typeof lastPollAt === "number" ? lastPollAt : 0) };\n')

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

// Fake DOM: enough for the panel DOM, the floating strip, the backdrop iframe,
// the stylesheet, and the Aura theme's glow canvas on <html>.
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
const bodyIframes = () => bodyChildren.filter(node => node.tagName === 'IFRAME')
const glassStyle = () => headChildren.find(node => node.attributes && node.attributes.id === 'aura-glass')

// -------------------------------------------------------------- static rules

record('plugin.js carries the opt-in gate, not a coming-soon signpost', () => {
  assert.match(source, /function behindChatWanted/, 'the opt-in gate is gone')
  assert.match(source, /data-aura-backdrop/, 'the glass is no longer scoped by one attribute')
  assert.doesNotMatch(source, /ap-pill-soon/, 'the greyed coming-soon pill is still in the source')
  assert.doesNotMatch(source, /Behind chat \(coming soon\)/, 'the coming-soon label is still in the source')
})
record('Behind chat is a real place, last in FILM_PLACES', () => {
  const places = /const FILM_PLACES = \[([\s\S]*?)\n\]/.exec(source)
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
// The Right panel's Watch in row: four real pills, Behind chat last.
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

  record('1. Watch in offers four real pills: Panel, Window, Desktop, Behind chat', () => {
    assert.equal(pills.length, 4, `Watch in has ${pills.length} pills: ${pills.map(pill => pill.textContent).join(', ')}`)
    assert.deepEqual(pills.map(pill => pill.textContent), ['Panel', 'Window', 'Desktop', 'Behind chat'],
      'the Behind chat pill is not last')
  })

  record('2. the Behind chat pill is enabled and has no coming-soon dressing', () => {
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

  record('3. with the film in the panel, nothing is drawn behind the chat (the default)', () => {
    assert.equal(bodyIframes().length, 0, 'a backdrop iframe exists without Behind chat')
    assert.equal(glassStyle(), undefined, 'the glass exists without Behind chat')
    assert.equal(documentElement.getAttribute('data-aura-backdrop'), undefined,
      'the scoping attribute exists without Behind chat')
    assert.equal(behindPill.attributes['data-active'], 'false', 'Behind chat is marked active')
    assert.equal(domByAria(pane, 'Watch the film in the Right panel').attributes['data-active'], 'true',
      'the film is not marked in the Right panel')
  })

  await recordAsync('4. clicking it sends the film behind the chat: one click-through iframe and the glass', async () => {
    clickDom(behindPill)
    await sleep(80)
    await tickPoll(bucket)
    assert.equal(bucket.storage.get('settings').filmBehind, true, 'Behind chat wrote no filmBehind')
    const frames = bodyIframes()
    assert.equal(frames.length, 1, `Behind chat mounted ${frames.length} body iframes`)
    const frame = frames[0]
    assert.match(String(frame.src), /\/player\.html/, 'the backdrop is not the film player page')
    assert.equal(frame.style.position, 'fixed')
    assert.equal(frame.style.zIndex, '-1', 'the backdrop is not behind the app')
    assert.equal(frame.style.pointerEvents, 'none', 'the backdrop takes clicks meant for the chat')
    assert.equal(frame.attributes['aria-hidden'], 'true', 'the backdrop is exposed to assistive tech')
    assert.equal(frame.attributes.sandbox, 'allow-scripts allow-same-origin', 'the backdrop sandbox is wrong')
    assert.ok(glassStyle(), 'the app surfaces were not cleared for the film behind the chat')
    assert.equal(documentElement.getAttribute('data-aura-backdrop'), '', 'the glass is not scoped to the backdrop')
    // The panel is the remote: no second picture, and Behind chat is the
    // marked place.
    assert.equal(pluginModule.wiringTest.surface().placement, '', 'the film is drawn inside Hermes as well')
    assert.equal(domByAria(pane, 'Watch the film behind the chat').attributes['data-active'], 'true',
      'Behind chat is not marked as the current place')
    const stage = domFind(pane, node => node.className === 'ap-stage')
    assert.equal(stage.style.display, 'none', 'the panel still shows a second picture')
  })

  await recordAsync('5. Panel takes the film back and leaves nothing on the host page', async () => {
    clickDom(domByAria(pane, 'Watch the film in the Right panel'))
    await sleep(80)
    await tickPoll(bucket)
    assert.equal(bucket.storage.get('settings').filmBehind, false, 'Panel did not write filmBehind: false')
    assert.equal(bodyIframes().length, 0, 'the backdrop iframe survived the move to the panel')
    assert.equal(glassStyle(), undefined, 'the glass survived the move to the panel')
    assert.equal(documentElement.getAttribute('data-aura-backdrop'), undefined,
      'the scoping attribute survived the move to the panel')
    assert.equal(pluginModule.wiringTest.surface().placement, 'panel', 'the film did not come back to the panel')
  })

  await recordAsync('6. dispose takes the backdrop and the glass with it', async () => {
    clickDom(domByAria(pane, 'Watch the film behind the chat'))
    await sleep(80)
    assert.equal(bodyIframes().length, 1, 'precondition: no backdrop to dispose')
    dispose()
    assert.equal(bodyIframes().length, 0, 'dispose left the backdrop iframe on the host body')
    assert.equal(glassStyle(), undefined, 'dispose left the glass stylesheet')
    assert.equal(documentElement.getAttribute('data-aura-backdrop'), undefined,
      'dispose left the scoping attribute on <html>')
    assert.equal(pluginModule.wiringTest.backdrop(), null, 'dispose left the backdrop frame registered')
  })
}

// ===================================================================
// The watch window's "Send to" row: the same real pill, last, and it works.
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
  const behind = domByAria(bar, 'Send the film behind the chat')

  record('7. the Send to row ends with a real Behind chat pill', () => {
    assert.ok(behind, 'the strip has no Behind chat pill')
    assert.notEqual(behind.disabled, true, 'the strip pill is disabled')
    assert.equal(behind.attributes['aria-disabled'], undefined, 'aria-disabled is still set')
    assert.equal(behind.attributes.disabled, undefined, 'the disabled attribute is still set')
    assert.doesNotMatch(String(behind.className), /ap-pill-soon/, 'the strip pill still carries the greyed class')
    const labels = sendChildren.map(node => (node.attributes && node.attributes['aria-label']) || node.textContent)
    assert.deepEqual(labels, [
      'Send to',
      'Send the film to the Right panel',
      'Pop the film out to the desktop',
      'Send the film behind the chat'
    ], 'the strip order is not Right panel, Desktop, Behind chat')
  })

  await recordAsync('8. clicking the strip pill sends the film behind the chat and closes the watch window', async () => {
    clickDom(behind)
    await sleep(80)
    const saved = bucket.storage.get('settings')
    assert.equal(saved.filmBehind, true, 'the film was not sent behind the chat')
    assert.equal(saved.videoWindow, false, 'the watch window stayed open over the backdrop')
    assert.equal(bodyIframes().length, 1, 'Behind chat mounted no backdrop iframe on the host body')
    assert.ok(glassStyle(), 'Behind chat mounted no glass')
    assert.equal(pluginModule.wiringTest.surface().placement, '', 'the film is still drawn inside Hermes as well')
  })

  dispose()
  record('9. disposing the second scenario leaves nothing on the host page', () => {
    assert.equal(bodyIframes().length, 0, 'dispose left a backdrop iframe behind')
    assert.equal(glassStyle(), undefined, 'dispose left the glass stylesheet')
    assert.equal(documentElement.getAttribute('data-aura-backdrop'), undefined,
      'dispose left the scoping attribute on <html>')
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

  record('10. the Aura theme glow mounts behind the app, and stands down while the film is behind the chat', () => {
    assert.ok(glow(), 'the Aura theme mounted no glow canvas')
  })

  await recordAsync('11. Behind chat takes the glow down, and Panel brings it back', async () => {
    menuChoice('Watch the film behind the chat (quick menu)').props.onClick()
    await sleep(40)
    await tickPoll(bucket)
    assert.equal(bodyIframes().length, 1, 'precondition: no film behind the chat')
    assert.equal(glow(), undefined, 'the glow canvas still paints over the film behind the chat')
    menuChoice('Watch the film in the Right panel (quick menu)').props.onClick()
    await sleep(40)
    await tickPoll(bucket)
    assert.equal(bodyIframes().length, 0, 'precondition: the film left the host page')
    assert.ok(glow(), 'the glow canvas did not come back with the panel film')
  })

  dispose()
  sdk.themeState.name = 'nous'
  record('12. dispose takes the glow canvas with it', () => {
    assert.equal(glow(), undefined, 'dispose left the glow canvas on <html>')
  })
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
