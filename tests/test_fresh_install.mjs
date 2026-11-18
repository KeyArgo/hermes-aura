/**
 * Fresh-install regression test for the Aura desktop half (desktop/plugin.js).
 *
 * The question this file asks is the one a brand-new user asks: does Aura work
 * out of the box, with NOTHING in plugin storage (no 'settings' key at all) and
 * an Aura server that answers? Every scenario registers the plugin against an
 * EMPTY storage and asserts one out-of-the-box behaviour with its own named
 * test.
 *
 *   1. Aura ships enabled; the Right panel pane (panes / 'panel') is registered
 *      and docked right with enforce: true.
 *   2. The sidebar row (SIDEBAR_NAV_AREA) and the /aura route (ROUTES_AREA)
 *      are registered.
 *   3. The status-bar quick menu is registered and renders a version chip.
 *   4. The starter films are there to pick (STARTER_SOURCES on the page and in
 *      the panel card list).
 *   5. Picking a starter film on the Aura PAGE switches to video mode and plays
 *      it (storage backdropMode 'video', videoUrl set, /control backdrop_mode).
 *   6. Picking a starter film from the RIGHT PANEL does the same. This is
 *      EXPECTED TO FAIL on this commit (known bug #3, fixed in another lane):
 *      the panel card click applies the source but never flips the backdrop
 *      mode, so a new user who picks a film in the pane sees nothing.
 *   7. Pop out from the page moves the film to the floating watch window;
 *      Bring back returns it.
 *   8. Pasting a YouTube PLAYLIST link on the page saves it to videoPlaylists
 *      (persisted), and it survives dispose + re-register with the same
 *      storage.
 *   9. Dispose leaves nothing behind: contributions, timers, listeners, iframes.
 *
 * The harness is self-contained and mirrors tests/test_desktop_plugin.mjs: a
 * temp copy of the plugin has its three import specifiers rewritten to local
 * stub modules (@hermes/plugin-sdk, react, react/jsx-runtime), a fake DOM
 * stands in for document/getComputedStyle, makeCtx provides the host ctx
 * (contributions, timers, listeners, storage, /status /state /control /version
 * stubs) and the whole file reports with an "N passed, M failed" line.
 *
 * Run: node tests/test_fresh_install.mjs
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

// Host nodes of mounted floating panes (the card body the real host renders).
const floatingHosts = []
const floatingRecords = new Set()
/** Re-render every floating pane, as React would after a store change. */
const rerenderFloating = () => { for (const record of floatingRecords) record.rerender() }
function mountFloatingPane(record) {
  if (!record || !record.data || record.data.placement !== 'floating' || typeof record.render !== 'function') return null
  const refs = []
  // Like React, a re-render keeps the same host nodes (by position) and hands
  // them to the ref again; function components run again.
  let slot = 0
  const walk = element => {
    if (!element || typeof element !== 'object') return
    if (Array.isArray(element)) { element.forEach(walk); return }
    if (typeof element.type === 'function') { walk(element.type(element.props || {})); return }
    if (isFilmIframe(element)) { sdk.SandboxedFrame(element.props); return }
    const props = element.props || {}
    if (typeof props.ref === 'function' && typeof element.type === 'string') {
      const existing = refs[slot]
      slot += 1
      if (existing) { existing.ref = props.ref; props.ref(existing.host); walk(props.children); return }
      const host = globalThis.document.createElement(element.type)
      floatingHosts.push(host)
      refs.push({ ref: props.ref, host })
      props.ref(host)
    }
    walk(props.children)
  }
  walk(record.render())
  record.rerender = () => { slot = 0; walk(record.render()) }
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

// Aura's film is its own <iframe> inside its pane/page/watch window; the
// frame stub below builds the element (and calls its ref) for it.
const isFilmIframe = el => !!el && el.type === 'iframe' && !!el.props && el.props.title === 'Aura film'

// Aura's surfaces render inside a display:contents wrapper that carries their
// stylesheet (never the app's <head>); render the surface itself.
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

function collectText(node, out) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object' && 'type' in node && 'props' in node) collectText(node.props.children, out)
  return out
}
const texts = element => collectText(element, []).join('\n')

// Walk a plugin-created DOM tree (fake document elements, not React
// descriptors): these nodes carry className/textContent/children directly.
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

/** A brand-new install: NO settings key in storage unless a caller reuses an
 *  existing storage Map (scenario 8's re-register). */
function makeCtx(storageMap, opts = {}) {
  const contributions = []
  const timers = []
  const controls = []
  const requests = []
  const disposers = []
  const listeners = []
  const storage = storageMap || new Map()
  // Mirrors the real server. A fresh install has never touched /control, so
  // the server is on with exactly the product defaults.
  // opts.serverEnabled: false stages a server whose saved config says off
  // (an older install the user switched off), to test what a new build does.
  let serverEnabled = opts.serverEnabled === false ? false : true
  const serverSettings = {
    motion: 'agent_music',
    behavior: 'balanced',
    intensity: 0.5,
    opacity: 0.35,
    reduced_motion: false
  }
  const serverFrame = {
    level: 0.55,
    bands: [0, 0, 0, 0, 0, 0, 0, 0],
    onset: false,
    centroid: 0.4,
    flatness: 0.2,
    silence: false,
    mood: 'thinking'
  }

  const ctx = {
    source: 'plugin:aura',
    register(contribution) {
      const entry = { ...contribution, removed: false }
      contributions.push(entry)
      // The host draws placement:'floating' panes as cards (strip + watch window).
      const unmount = mountFloatingPane(entry)
      // Lets a test drop this card's DOM on its own (the host unmounting it late).
      entry.unmountCard = unmount
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
        id: page.id,
        area: 'settings.plugins',
        title: page.title,
        data: { children: page.children || [], icon: page.icon },
        render: page.render
      })
    },
    onDispose(fn) {
      disposers.push(fn)
    },
    setInterval(fn, ms) {
      const entry = { fn, ms, kind: 'interval', cleared: false }
      timers.push(entry)
      return () => {
        entry.cleared = true
      }
    },
    setTimeout(fn, ms) {
      const entry = { fn, ms, kind: 'timeout', cleared: false }
      timers.push(entry)
      return () => {
        entry.cleared = true
      }
    },
    addEventListener(target, type, fn) {
      const entry = { target, type, fn, removed: false }
      listeners.push(entry)
      return () => {
        entry.removed = true
      }
    },
    storage: {
      get(key, fallback) {
        return storage.has(key) ? storage.get(key) : fallback
      },
      set(key, value) {
        storage.set(key, value)
      },
      remove(key) {
        storage.delete(key)
      }
    },
    async rest(route, options = {}) {
      requests.push({ route, options })
      if (route === '/status') {
        return {
          ok: true,
          port: 4321,
          url: 'http://127.0.0.1:4321/?token=not-shown-in-ui',
          capture: 'pipewire',
          enabled: serverEnabled
        }
      }
      if (route === '/state') {
        return {
          ...serverFrame,
          bands: [...serverFrame.bands],
          intensity: serverSettings.intensity,
          opacity: serverSettings.opacity,
          behavior: serverSettings.behavior,
          motion: serverSettings.motion,
          reduced_motion: serverSettings.reduced_motion,
          enabled: serverEnabled
        }
      }
      if (route === '/control') {
        controls.push(options.body)
        if (options.body && typeof options.body.enabled === 'boolean') serverEnabled = options.body.enabled
        if (options.body && typeof options.body.motion === 'string') serverSettings.motion = options.body.motion
        if (options.body && typeof options.body.behavior === 'string') serverSettings.behavior = options.body.behavior
        if (options.body && Number.isFinite(options.body.intensity)) serverSettings.intensity = options.body.intensity
        if (options.body && Number.isFinite(options.body.opacity)) serverSettings.opacity = options.body.opacity
        if (options.body && typeof options.body.reduced_motion === 'boolean') serverSettings.reduced_motion = options.body.reduced_motion
        return { ok: true }
      }
      if (route === '/version') {
        return {
          version: '1.2.3',
          commit: opts.commit || 'abcdef1234567890',
          commit_short: (opts.commit || 'abcdef1234567890').slice(0, 8),
          commit_date: '2026-11-09',
          channel: 'dev',
          dirty: false
        }
      }
      throw new Error(`unexpected route ${route}`)
    }
  }

  return { ctx, contributions, timers, controls, disposers, listeners, requests, storage, serverSettings, serverFrame, serverEnabled: () => serverEnabled }
}

// --------------------------------------------------------------- temp module

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aura-fresh-install-'))
const pluginCopy = path.join(tmp, 'plugin.mjs')
const sdkStub = path.join(tmp, 'sdk-stub.mjs')
const reactStub = path.join(tmp, 'react-stub.mjs')
const jsxStub = path.join(tmp, 'jsx-runtime-stub.mjs')

const source = fs.readFileSync(PLUGIN, 'utf8')
const rewritten = source
  .replace(/from\s+'@hermes\/plugin-sdk'/g, "from './sdk-stub.mjs'")
  .replace(/from\s+'react'/g, "from './react-stub.mjs'")
  .replace(/from\s+'react\/jsx-runtime'/g, "from './jsx-runtime-stub.mjs'")

fs.writeFileSync(pluginCopy, rewritten + '\nexport const wiringTest = { video: $video, frame: () => filmFrame, surface: () => $filmSurface.get() };\n')

fs.writeFileSync(
  sdkStub,
  `// Stub of @hermes/plugin-sdk: records what the plugin asks the host to do.
export const calls = { accent: [], themes: [], navigations: [], notifications: [], undismissed: [], revealed: [] }

function makeAtom(initial) {
  let value = initial
  return {
    get: () => value,
    set: next => { value = next },
    listen: () => () => {}
  }
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
  theme: {
    name: themeState.name,
    colors: { accent: themeState.accent, primary: themeState.accent, ring: themeState.accent }
  },
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
// The film is rendered by the SDK's sandboxed frame. The stub builds the frame
// element (and calls its ref) so the transport and geometry can be exercised
// headlessly, exactly like a real mounted iframe.
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
export const StatusDot = () => null
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

// Fake DOM: enough for the plugin's backdrop iframe, panel DOM, stylesheet and
// control-strip accounting, and for asserting none of it survives dispose.
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
    const node = {
      tagName: String(tagName).toUpperCase(),
      style: {},
      attributes: {},
      children: [],
      parentNode: null,
      src: '',
      textContent: '',
      dataset: {},
      setAttribute(name, value) {
        this.attributes[name] = String(value)
      },
      getAttribute(name) {
        return this.attributes[name]
      },
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
      getBoundingClientRect() {
        return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }
      },
      get firstChild() {
        return this.children[0] || null
      },
      removeAttribute(name) {
        delete this.attributes[name]
      },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this)
      }
    }
    return node
  },
  addEventListener() {},
  removeEventListener() {}
}
globalThis.getComputedStyle = () => ({
  backgroundColor: 'rgba(0, 0, 0, 0)',
  getPropertyValue: () => ''
})

// The film can be a body iframe (full-window backdrop) or an SDK SandboxedFrame
// (pane/page/watch window). The player tests care about whichever is live.
const hostIframes = () => {
  const frames = bodyChildren.filter(node => node.tagName === 'IFRAME')
  const wiring = pluginModule && pluginModule.wiringTest
  const surface = wiring && wiring.surface ? wiring.surface() : null
  const current = wiring && wiring.frame && surface && surface.placement ? wiring.frame() : null
  if (current && !frames.includes(current)) frames.push(current)
  return frames
}
// The panel/page stylesheets are product surfaces (id 'aura-panel-style' /
// 'aura-ui-style'), not host injections; the guarded "effect" styles are the
// glass and theme injections the other suite covers.
const UI_STYLE_IDS = new Set(['aura-panel-style', 'aura-ui-style'])
const hostStyles = () => headChildren.filter(node => node.tagName === 'STYLE' && !UI_STYLE_IDS.has(node.attributes && node.attributes.id))
// The watch window's film: the SandboxedFrame inside Aura's floating pane.
const watchFrame = () => {
  const wiring = pluginModule && pluginModule.wiringTest
  const surface = wiring && wiring.surface ? wiring.surface() : null
  return surface && surface.placement === 'window' && wiring.frame ? wiring.frame() : null
}
// The watch window is 'watch'; the controls strip on its own is 'strip' (the host remembers each separately).
const watchPane = bucket => bucket.contributions.find(c => (c.id === 'watch' || c.id === 'strip') && c.data && c.data.placement === 'floating')
const videoBar = () => [...bodyChildren, ...floatingNodes()].find(node => node.attributes && node.attributes.role === 'toolbar')

/** Dispose a scenario instance; a throwing teardown is a real finding, so it
 *  is reported, not swallowed. Scenario 9 owns the full dispose contract. */
function safeDispose(label, fn) {
  try {
    fn()
  } catch (error) {
    record(`dispose hygiene after ${label}`, () => {
      throw error
    })
  }
}

const pluginModule = await import(pathToFileURL(pluginCopy).href)
const sdk = await import(pathToFileURL(sdkStub).href)

const SINTEL_URL = 'https://www.youtube.com/watch?v=eRsGyueVLvQ'
const PLAYLIST_URL = 'https://youtube.com/playlist?list=PLKcvhYw9tgjI&si=x'

// --------------------------------------------------------------- shared bits

// The page nests components (AuraSettings, VersionChip, RevampCard); render
// them deep, but keep SDK components as descriptors so their aria-labels stay
// findable (the SDK stubs render() to null).
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

function pageTree(bucket) {
  const route = bucket.contributions.find(c => c.area === 'routes')
  assert.ok(route, 'the Aura page route vanished')
  return renderDeep(renderContribution(route))
}

function pageAria(tree, label) {
  let found = null
  walk(tree, node => {
    if (!found && node.props && node.props['aria-label'] === label) found = node
  })
  return found
}

function pageAriaPrefix(tree, prefix) {
  let found = null
  walk(tree, node => {
    if (!found && node.props && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith(prefix)) {
      found = node
    }
  })
  return found
}

function findByAria(tree, label) {
  return pageAria(tree, label)
}

/** Mount the docked pane's real DOM: render the pane contribution, take the
 *  theatre ref and hand it a fake host node, exactly like the host layout
 *  arriving with a box for us to fill. */
function mountPane(bucket) {
  const pane = bucket.contributions.find(c => c.area === 'panes')
  assert.ok(pane, 'no panes contribution to mount')
  const tree = renderDeep(renderContribution(pane))
  let ref = null
  walk(tree, node => {
    if (!ref && node.props && typeof node.props.ref === 'function') ref = node.props.ref
  })
  assert.ok(typeof ref === 'function', 'the pane offers no mount ref')
  const hostNode = globalThis.document.createElement('div')
  ref(hostNode)
  return hostNode
}

const panelCards = hostNode =>
  domFindAll(hostNode, node => node.className === 'ap-card')

const cardTitle = card => {
  const title = domFind(card, node => node.className === 'ap-title')
  return title ? title.textContent : ''
}

const clickDom = node => {
  const handlers = (node.__handlers && node.__handlers.click) || []
  assert.ok(handlers.length, 'this panel node has no click handler')
  handlers.forEach(fn => fn({ preventDefault: () => {} }))
}

/** Give the plugin one poll tick so /status answers and live.ok becomes true
 *  (backdrop mounting is gated on the server actually being reachable). */
async function tickPoll(bucket) {
  const tick = bucket.timers.find(t => t.kind === 'interval' && !t.cleared)
  assert.ok(tick, 'no polling interval registered')
  tick.fn()
  await sleep(40)
  rerenderFloating()
}

// ===================================================================
// Scenario A: a brand-new user, EMPTY storage, server reachable.
// (Tests 1-4 run against this one registration.)
// ===================================================================

const freshA = makeCtx()
const storageWasEmptyAtBoot = !freshA.storage.has('settings')
const disposeA = pluginModule.default.register(freshA.ctx)
// The app's first paint: Aura's surfaces render before /version has answered.
// The Right panel's drawer embeds the same settings section (with its build
// chip), so the settings contribution stands in for it here.
let earlyPaneError = null
try {
  for (const area of ['panes', 'settings.plugins']) {
    const early = freshA.contributions.find(c => c.area === area)
    if (early) renderDeep(renderContribution(early))
  }
} catch (error) {
  earlyPaneError = error
}
await sleep(50)

record('0. fresh install: the Right panel renders before the server reports its version', () => {
  // VersionChip read build.commit_short while the build was still null; the
  // host's error boundary then blanked the whole pane, and the film fell back
  // to filling the window because the pane had no stage.
  assert.equal(earlyPaneError, null,
    `the Right panel threw on first paint: ${earlyPaneError && earlyPaneError.message}`)
})

record('1. fresh install: Aura is enabled by default and the Right panel pane is registered, docked right, enforce: true', () => {
  assert.ok(storageWasEmptyAtBoot, 'the scenario did not start from EMPTY storage (no "settings" key)')
  assert.equal(freshA.requests.some(r => r.route === '/status'), true, 'the plugin never asked the server /status')

  // Enabled by default: the settings row shows Aura on, the quick menu too.
  const settings = freshA.contributions.find(c => c.area === 'settings.plugins')
  assert.ok(settings, 'no settings page contribution')
  const enabledSwitch = findByAria(renderContribution(settings), 'Aura enabled')
  assert.ok(enabledSwitch, 'the settings page has no Aura enabled switch')
  assert.equal(enabledSwitch.props.checked, true, 'Aura is not enabled by default on a fresh install')

  const pane = freshA.contributions.find(c => c.area === 'panes')
  assert.ok(pane, 'no Right panel pane on a fresh install')
  assert.equal(pane.id, 'panel')
  assert.equal(pane.data.placement, 'right', 'the pane must prefer the right')
  assert.deepEqual(
    pane.data.dock,
    { pane: 'workspace', pos: 'right', enforce: true },
    'a new user must get the pane docked right even if their layout disagrees'
  )
})

record('2. fresh install: the sidebar row (SIDEBAR_NAV_AREA) and the /aura route (ROUTES_AREA) are registered', () => {
  const nav = freshA.contributions.find(c => c.area === sdk.SIDEBAR_NAV_AREA)
  assert.ok(nav, 'no sidebar.nav contribution on a fresh install')
  assert.equal(nav.data.path, '/aura', 'the sidebar row must open /aura')
  assert.equal(nav.data.label, 'Aura')
  const route = freshA.contributions.find(c => c.area === sdk.ROUTES_AREA)
  assert.ok(route, 'no routes contribution on a fresh install')
  assert.equal(route.data.path, '/aura', 'the Aura page must live at /aura')
  assert.equal(typeof route.render, 'function', 'the route needs a render function')
})

record('3. fresh install: the status-bar quick menu is registered and renders a version chip', () => {
  const statusBar = freshA.contributions.filter(c => c.area.startsWith('statusBar.'))
  assert.equal(statusBar.length, 1, 'expected exactly one status-bar contribution')
  const menu = statusBar[0]
  assert.equal(menu.area, sdk.STATUSBAR_AREAS.right, 'the quick menu must sit on the right')
  assert.equal(menu.id, 'quick-menu')
  assert.equal(typeof menu.render, 'function')
  const tree = renderContribution(menu)
  let chip = null
  walk(tree, node => {
    if (!chip && node.props && node.props.key === 'build' && typeof node.type === 'function') chip = node
  })
  assert.ok(chip, 'the quick menu has no version chip')
  const body = texts(chip.type(chip.props))
  assert.ok(body.includes('v1.2.3'), `the chip does not show the server build line (got: ${JSON.stringify(body)})`)
  assert.ok(body.includes('abcdef12'), 'the chip is not the shared build line from /version')
})

record('4. fresh install: the starter films are offered on the page and in the panel source list', () => {
  const tree = pageTree(freshA)
  const chips = []
  walk(tree, node => {
    if ((node.type === 'button' || (node.props && node.props.role === 'button')) && node.props && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith('Play ')) {
      chips.push(node.props['aria-label'])
    }
  })
  assert.equal(chips.length, 8, `expected the 8 starter films on the page, got ${chips.length}: ${JSON.stringify(chips)}`)
  assert.ok(chips.includes('Play Sintel · Blender film'), 'Sintel is not offered on the page')
  assert.ok(chips.includes('Play Big Buck Bunny · Blender film'), 'Big Buck Bunny is not offered on the page')

  const hostNode = mountPane(freshA)
  const cards = panelCards(hostNode)
  assert.equal(cards.length, 8, `expected 8 starter cards in the pane, got ${cards.length}`)
  assert.ok(cards.some(card => cardTitle(card).includes('Sintel')), 'the pane card list has no Sintel')
  const kinds = domFindAll(hostNode, node => node.className === 'ap-kind').map(node => node.textContent)
  assert.ok(kinds.includes('youtube'), 'the pane does not label the starter cards as youtube sources')
})

safeDispose('the registration scenario (A)', disposeA)

// ===================================================================
// Scenario B: a new user picks a starter film ON THE PAGE. (Test 5)
// ===================================================================

const freshB = makeCtx()
const disposeB = pluginModule.default.register(freshB.ctx)
await tickPoll(freshB)

await recordAsync('5. fresh install: picking a starter film on the Aura page switches to video mode and plays it', async () => {
  const tree = pageTree(freshB)
  const card = pageAria(tree, 'Play Sintel · Blender film')
  assert.ok(card, 'the page does not offer the starter sources')
  card.props.onClick()
  await sleep(60)
  const saved = freshB.storage.get('settings')
  assert.ok(saved, 'a page pick never persisted any settings')
  assert.equal(saved.backdropMode, 'video', 'the page pick did not switch storage to video mode')
  assert.equal(saved.videoUrl, SINTEL_URL, 'the picked starter film was not saved as the video url')
  assert.ok(
    freshB.controls.some(patch => patch && patch.backdrop_mode === 'video'),
    `no /control patch with backdrop_mode 'video' reached the server (got ${JSON.stringify(freshB.controls)})`
  )
  assert.ok(
    freshB.controls.some(patch => patch && patch.video_url === SINTEL_URL),
    'the film url never reached /control'
  )
  // "plays it": one player frame, pointing at the video player page.
  mountPane(freshB)
  const frames = hostIframes()
  assert.equal(frames.length, 1, `the page pick should mount exactly one player, got ${frames.length}`)
  assert.match(frames[0].src, /player\.html/)
  assert.ok(decodeURIComponent(frames[0].src).includes(SINTEL_URL), 'the player is not showing the picked film')
})

safeDispose('the page-pick scenario (B)', disposeB)

// ===================================================================
// Scenario C: a new user picks a starter film from the RIGHT PANEL.
// (Test 6 — EXPECTED TO FAIL: known bug #3.)
// ===================================================================

const freshC = makeCtx()
const disposeC = pluginModule.default.register(freshC.ctx)
await tickPoll(freshC)

await recordAsync('6. fresh install: picking a starter film from the RIGHT PANEL switches to video mode and plays it', async () => {
  const hostNode = mountPane(freshC)
  const cards = panelCards(hostNode)
  const sintel = cards.find(card => cardTitle(card).includes('Sintel'))
  assert.ok(sintel, 'the pane card list does not offer the starter sources')
  clickDom(sintel)
  await sleep(60)
  const saved = freshC.storage.get('settings')
  assert.ok(saved, 'a pane pick never persisted any settings')
  // The url itself does get applied on this commit; the mode is what is
  // missing. Assert url first so the failing line is the mode, as evidence.
  assert.equal(saved.videoUrl, SINTEL_URL, 'the pane pick did not save the picked film url')
  assert.equal(saved.backdropMode, 'video', 'the pane pick did not switch to video mode: the pane shows a stage that plays nothing')
  assert.ok(
    freshC.controls.some(patch => patch && patch.backdrop_mode === 'video'),
    `no /control patch with backdrop_mode 'video' from the pane (got ${JSON.stringify(freshC.controls)})`
  )
})

safeDispose('the pane-pick scenario (C)', disposeC)

// ===================================================================
// Scenario G: the Right panel stays out of the way. Its film never sits over
// the host's menus or status bar, and one click hides the panel.
// ===================================================================

const freshG = makeCtx(new Map([['settings', {
  enabled: true, backdropMode: 'video', panelEnabled: true, videoUrl: SINTEL_URL
}]]))
const disposeG = pluginModule.default.register(freshG.ctx)
await tickPoll(freshG)
const paneG = mountPane(freshG)
// A pane scrolled so its stage hangs 130 px below the pane, over the status bar.
const panelBoxG = domFind(paneG, node => node.attributes && node.attributes.id === 'aura-panel')
const stageG = domFind(paneG, node => node.className === 'ap-stage')
if (panelBoxG) panelBoxG.getBoundingClientRect = () => ({ left: 1180, top: 40, width: 340, height: 760, right: 1520, bottom: 800 })
if (stageG) stageG.getBoundingClientRect = () => ({ left: 1200, top: 760, width: 300, height: 170, right: 1500, bottom: 930 })
await tickPoll(freshG)

record('10. the Right panel film sits below the host menus (status-bar menu on top)', () => {
  const frame = hostIframes()[0]
  assert.ok(frame, 'no film frame mounted for the Right panel')
  assert.ok(Number(frame.style.zIndex) < 50,
    `the panel film is at z-index ${frame.style.zIndex}, above the host's popovers (z-50)`)
})

record('11. the Right panel film is clipped to the panel, never over the status bar', () => {
  const frame = hostIframes()[0]
  assert.ok(frame, 'no film frame mounted for the Right panel')
  assert.match(String(frame.style.clipPath || ''), /inset\(0px 0px 130px 0px\)/,
    `the film is not clipped to the panel (clip-path: ${frame.style.clipPath || 'none'})`)
})

await recordAsync('12. one click on the panel header hides the Right panel, Aura stays on', async () => {
  const hide = domFind(paneG, node => node.attributes && node.attributes['aria-label'] === 'Hide the Right panel')
  assert.ok(hide, 'the Right panel header has no hide button')
  clickDom(hide)
  await sleep(40)
  const saved = freshG.storage.get('settings')
  assert.equal(saved.panelEnabled, false, 'the hide button did not hide the Right panel')
  assert.equal(saved.enabled, true, 'hiding the panel turned Aura off')
})

safeDispose('the out-of-the-way scenario (G)', disposeG)

// ===================================================================
// Scenario H: in visualiser mode the Right panel is the visualiser's controls.
// ===================================================================

for (const [mode, expectControls] of [['aura', true], ['video', false]]) {
  const freshH = makeCtx(new Map([['settings', {
    enabled: true, backdropMode: mode, panelEnabled: true, windowVisual: true, videoUrl: SINTEL_URL
  }]]))
  const disposeH = pluginModule.default.register(freshH.ctx)
  await tickPoll(freshH)
  const paneH = mountPane(freshH)
  await tickPoll(freshH)
  const tree = renderDeep(renderContribution(freshH.contributions.find(c => c.area === 'panes')))
  const body = domFind(paneH, node => node.className === 'ap-body')

  record(`13. ${mode} mode: the Right panel ${expectControls ? 'shows' : 'does not show'} the visualiser controls`, () => {
    for (const label of ['Reacts to', 'Intensity', 'Visual strength', 'Style']) {
      assert.equal(Boolean(pageAria(tree, label)), expectControls,
        `${mode} mode: "${label}" is ${expectControls ? 'missing from' : 'shown in'} the Right panel`)
    }
  })

  record(`14. ${mode} mode: the stage is shown and the film controls are ${expectControls ? 'hidden' : 'shown'}`, () => {
    const stage = domFind(paneH, node => node.className === 'ap-stage')
    assert.ok(body && stage, 'the panel has no film body or stage')
    assert.equal(body.style.display === 'none', expectControls,
      `${mode} mode: the film controls display is "${body.style.display || ''}"`)
    assert.notEqual(stage.style.display, 'none',
      `${mode} mode: the stage display is "${stage.style.display || ''}"`)
  })

  safeDispose(`the panel-mode scenario (H, ${mode})`, disposeH)
}

// ===================================================================
// Scenario J: the in-app watch window with the Right panel open. It must not
// land on the panel (whose controls it would cover), and it carries its own
// strip (drag grip, transport, and where to send the film next) unless that
// strip is switched off in favour of the panel.
// ===================================================================

async function watchWindowScenario(extra) {
  const bucket = makeCtx(new Map([['settings', {
    enabled: true, backdropMode: 'video', panelEnabled: true, videoWindow: true,
    videoUrl: SINTEL_URL, ...extra
  }]]))
  const dispose = pluginModule.default.register(bucket.ctx)
  await tickPoll(bucket)
  const pane = mountPane(bucket)
  // The watch window is drawn by the status-bar contribution, which is always
  // mounted in the app; render it so the SandboxedFrame exists in the harness.
  renderDeep(renderContribution(bucket.contributions.find(c => c.id === 'quick-menu')))
  await tickPoll(bucket)
  return { bucket, dispose, pane }
}

const stripButton = label => {
  const strip = videoBar()
  return strip ? domFind(strip, node => node.attributes && node.attributes['aria-label'] === label) : null
}

{
  const scenario = await watchWindowScenario({})
  record('19. the watch window opens beside the Right panel, never on top of it', () => {
    // The watch window is an SDK floating pane; with the Right panel open it
    // spawns top-left so it never opens over the panel's controls.
    assert.ok(watchFrame(), 'no watch window')
    const pane = watchPane(scenario.bucket)
    assert.ok(pane, 'the watch window is not a floating pane')
    assert.equal(pane.data.anchor, 'top-left', 'the watch window spawns over the Right panel')
  })
  record('20. with the Right panel open the watch window still carries its strip, with a drag grip', () => {
    assert.ok(videoBar(), 'no control strip under the watch window while the Right panel is open')
    assert.ok(domFind(videoBar(), node => node.attributes && node.attributes['aria-label'] === 'Drag to move the watch window'),
      'the strip has no drag grip')
  })
  record('21. the strip offers where to send the film: Right panel or desktop', () => {
    for (const label of ['Send the film to the Right panel', 'Pop the film out to the desktop']) {
      assert.ok(stripButton(label), `the strip has no "${label}"`)
    }
    assert.equal(stripButton('Send the film behind the chat'), null, 'Behind chat is still on the strip')
  })
  await recordAsync('22. "Right panel" on the strip puts the film back in the panel', async () => {
    clickDom(stripButton('Send the film to the Right panel'))
    await sleep(40)
    const saved = scenario.bucket.storage.get('settings')
    assert.equal(saved.videoWindow, false, 'the watch window stayed open')
    assert.equal(saved.filmBehind, false, 'the film was not sent to the panel')
  })
  safeDispose('the watch-window scenario (J)', scenario.dispose)
}

{
  const scenario = await watchWindowScenario({})
  await recordAsync('23. the strip has no Behind chat send', async () => {
    assert.equal(stripButton('Send the film behind the chat'), null, 'Behind chat is still on the strip')
    assert.equal(scenario.bucket.storage.get('settings').filmBehind, false, 'the film was sent behind the chat')
  })
  safeDispose('the watch-window behind-chat scenario (J)', scenario.dispose)
}

{
  // A saved "controls off" from the old switch must not leave the watch window
  // with no way to move it ("no move bar or media controls": a regression).
  const scenario = await watchWindowScenario({ watchControls: false })
  record('24. the watch window always has its strip: move grip and transport', () => {
    assert.ok(videoBar(), 'the watch window has no strip')
    assert.ok(domFind(videoBar(), node => node.attributes && node.attributes['aria-label'] === 'Drag to move the watch window'),
      'the watch window has no move grip')
    assert.ok(domFind(videoBar(), node => node.attributes && node.attributes['aria-label'] === 'Stop'),
      'the watch window strip has no media controls')
  })
  await recordAsync('61. the watch window strip stays fully visible when idle', async () => {
    // The mouse over the film never reaches the app (the frame swallows it), so
    // a strip that fades on idle never came back: it looked gone.
    await sleep(3200)
    assert.equal(videoBar().style.opacity, '1', `the strip faded to ${videoBar().style.opacity} under the watch window`)
    assert.notEqual(videoBar().style.pointerEvents, 'none', 'the idle strip stopped taking clicks')
  })
  record('62. the watch window and its strip opt out of the host title-bar drag strip', () => {
    // Near the top of the window, Electron drag regions eat real clicks.
    assert.equal(videoBar().style.WebkitAppRegion, 'no-drag', 'the strip can be swallowed by the title-bar drag strip')
    const frame = watchFrame()
    assert.ok(frame, 'no watch window')
    assert.equal(frame.style.WebkitAppRegion, 'no-drag', 'the watch window can be swallowed by the title-bar drag strip')
  })
  safeDispose('the watch-window strip scenario (J)', scenario.dispose)
}

// ===================================================================
// Scenario K: everything reachable where you are. Visualizer | Video sits in the
// status bar next to Aura; the Right panel has the film tools the menu has; the
// labels say where the film actually is.
// ===================================================================

{
  const scenario = await watchWindowScenario({})
  const paneControl = label => domFind(scenario.pane, node => node.attributes && node.attributes['aria-label'] === label)

  record('25. Visualizer | Video sits in the status bar next to Aura, outside the menu', () => {
    // Still one status-bar item (Aura's rule), but the toggle is on the bar itself,
    // not only inside the dropdown.
    const item = scenario.bucket.contributions.find(c => c.id === 'quick-menu')
    assert.ok(item, 'no status-bar item')
    let onBar = null
    const visit = (node, insideMenu) => {
      if (!node || onBar) return
      if (Array.isArray(node)) { node.forEach(child => visit(child, insideMenu)); return }
      if (typeof node !== 'object' || !node.props) return
      const nowInside = insideMenu || node.type === sdk.PopoverContent
      if (!nowInside && node.props['aria-label'] === 'Aura mode') { onBar = node; return }
      visit(node.props.children, nowInside)
    }
    visit(renderDeep(renderContribution(item)), false)
    assert.ok(onBar, 'Visualizer | Video is only inside the Aura menu, not on the status bar')
  })

  record('26. the Right panel has the film tools: paste a link, jump to a time, close; Desktop lives in Watch in only', () => {
    for (const label of ['Paste a video or playlist link', 'Jump to time (Right panel)', 'Close the film', 'Watch the film in a desktop window']) {
      assert.ok(paneControl(label), `the Right panel has no "${label}"`)
    }
    assert.ok(!paneControl('Pop the film out to the desktop (Right panel)'),
      'the redundant "Pop out to desktop" button is still in the Right panel')
  })

  record('27. with the film in the watch window, Watch in marks the window', () => {
    const panelPill = paneControl('Watch the film in the Right panel')
    const windowPill = paneControl('Watch the film in the watch window')
    assert.ok(panelPill && windowPill, 'the Watch in pills are missing')
    assert.notEqual(panelPill.attributes['data-active'], 'true', 'Watch in shows Panel while the film is in the watch window')
    assert.equal(windowPill.attributes['data-active'], 'true', 'Watch in does not mark the watch window')
    assert.equal(paneControl('Watch the film behind the chat'), null, 'Behind chat is still a Watch in choice')
  })

  record('28. the Aura page names the watch window, not a "pop-out window"', () => {
    const text = JSON.stringify(pageTree(scenario.bucket))
    assert.ok(!/pop-out window/.test(text), 'the page still calls the in-app watch window a pop-out window')
  })

  await recordAsync('29. the panel power button needs a second click to turn Aura off', async () => {
    // It sits right beside Visualizer | Video: one stray click used to turn all of
    // Aura off in silence. Turning on stays one click.
    const power = domFind(scenario.pane, node => node.className === 'ap-power')
    assert.ok(power, 'the panel has no power button')
    clickDom(power)
    await sleep(30)
    assert.equal(scenario.bucket.storage.get('settings').enabled, true, 'one click turned Aura off')
    assert.match(String(power.getAttribute('aria-label') || ''), /again/i, 'the button does not ask for a second click')
    clickDom(power)
    await sleep(30)
    assert.equal(scenario.bucket.storage.get('settings').enabled, false, 'the second click did not turn Aura off')
  })

  safeDispose('the reachability scenario (K)', scenario.dispose)
}

// ===================================================================
// Scenario L: every Right-panel button does something (or says why not), the
// panel scrolls, Watch in shows where the film really is, and the mode toggle
// follows Aura on/off on the status bar and sits on the Aura page header.
// ===================================================================

{
  const scenario = await watchWindowScenario({ videoWindow: false })
  const control = label => domFind(scenario.pane, node => node.attributes && node.attributes['aria-label'] === label)

  await recordAsync('30. the panel ⧉ button pops the film out into the watch window inside Hermes', async () => {
    const pop = control('Pop out (watch window in Hermes)')
    assert.ok(pop, 'the panel has no in-Hermes pop-out button')
    clickDom(pop)
    await sleep(40)
    assert.equal(scenario.bucket.storage.get('settings').videoWindow, true, '⧉ did not open the watch window')
  })

  record('31. playlist-only buttons are not shown for a single film', () => {
    for (const label of ['Manage playlist', 'Hide this episode']) {
      const button = control(label)
      assert.ok(button, `the panel has no "${label}"`)
      assert.equal(button.style.display, 'none', `"${label}" shows for a single film, where it does nothing`)
    }
  })

  record('32. the Right panel scrolls when its content is taller than the pane', () => {
    const style = domFind(scenario.pane, node => node.attributes && node.attributes.id === 'aura-panel-style')
    assert.ok(style, 'no panel stylesheet')
    const css = String(style.textContent || '')
    const body = /\.ap-body\s*\{([^}]*)\}/.exec(css)
    assert.ok(body, 'the panel body has no rule, so it never limits its height')
    assert.match(body[1], /overflow-y:\s*auto/, 'the panel body cannot scroll')
    assert.match(body[1], /min-height:\s*0/, 'the panel body cannot shrink to scroll')
  })

  await recordAsync('33. Watch in offers Panel, Window and Desktop, and marks where the film is', async () => {
    for (const label of ['Watch the film in the Right panel',
      'Watch the film in the watch window', 'Watch the film in a desktop window']) {
      assert.ok(control(label), `Watch in has no "${label}"`)
    }
    assert.equal(control('Watch the film behind the chat'), null, 'Behind chat is still a Watch in choice')
    // ⧉ above put the film in the watch window: that is what Watch in must show.
    assert.equal(control('Watch the film in the watch window').attributes['data-active'], 'true',
      'Watch in does not mark the watch window as the current place')
  })

  safeDispose('the panel-buttons scenario (L)', scenario.dispose)
}

{
  const scenario = await watchWindowScenario({})
  // Off the way a person does it: the "Aura enabled" switch, which tells the server.
  const settingsPage = scenario.bucket.contributions.find(c => c.area === 'settings.plugins')
  findByAria(renderContribution(settingsPage), 'Aura enabled').props.onCheckedChange(false)
  await sleep(40)
  await tickPoll(scenario.bucket)
  record('34. with Aura off the status bar does not show Visualizer | Video', () => {
    const item = scenario.bucket.contributions.find(c => c.id === 'quick-menu')
    let onBar = null
    const visit = (node, insideMenu) => {
      if (!node || onBar) return
      if (Array.isArray(node)) { node.forEach(child => visit(child, insideMenu)); return }
      if (typeof node !== 'object' || !node.props) return
      const nowInside = insideMenu || node.type === sdk.PopoverContent
      if (!nowInside && node.props['aria-label'] === 'Aura mode') { onBar = node; return }
      visit(node.props.children, nowInside)
    }
    visit(renderDeep(renderContribution(item)), false)
    assert.equal(onBar, null, 'the status bar still shows the mode toggle with Aura off')
  })
  safeDispose('the Aura-off scenario (L)', scenario.dispose)
}

{
  const scenario = await watchWindowScenario({})
  record('35. the Aura page header has Visualizer | Video next to Aura on / off', () => {
    assert.ok(pageAria(pageTree(scenario.bucket), 'Aura mode (page header)'),
      'the Aura page header has no mode toggle next to its Aura on/off chip')
  })
  safeDispose('the page-header scenario (L)', scenario.dispose)
}

// ===================================================================
// Scenario M: the film out on the desktop. Every control must reach the
// desktop window (the in-app frame is parked), the visualiser must still show
// in visualiser mode, and nothing may clear the app's surfaces with nothing
// behind them. Plus the visualiser-mode panel: no tall empty box.
// ===================================================================

{
  // The owner's live settings when this broke: Behind chat, Visual behind the app on.
  const scenario = await watchWindowScenario({ videoWindow: false, filmBehind: true, windowVisual: true })
  const sent = []
  const realRest = scenario.bucket.ctx.rest
  scenario.bucket.ctx.rest = async (route, options = {}) => {
    if (route === '/window') return { ok: true, available: true, open: false }
    if (route === '/window/open') return { ok: true, open: true, url: SINTEL_URL }
    if (route === '/player/command') { sent.push(options.body); return { ok: true, seq: sent.length } }
    if (route.startsWith('/player')) return { ok: true, player: {}, commands: [], seq: 0 }
    return realRest(route, options)
  }
  const control = label => domFind(scenario.pane, node => node.attributes && node.attributes['aria-label'] === label)
  clickDom(control('Watch the film in a desktop window'))
  await sleep(80)
  await tickPoll(scenario.bucket)

  await recordAsync('36. with the film on the desktop, Jump to and volume reach the desktop window', async () => {
    const jump = control('Jump to time (Right panel)')
    assert.ok(jump, 'no Jump to box')
    jump.value = '1:00'
    for (const fn of (jump.__handlers && jump.__handlers.keydown) || []) fn({ key: 'Enter' })
    await sleep(30)
    assert.ok(sent.some(c => c && c.cmd === 'seek' && c.value === 60),
      `Jump to never reached the desktop window (sent ${JSON.stringify(sent)})`)
    const volume = control('Volume')
    assert.ok(volume, 'no volume slider')
    for (const fn of (volume.__handlers && volume.__handlers.input) || []) fn({ target: { value: '40' } })
    await sleep(30)
    assert.ok(sent.some(c => c && c.cmd === 'volume' && Math.abs(c.value - 0.4) < 1e-9),
      `the volume slider never reached the desktop window (sent ${JSON.stringify(sent)})`)
  })

  const glassOn = () => headChildren.some(node => node.attributes && node.attributes.id === 'aura-glass')
  record('37. with the film on the desktop, the app is not cleared to glass', () => {
    assert.equal(glassOn(), false, 'the app surfaces were cleared while the film is out on the desktop')
  })

  await recordAsync('38. switching to the visualiser while the film is on the desktop shows it in the panel', async () => {
    const visualizer = domFind(scenario.pane, node => node.attributes && node.attributes['data-mode'] === 'aura')
    assert.ok(visualizer, 'no Visualizer mode button in the panel')
    clickDom(visualizer)
    await sleep(60)
    await tickPoll(scenario.bucket)
    const surface = pluginModule.wiringTest.surface()
    assert.equal(surface.placement, 'panel', 'the visualiser did not take the panel')
    assert.match(surface.src || '', /overlay=1/, 'the panel surface is not the visualiser page')
    assert.equal(bodyChildren.filter(node => node.tagName === 'IFRAME').length, 0,
      'the visualiser was appended to document.body')
  })

  record('39. the visualiser-mode panel shows its stage and its controls', () => {
    const panelBox = domFind(scenario.pane, node => node.attributes && node.attributes.id === 'aura-panel')
    const stage = domFind(scenario.pane, node => node.className === 'ap-stage')
    assert.ok(panelBox && stage, 'no #aura-panel stage')
    assert.notEqual(stage.style.display, 'none', 'the visualiser stage is hidden')
    const section = pageAria(renderDeep(renderContribution(scenario.bucket.contributions.find(c => c.area === 'panes'))), 'Visualizer controls')
    assert.ok(section && section.props.style && section.props.style.background,
      'the visualiser controls have no panel background (unreadable on a light theme)')
  })

  safeDispose('the desktop-window scenario (M)', scenario.dispose)
}

// Scenario N: Hermes starts while the desktop window is already open, in
// visualiser mode. Adopting the window must not pause it on every poll, flip
// the mode to video or switch the in-app watch window on.
{
  const sent = []
  let windowOpen = true
  const bucket = makeCtx(new Map([['settings', {
    enabled: true, backdropMode: 'aura', panelEnabled: true, windowVisual: true,
    videoWindow: false, videoUrl: SINTEL_URL
  }]]))
  const realRest = bucket.ctx.rest
  bucket.ctx.rest = async (route, options = {}) => {
    if (route === '/player/command') { sent.push(options.body); return { ok: true, seq: sent.length } }
    if (route === '/player') return { ok: true, player: {}, seq: 0, window: { ok: true, open: windowOpen, available: true } }
    if (route.startsWith('/player')) return { ok: true, commands: [], head_seq: 0 }
    return realRest(route, options)
  }
  const dispose = pluginModule.default.register(bucket.ctx)
  for (let i = 0; i < 4; i += 1) await tickPoll(bucket)
  const saved = bucket.storage.get('settings') || {}

  record('40. a poll with the desktop window open never pauses that window', () => {
    assert.deepEqual(sent.filter(c => c && c.cmd === 'pause'), [],
      `every poll paused the desktop film (sent ${JSON.stringify(sent)})`)
  })
  record('41. adopting an open desktop window keeps visualiser mode and no watch window', () => {
    assert.equal(saved.backdropMode, 'aura', 'the mode flipped to video on start')
    assert.notEqual(saved.videoWindow, true, 'the in-app watch window was switched on for a desktop film')
  })
  windowOpen = false
  await tickPoll(bucket)
  record('42. the desktop window closing in visualiser mode keeps visualiser mode', () => {
    assert.equal((bucket.storage.get('settings') || {}).backdropMode, 'aura',
      'closing the desktop window flipped the mode to video')
  })
  safeDispose('the adopted desktop-window scenario (N)', dispose)
}

// Scenario O: the Aura page header has two buttons, Aura on | Aura off; the
// active one is highlighted and one click on the other switches (owner, 11-13).
{
  const scenario = await watchWindowScenario({})
  const enabledSent = () => scenario.bucket.controls.filter(c => c && typeof c.enabled === 'boolean').map(c => c.enabled)
  const button = label => pageAriaPrefix(pageTree(scenario.bucket), label)
  await recordAsync('43. the page header Aura on | Aura off buttons switch with one click and highlight the active one', async () => {
    assert.ok(button('Aura on') && button('Aura off'), 'the page header needs both Aura on and Aura off')
    assert.equal(button('Aura on').props['aria-pressed'], true, 'Aura on is not highlighted while on')
    button('Aura on').props.onClick({ preventDefault() {} })
    await sleep(30)
    assert.deepEqual(enabledSent(), [], 'clicking the active Aura on sent something')
    button('Aura off').props.onClick({ preventDefault() {} })
    await sleep(30)
    assert.deepEqual(enabledSent(), [false], 'one click on Aura off did not turn Aura off')
    await tickPoll(scenario.bucket)
    assert.equal(button('Aura off').props['aria-pressed'], true, 'Aura off is not highlighted while off')
    button('Aura on').props.onClick({ preventDefault() {} })
    await sleep(30)
    assert.deepEqual(enabledSent(), [false, true], 'one click did not turn Aura back on')
  })
  safeDispose('the page header on/off scenario (O)', scenario.dispose)
}

// Scenario P: the Right panel's top row sits in the host's title-bar strip,
// where Electron drag regions eat real mouse clicks (a scripted click still
// works). The panel must opt out like the host's own title-bar buttons do.
{
  const scenario = await watchWindowScenario({})
  record('44. the Right panel is a no-drag region, so its header buttons take real clicks', () => {
    const style = domFind(scenario.pane, node => node.attributes && node.attributes.id === 'aura-panel-style')
    assert.ok(style, 'no panel stylesheet')
    const css = String(style.textContent || '')
    const rule = /#aura-panel\s*\{[^}]*-webkit-app-region:\s*no-drag/.test(css)
    assert.ok(rule, 'the Right panel does not opt out of the host title-bar drag region')
  })
  safeDispose('the no-drag scenario (P)', scenario.dispose)
}

// Scenario Q: the Right panel's position bar. It gets the full width (the time
// moves under it) and can be dragged for fine adjustment, not only clicked.
{
  const scenario = await watchWindowScenario({ videoWindow: false })
  const posted = []
  const frame = hostIframes()[0]
  if (frame) frame.contentWindow = { postMessage: message => posted.push(message) }
  const track = domFind(scenario.pane, node => node.className === 'ap-track')
  pluginModule.wiringTest.video.set({ ...pluginModule.wiringTest.video.get(), duration: 100, position: 10 })
  record('45. the panel position bar has a row of its own', () => {
    const style = domFind(scenario.pane, node => node.attributes && node.attributes.id === 'aura-panel-style')
    const css = String(style && style.textContent || '')
    assert.match(css, /\.ap-scrub\s*\{[^}]*flex-wrap:\s*wrap/, 'the time still shares the row with the position bar')
    assert.match(css, /\.ap-track\s*\{[^}]*flex:\s*1 1 100%/, 'the position bar does not take the full width')
  })
  await recordAsync('46. dragging the panel position bar seeks to where it is let go', async () => {
    assert.ok(track, 'no position bar')
    track.getBoundingClientRect = () => ({ left: 100, top: 0, width: 200, height: 6, right: 300, bottom: 6 })
    const fire = (type, x) => { for (const fn of (track.__handlers && track.__handlers[type]) || []) fn({ clientX: x, pointerId: 1, preventDefault() {} }) }
    fire('pointerdown', 150)
    fire('pointermove', 200)
    fire('pointerup', 200)
    await sleep(20)
    const seeks = posted.filter(m => m && m.cmd === 'seekTo')
    assert.ok(seeks.length >= 1, 'dragging the position bar never seeked')
    assert.equal(Math.round(seeks[seeks.length - 1].value), 50, `let go at the middle, seeked to ${JSON.stringify(seeks)}`)
  })
  record('47. the panel power button says what its second click does', () => {
    const power = domFind(scenario.pane, node => node.className === 'ap-power')
    assert.ok(power, 'no power button')
    clickDom(power)
    assert.equal(power.textContent, 'Turn off?', `armed power button reads "${power.textContent}"`)
  })
  safeDispose('the position bar scenario (Q)', scenario.dispose)
}

// Scenario R: "Frosted glass" off. Hermes's glass rule
// (:root[data-hermes-glass] { background-color: transparent !important })
// beats Aura's solid base, so the frosted window material brightens everything
// behind the visual. Off, Aura's base must win, exactly as on Linux.
{
  const bucket = makeCtx(new Map([['settings', { enabled: true, backdropMode: 'aura', windowVisual: true, panelEnabled: false }]]))
  const dispose = pluginModule.default.register(bucket.ctx)
  await tickPoll(bucket)
  const glassCss = () => {
    const style = headChildren.find(node => node.attributes && node.attributes.id === 'aura-glass')
    return style ? String(style.textContent || '') : null
  }
  const winsOverHostGlass = css => /html:root\[data-hermes-glass\][^{]*\{[^}]*background:[^}]*!important/.test(css || '')
  const imitatesFrost = css => /html:not\(\[data-hermes-glass\]\)[^{]*\{[^}]*background:[^}]*!important/.test(css || '')
  const frostSwitch = () => pageAria(renderDeep(renderContribution(bucket.contributions.find(c => c.area === 'settings.plugins'))), 'Frosted glass')
  record('63. this build does not mount a full-window visual', () => {
    assert.equal(hostIframes().length, 0, 'a visual was painted on the host page')
    assert.equal(glassCss(), null, 'a glass stylesheet was injected')
  })
  record('48. the host page gets no glass stylesheet', () => {
    assert.equal(glassCss(), null, 'a glass stylesheet was injected')
    assert.equal(frostSwitch(), null, 'Frosted glass is still a setting')
  })
  await recordAsync('49. Frosted glass is not a setting in this build', async () => {
    assert.equal(frostSwitch(), null, 'Frosted glass is still a setting')
    assert.equal(glassCss(), null, 'frost injected a stylesheet')
  })
  await recordAsync('56. there is no frost control left to paint over the host', async () => {
    assert.equal(frostSwitch(), null, 'Frosted glass is still a setting')
    assert.equal(glassCss(), null, 'frost injected a stylesheet')
  })
  safeDispose('the frost scenario (R)', dispose)
}

// Scenario R2: builds a970229..019a25c saved `frost: true` as a default nobody
// chose. On a platform without glass (Linux) that must not switch the frost
// look on by itself.
{
  const bucket = makeCtx(new Map([['settings', { enabled: true, backdropMode: 'aura', windowVisual: true, panelEnabled: false, frost: true }]]))
  const dispose = pluginModule.default.register(bucket.ctx)
  await tickPoll(bucket)
  record('65. a stale saved frost default does not turn the frost look on (Linux keeps its look)', () => {
    const style = headChildren.find(node => node.attributes && node.attributes.id === 'aura-glass')
    const css = style ? String(style.textContent || '') : ''
    assert.equal(/html:not\(\[data-hermes-glass\]\)/.test(css), false, 'an old saved default switched the frost look on')
  })
  safeDispose('the stale frost scenario (R2)', dispose)
}

// Scenario S: watch window sizes beyond small/medium/large, and a big one never
// runs past the Right panel or off the window.
{
  const scenario = await watchWindowScenario({ videoWindowSize: 'huge' })
  record('50. the watch window offers five sizes', () => {
    const settingsPage = scenario.bucket.contributions.find(c => c.area === 'settings.plugins')
    const select = pageAria(renderDeep(renderContribution(settingsPage)), 'Watch window size (settings)')
    assert.ok(select, 'no watch window size picker in Aura settings')
    const values = []
    walk(select.props.children, node => { if (node.type === 'option') values.push(node.props.value) })
    assert.deepEqual(values, ['small', 'medium', 'large', 'xlarge', 'huge'])
  })
  record('51. the largest watch window still fits left of the Right panel', () => {
    assert.ok(watchFrame(), 'no watch window')
    const view = globalThis.document.defaultView || {}
    const vw = Number.isFinite(view.innerWidth) ? view.innerWidth : 1400
    const pane = watchPane(scenario.bucket)
    assert.ok(pane, 'the watch window is not a floating pane')
    const width = parseFloat(pane.data.width)
    assert.ok(width <= vw - 440, `the huge watch window is ${width}px wide, wider than the room left of the Right panel`)
  })
  safeDispose('the sizes scenario (S)', scenario.dispose)
}

// Scenario T: Stop (not only pause), page transport as big as the panel's,
// one "Stop everything" switch for when something misbehaves, and REVamp.
{
  const scenario = await watchWindowScenario({ videoWindow: false, audioUrl: 'https://radio.example/stream.mp3' })
  const posted = []
  const frame = hostIframes()[0]
  if (frame) frame.contentWindow = { postMessage: message => posted.push(message) }
  pluginModule.wiringTest.video.set({ ...pluginModule.wiringTest.video.get(), playing: true, duration: 100, position: 40 })

  await recordAsync('52. the Right panel has Stop: it stops the film and closes it', async () => {
    const stop = domFind(scenario.pane, node => node.attributes && node.attributes['aria-label'] === 'Stop')
    assert.ok(stop, 'the Right panel has no Stop button')
    clickDom(stop)
    await sleep(20)
    assert.ok(posted.some(m => m && m.cmd === 'pause'), `Stop did not pause (posted ${JSON.stringify(posted)})`)
    assert.equal(pluginModule.wiringTest.video.get().playing, false, 'Stop left the film marked as playing')
    // Owner, 11-18: Stop must leave the film, not pause it on screen.
    assert.equal(scenario.bucket.storage.get('settings').videoClosed, true, 'Stop left the film open')
    assert.equal((pluginModule.wiringTest.surface().placement || ''), '', 'Stop left a film surface on screen')
  })

  record('53. the Aura page transport is as big as the panel’s, with Stop', () => {
    const tree = pageTree(scenario.bucket)
    const stop = pageAria(tree, 'Stop')
    assert.ok(stop, 'the Aura page has no Stop button')
    const back = pageAria(tree, 'Back 10 seconds')
    assert.ok(back && back.props.style.minWidth >= 38 && back.props.style.height >= 38,
      `page transport buttons are ${back && back.props.style.minWidth}x${back && back.props.style.height}, smaller than the panel's 38`)
    const play = pageAria(tree, 'Play') || pageAria(tree, 'Pause')
    assert.ok(play && play.props.style.height >= 48, 'the page play button is smaller than the panel’s 48')
  })

  await recordAsync('54. Stop everything turns Aura off, stops sound and closes the watch window', async () => {
    const settingsPage = scenario.bucket.contributions.find(c => c.area === 'settings.plugins')
    const button = pageAria(renderDeep(renderContribution(settingsPage)), 'Stop everything')
    assert.ok(button && typeof button.props.onClick === 'function', 'no Stop everything button in Aura settings')
    button.props.onClick({ preventDefault() {} })
    await sleep(40)
    const saved = scenario.bucket.storage.get('settings')
    assert.ok(scenario.bucket.controls.some(c => c && c.enabled === false), 'Stop everything did not turn Aura off')
    assert.equal(saved.audioUrl, '', 'Stop everything left the audio playing')
    assert.notEqual(saved.videoWindow, true, 'Stop everything left the watch window open')
    assert.ok(posted.some(m => m && m.cmd === 'pause'), 'Stop everything did not stop the film')
  })

  record('55. REVamp: find it in Capabilities > Plugins, the marketplace page, or the install command', () => {
    const tree = pageTree(scenario.bucket)
    const find = pageAria(tree, 'Find REVamp in Plugins')
    assert.ok(find, 'no way to open REVamp in Capabilities > Plugins')
    find.props.onClick({ preventDefault() {} })
    assert.equal(sdk.calls.navigations.at(-1), '/capabilities?tab=plugins&plugin=revamp')
    const page = pageAria(tree, 'REVamp marketplace page')
    assert.ok(page && page.props.href === 'https://hermes-agent.nousresearch.com/marketplace', 'no marketplace link')
    let command = false
    walk(tree, node => { if (node.props && node.props.children === 'hermes plugin install revamp') command = true })
    assert.ok(command, 'the install command is not shown')
  })
  safeDispose('the stop scenario (T)', scenario.dispose)
}

// Scenario U: Aura on/off on the status bar itself. Off, the bar shows the
// on/off pill; one click turns Aura on and Visualizer | Video appears beside it.
{
  const bucket = makeCtx(new Map([['settings', { enabled: true, backdropMode: 'aura', panelEnabled: false }]]))
  const dispose = pluginModule.default.register(bucket.ctx)
  await tickPoll(bucket)
  const onBar = label => {
    const item = bucket.contributions.find(c => c.id === 'quick-menu')
    let found = null
    const visit = (node, insideMenu) => {
      if (!node || found) return
      if (Array.isArray(node)) { node.forEach(child => visit(child, insideMenu)); return }
      if (typeof node !== 'object' || !node.props) return
      const nowInside = insideMenu || node.type === sdk.PopoverContent
      if (!nowInside && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith(label)) { found = node; return }
      visit(node.props.children, nowInside)
    }
    visit(renderDeep(renderContribution(item)), false)
    return found
  }
  const inMenu = label => {
    const item = bucket.contributions.find(c => c.id === 'quick-menu')
    return pageAria(renderDeep(renderContribution(item)), label)
  }
  await recordAsync('57. the status bar turns Aura off and on, and shows Visualizer | Video only while on', async () => {
    assert.ok(onBar('Aura mode'), 'Aura is on but the bar has no Visualizer | Video')
    const off = onBar('Aura on')
    assert.ok(off, 'the status bar has no Aura on/off control')
    // One click turns it off (owner, 11-13: no "Turn off?" step on the bar).
    off.props.onClick({ preventDefault() {} })
    await sleep(30)
    await tickPoll(bucket)
    assert.ok(bucket.controls.some(c => c && c.enabled === false), 'the bar did not turn Aura off')
    assert.equal(onBar('Aura mode'), null, 'Visualizer | Video stayed on the bar with Aura off')
    const on = onBar('Aura off')
    assert.ok(on, 'with Aura off the bar has no way to turn it on')
    on.props.onClick({ preventDefault() {} })
    await sleep(30)
    await tickPoll(bucket)
    assert.ok(bucket.controls.some(c => c && c.enabled === true), 'one click on the bar did not turn Aura on')
    assert.ok(onBar('Aura mode'), 'turning Aura on did not bring Visualizer | Video back to the bar')
  })
  await recordAsync('58. the menu’s Aura switch shows the server’s state, not a stale saved one', async () => {
    // Saved says on, the server says off: the switch must say off, or clicking
    // it sends "off" again and looks dead.
    bucket.storage.set('settings', { ...bucket.storage.get('settings'), enabled: true })
    await bucket.ctx.rest('/control', { method: 'POST', body: { enabled: false } })
    await tickPoll(bucket)
    const toggle = inMenu('Aura enabled')
    assert.ok(toggle, 'no Aura switch in the menu')
    assert.equal(toggle.props.checked, false, 'the menu switch says on while the server says off')
  })
  safeDispose('the status-bar power scenario (U)', dispose)
}

// Scenario W: "Pop out" on the Aura page is the watch window inside Hermes,
// like the panel's ⧉ (owner's words: pop out = in Hermes, Desktop = OS window).
// Found live: it opened the desktop window path instead.
{
  const scenario = await watchWindowScenario({ videoWindow: false })
  const routes = []
  const realRest = scenario.bucket.ctx.rest
  scenario.bucket.ctx.rest = async (route, options = {}) => { routes.push(route); return realRest(route, options).catch(() => ({ ok: false })) }
  await recordAsync('64. Pop out on the Aura page opens the watch window, not a desktop window; Bring back closes it', async () => {
    const pop = pageAria(pageTree(scenario.bucket), 'Pop out')
    assert.ok(pop, 'the Aura page has no Pop out')
    pop.props.onClick()
    await sleep(40)
    assert.equal(scenario.bucket.storage.get('settings').videoWindow, true, 'Pop out did not open the watch window')
    assert.ok(!routes.some(r => r.startsWith('/window')), `Pop out went to the desktop window (${routes.filter(r => r.startsWith('/window'))})`)
    const back = pageAria(pageTree(scenario.bucket), 'Bring back')
    assert.ok(back, 'no Bring back while the film is popped out')
    back.props.onClick()
    await sleep(40)
    assert.equal(scenario.bucket.storage.get('settings').videoWindow, false, 'Bring back left the watch window open')
  })
  safeDispose('the page pop-out scenario (W)', scenario.dispose)
}

// Scenario V: off is off. A film in the Right panel, in the watch window or on
// the desktop must stop and disappear when Aura is turned off ("the off
// buttons don't work": the film kept playing).
for (const [name, extra] of [
  ['the Right panel', { videoWindow: false }],
  ['the watch window', { videoWindow: true }]
]) {
  const scenario = await watchWindowScenario(extra)
  await recordAsync(`59. turning Aura off removes the film from ${name}, and its strip`, async () => {
    const live = () => hostIframes().filter(f => f.style.display !== 'none')
    assert.ok(live().length >= 1, `no film in ${name} to begin with`)
    const power = domFind(scenario.pane, node => node.className === 'ap-power')
    clickDom(power)
    clickDom(power)
    await sleep(30)
    await tickPoll(scenario.bucket)
    await tickPoll(scenario.bucket)
    assert.ok(scenario.bucket.controls.some(c => c && c.enabled === false), 'the power button did not turn Aura off')
    assert.equal(live().length, 0, `Aura is off but the film still shows in ${name}`)
    assert.equal(videoBar(), undefined, 'Aura is off but the watch-window strip is still up')
  })
  safeDispose(`the off-is-off scenario (${name})`, scenario.dispose)
}
{
  const scenario = await watchWindowScenario({ videoWindow: false })
  const routes = []
  const realRest = scenario.bucket.ctx.rest
  scenario.bucket.ctx.rest = async (route, options = {}) => {
    routes.push(route)
    if (route === '/window') return { ok: true, available: true, open: false }
    if (route === '/window/open') return { ok: true, open: true }
    if (route === '/window/close') return { ok: true, closed: true }
    if (route.startsWith('/player')) return { ok: true, player: {}, commands: [], seq: 0 }
    return realRest(route, options)
  }
  clickDom(domFind(scenario.pane, node => node.attributes && node.attributes['aria-label'] === 'Watch the film in a desktop window'))
  await sleep(60)
  await recordAsync('60. turning Aura off closes the desktop film window', async () => {
    const power = domFind(scenario.pane, node => node.className === 'ap-power')
    clickDom(power)
    clickDom(power)
    await sleep(40)
    assert.ok(routes.includes('/window/close'), 'Aura is off but the desktop film window stayed open')
  })
  safeDispose('the off closes desktop scenario', scenario.dispose)
}

// Regression (pre-pin review 11-15): a /status already in flight when the user
// pressed Off answered "on" afterwards and put the film back up.
{
  const scenario = await watchWindowScenario({ videoWindow: false })
  const realRest = scenario.bucket.ctx.rest
  let held = null
  scenario.bucket.ctx.rest = async (route, options = {}) => {
    if (route === '/status' && held === 'arm') {
      const stale = await realRest(route, options)
      // Anything else that changed in the same answer (here the capture backend) makes it count.
      return new Promise(resolve => { held = () => resolve({ ...stale, enabled: true, capture: 'stale-backend' }) })
    }
    return realRest(route, options)
  }
  await recordAsync('61. a late /status that says on cannot undo Off', async () => {
    const live = () => hostIframes().filter(f => f.style.display !== 'none')
    assert.ok(live().length >= 1, 'no film in the Right panel to begin with')
    held = 'arm'
    const tick = scenario.bucket.timers.find(t => t.kind === 'interval' && !t.cleared)
    tick.fn()
    await sleep(20)
    assert.equal(typeof held, 'function', 'the stale /status was not held')
    const power = domFind(scenario.pane, node => node.className === 'ap-power')
    clickDom(power)
    clickDom(power)
    await sleep(30)
    assert.ok(scenario.bucket.controls.some(c => c && c.enabled === false), 'the power button did not turn Aura off')
    held()
    held = null
    await sleep(60)
    rerenderFloating()
    assert.equal(live().length, 0, 'a stale /status put the film back after Off')
  })
  safeDispose('the stale status scenario', scenario.dispose)
}

// Same race one await later (Codex verify 11-15): Off pressed while /state is in flight.
{
  const scenario = await watchWindowScenario({ videoWindow: false })
  const realRest = scenario.bucket.ctx.rest
  let held = null
  scenario.bucket.ctx.rest = async (route, options = {}) => {
    if (route === '/status' && held === 'arm') {
      const stale = await realRest(route, options)
      held = 'state'
      return { ...stale, enabled: true, capture: 'stale-backend-2' }
    }
    if (route === '/state' && held === 'state') {
      const frame = await realRest(route, options)
      return new Promise(resolve => { held = () => resolve(frame) })
    }
    return realRest(route, options)
  }
  await recordAsync('61b. Off pressed while /state is in flight also wins', async () => {
    const live = () => hostIframes().filter(f => f.style.display !== 'none')
    assert.ok(live().length >= 1, 'no film in the Right panel to begin with')
    held = 'arm'
    const tick = scenario.bucket.timers.find(t => t.kind === 'interval' && !t.cleared)
    tick.fn()
    await sleep(20)
    assert.equal(typeof held, 'function', 'the /state answer was not held')
    const power = domFind(scenario.pane, node => node.className === 'ap-power')
    clickDom(power)
    clickDom(power)
    await sleep(30)
    held()
    held = null
    await sleep(60)
    rerenderFloating()
    assert.equal(live().length, 0, 'an answer that was in flight during Off put the film back')
  })
  safeDispose('the stale state scenario', scenario.dispose)
}

// Found in review (11-14): turning Aura off while the desktop window was still
// open let the next poll "adopt" the window again, and a slow or failed close was
// never retried, so the OS window kept playing with Aura shown off.
{
  const scenario = await watchWindowScenario({ videoWindow: false })
  const routes = []
  let windowOpen = false
  const realRest = scenario.bucket.ctx.rest
  scenario.bucket.ctx.rest = async (route, options = {}) => {
    routes.push(route)
    if (route === '/window') return { ok: true, available: true, open: windowOpen }
    if (route === '/window/open') { windowOpen = true; return { ok: true, open: true } }
    if (route === '/window/close') return { ok: false, error: 'busy' }  // the close fails
    if (route === '/player') return { ok: true, player: {}, seq: 0, window: { ok: true, open: windowOpen, available: true } }
    if (route.startsWith('/player')) return { ok: true, player: {}, commands: [], seq: 0 }
    return realRest(route, options)
  }
  clickDom(domFind(scenario.pane, node => node.attributes && node.attributes['aria-label'] === 'Watch the film in a desktop window'))
  await sleep(60)
  await tickPoll(scenario.bucket)
  await recordAsync('60b. with Aura off, a desktop window that is still open is closed again, never adopted', async () => {
    const power = domFind(scenario.pane, node => node.className === 'ap-power')
    clickDom(power)
    clickDom(power)
    await sleep(40)
    const closesBefore = routes.filter(r => r === '/window/close').length
    for (let i = 0; i < 4; i += 1) await tickPoll(scenario.bucket)
    const closesAfter = routes.filter(r => r === '/window/close').length
    assert.ok(closesAfter > closesBefore, 'Aura is off, the desktop window is still open, and nothing tried to close it again')
  })
  safeDispose('the off retries desktop close scenario', scenario.dispose)
}

// Found in review (11-14): with the desktop window open, "Watch in: Window" closed
// the desktop window and then the close handoff switched the watch window back off,
// so the film landed in the Right panel instead.
{
  const scenario = await watchWindowScenario({ videoWindow: false })
  let windowOpen = false
  const realRest = scenario.bucket.ctx.rest
  scenario.bucket.ctx.rest = async (route, options = {}) => {
    if (route === '/window') return { ok: true, available: true, open: windowOpen }
    if (route === '/window/open') { windowOpen = true; return { ok: true, open: true } }
    if (route === '/window/close') { windowOpen = false; return { ok: true, closed: true } }
    if (route === '/player') return { ok: true, player: {}, seq: 0, window: { ok: true, open: windowOpen, available: true } }
    if (route.startsWith('/player')) return { ok: true, player: {}, commands: [], seq: 0 }
    return realRest(route, options)
  }
  clickDom(domFind(scenario.pane, node => node.attributes && node.attributes['aria-label'] === 'Watch the film in a desktop window'))
  await sleep(60)
  await tickPoll(scenario.bucket)
  await recordAsync('60c. from the desktop window, Watch in: Window ends in the watch window', async () => {
    clickDom(domFind(scenario.pane, node => node.attributes && node.attributes['aria-label'] === 'Watch the film in the watch window'))
    await sleep(60)
    for (let i = 0; i < 3; i += 1) await tickPoll(scenario.bucket)
    const saved = scenario.bucket.storage.get('settings') || {}
    assert.equal(windowOpen, false, 'the desktop window stayed open')
    assert.equal(saved.videoWindow, true, 'the film did not end in the watch window')
  })
  safeDispose('the desktop to window scenario', scenario.dispose)
}

// Found in review (11-14): with the Right panel hidden and the film in the watch
// window, nothing counted the watch window as a surface, so the film unmounted
// while its strip stayed up with buttons posting into nothing.
{
  const bucket = makeCtx(new Map([['settings', {
    enabled: true, backdropMode: 'video', panelEnabled: false, videoWindow: true,
    windowVisual: false, videoUrl: SINTEL_URL
  }]]))
  const scenario = { bucket, dispose: pluginModule.default.register(bucket.ctx) }
  for (let i = 0; i < 3; i += 1) {
    await tickPoll(scenario.bucket)
    renderDeep(renderContribution(bucket.contributions.find(c => c.id === 'quick-menu')))
  }
  record('60d. with the Right panel hidden, a film in the watch window stays on screen', () => {
    assert.ok(watchFrame(), 'the Right panel is hidden and the watch-window film unmounted')
  })
  safeDispose('the hidden panel watch window scenario', scenario.dispose)
}

// Found in review (11-14): the watch window was only clamped to the width left of
// the panel, so Huge (1120 px, 630 tall) ran off the bottom of a short window.
{
  // The fake document has no window: give it a 1400x600 one for this case only.
  const hadView = Object.prototype.hasOwnProperty.call(globalThis.document, 'defaultView')
  const realView = globalThis.document.defaultView
  globalThis.document.defaultView = { innerWidth: 1400, innerHeight: 600 }
  const scenario = await watchWindowScenario({ videoWindow: true, videoWindowSize: 'huge' })
  for (let i = 0; i < 2; i += 1) await tickPoll(scenario.bucket)
  record('60e. a Huge watch window fits a short window', () => {
    assert.ok(watchFrame(), 'no watch window')
    const pane = watchPane(scenario.bucket)
    assert.ok(pane, 'the watch window is not a floating pane')
    const height = parseFloat(pane.data.height)
    assert.ok(height <= 600 - 34, `the watch window pane is ${height}px tall in a 600 px window`)
  })
  safeDispose('the short window scenario', scenario.dispose)
  if (hadView) globalThis.document.defaultView = realView
  else delete globalThis.document.defaultView
}

// ===================================================================
// Scenario I: "Watch in: Panel | Behind chat". With the Right panel open the
// film can play behind the chat while the panel stays the remote, without a
// second picture in the panel.
// ===================================================================

async function watchInScenario(filmBehind) {
  const bucket = makeCtx(new Map([['settings', {
    enabled: true, backdropMode: 'video', panelEnabled: true, windowVisual: false, filmBehind,
    videoUrl: SINTEL_URL, videoOpacity: 0.25, videoOpacityAuto: false
  }]]))
  const dispose = pluginModule.default.register(bucket.ctx)
  await tickPoll(bucket)
  const pane = mountPane(bucket)
  const panelBox = domFind(pane, node => node.attributes && node.attributes.id === 'aura-panel')
  const stage = domFind(pane, node => node.className === 'ap-stage')
  if (panelBox) panelBox.getBoundingClientRect = () => ({ left: 1180, top: 40, width: 340, height: 760, right: 1520, bottom: 800 })
  if (stage) stage.getBoundingClientRect = () => ({ left: 1200, top: 90, width: 300, height: 170, right: 1500, bottom: 260 })
  await tickPoll(bucket)
  const seeThrough = domFind(pane, node => node.attributes && node.attributes['aria-label'] === '25% video strength')
  const seeThroughRow = seeThrough && seeThrough.parentNode && seeThrough.parentNode.parentNode
  return { bucket, dispose, pane, stage, seeThroughRow }
}

{
  const behind = await watchInScenario(true)
  record('15. an old Behind chat setting keeps the film in the panel', () => {
    assert.equal(bodyChildren.filter(node => node.tagName === 'IFRAME').length, 0,
      'Behind chat appended an iframe to document.body')
    assert.equal(pluginModule.wiringTest.surface().placement, 'panel', 'the film left the panel')
    const frame = pluginModule.wiringTest.frame()
    assert.ok(frame, 'no in-pane film')
    assert.notEqual(String(frame.style.zIndex), '-1', 'the film was placed behind the app')
    assert.equal(String(frame.style.opacity || '1'), '1', 'the panel film is not at full strength')
  })
  record('16. Behind chat no longer hides the panel stage', () => {
    assert.ok(behind.stage, 'the panel has no stage')
    assert.notEqual(behind.stage.style.display, 'none', 'the panel hid the stage')
    assert.equal(behind.seeThroughRow, null, 'the see-through row is still in the panel')
  })
  safeDispose('the behind-chat scenario (I)', behind.dispose)
}

{
  const inPanel = await watchInScenario(false)
  record('17. Panel: the film plays in the Right panel at full strength', () => {
    assert.equal(bodyChildren.filter(node => node.tagName === 'IFRAME').length, 0,
      'the panel film was appended to document.body')
    const frame = pluginModule.wiringTest.frame()
    assert.ok(frame, 'no in-pane film')
    assert.notEqual(String(frame.style.zIndex), '-1', 'the film went behind the app')
    assert.equal(String(frame.style.opacity || '1'), '1', 'the panel film is not at full strength')
    assert.equal(inPanel.seeThroughRow, null, 'the see-through row is still in the panel')
  })
  await recordAsync('18. the panel has no Behind chat choice', async () => {
    const button = domFind(inPanel.pane, node => node.attributes && node.attributes['aria-label'] === 'Watch the film behind the chat')
    assert.equal(button, null, 'the panel still offers Behind chat')
    assert.notEqual(inPanel.bucket.storage.get('settings').filmBehind, true, 'the film was sent behind the chat')
  })
  safeDispose('the in-panel scenario (I)', inPanel.dispose)
}

// ===================================================================
// Scenario D: pop out from the page / bring back on a fresh install.
// (Test 7)
// ===================================================================

const freshD = makeCtx()
const disposeD = pluginModule.default.register(freshD.ctx)
await tickPoll(freshD)

await recordAsync('7. fresh install: Pop out from the page moves the film to the floating watch window, Bring back returns it', async () => {
  let tree = pageTree(freshD)
  let stageRef = null
  walk(tree, node => {
    if (!stageRef && node.props && typeof node.props.ref === 'function') stageRef = node.props.ref
  })
  assert.ok(typeof stageRef === 'function', 'the page has no stage ref')
  stageRef({ getBoundingClientRect: () => ({ left: 40, top: 60, width: 800, height: 450 }) })

  // A new user picks a film on the page (that is how they got here).
  const card = pageAria(pageTree(freshD), 'Play Sintel · Blender film')
  assert.ok(card, 'the page does not offer the starter sources')
  card.props.onClick()
  await sleep(60)
  pageTree(freshD)

  const onPage = () => {
    const surface = pluginModule.wiringTest.surface()
    return surface && surface.placement === 'page'
      ? hostIframes().filter(frame => frame.style.position === 'absolute' && frame.style.width === '100%')
      : []
  }
  assert.equal(onPage().length, 1, 'the picked film did not land on the page stage')
  assert.equal(onPage()[0].style.zIndex, '1', 'the page film must sit above the page')

  // Pop out: the film leaves the page and becomes the floating watch window.
  // Pop out asks the host for a real OS window first; this host cannot give one,
  // so the film settles in the in-app watch window. Both steps are async.
  const pop = pageAria(pageTree(freshD), 'Pop out')
  assert.ok(pop, 'the page has no Pop out button')
  pop.props.onClick()
  await sleep(80)
  renderDeep(renderContribution(freshD.contributions.find(c => c.id === 'quick-menu')))
  assert.equal(onPage().length, 0, 'Pop out left the film on the page')
  // The watch window floats above the app (not behind it at -1, not on the page
  // stage at 1) and still below the host's menus.
  rerenderFloating()
  assert.ok(watchFrame(), 'Pop out did not hand the film to the floating watch window')
  assert.ok(watchPane(freshD), 'the watch window is not an SDK floating pane')
  // Its own card id: the host remembers "collapsed" per id, and a strip the user
  // once collapsed made every pop-out open collapsed (owner, 11-15).
  assert.equal(watchPane(freshD).id, 'watch', 'the watch window shares a card id with something else')
  assert.equal(freshD.storage.get('settings').videoWindow, true, 'the watch window was not persisted')

  // Bring back: the same single player returns to the page stage.
  const back = pageAria(pageTree(freshD), 'Bring back')
  assert.ok(back, 'a popped-out film offers no Bring back')
  back.props.onClick()
  await sleep(80)
  pageTree(freshD)
  assert.equal(onPage().length, 1, 'Bring back did not return the film to the page')
  assert.equal(freshD.storage.get('settings').videoWindow, false, 'bring-back did not persist')
  assert.equal(hostIframes().length, 1, 'pop out / bring back grew a second player')
  stageRef(null)
})

safeDispose('the pop-out scenario (D)', disposeD)

// ===================================================================
// Scenario E: a pasted playlist link persists and survives dispose +
// re-register on the SAME storage. (Test 8)
// ===================================================================

const freshE = makeCtx()
const disposeE = pluginModule.default.register(freshE.ctx)
await tickPoll(freshE)

await recordAsync('8. fresh install: pasting a YouTube playlist link on the page saves it to videoPlaylists, and it survives dispose + re-register with the same storage', async () => {
  const input = pageAria(pageTree(freshE), 'Film URL')
  assert.ok(input, 'the page has no Film URL input')
  // A real paste: focus, type, leave the field (the field ignores a blur it never saw focused).
  const field = { value: '' }
  if (typeof input.props.onFocus === 'function') input.props.onFocus({ currentTarget: field, target: field })
  field.value = PLAYLIST_URL
  input.props.onBlur({ currentTarget: field, target: field })
  await sleep(70)

  const saved = freshE.storage.get('settings')
  assert.ok(Array.isArray(saved.videoPlaylists), 'videoPlaylists was not saved as a list')
  assert.equal(saved.videoPlaylists.length, 1, `expected exactly one saved playlist, got ${JSON.stringify(saved.videoPlaylists)}`)
  assert.equal(saved.videoPlaylists[0].url, PLAYLIST_URL, 'the pasted playlist url was not persisted verbatim')
  assert.match(saved.videoPlaylists[0].label, /YouTube playlist/, 'the saved playlist has no readable label')

  // Same storage, brand-new registration (what a reload/restart does).
  disposeE()
  const again = makeCtx(freshE.storage)
  const disposeAgain = pluginModule.default.register(again.ctx)
  await tickPoll(again)

  const after = again.storage.get('settings')
  assert.equal(Array.isArray(after.videoPlaylists) && after.videoPlaylists.length, 1, 'the playlist did not survive dispose + re-register')
  assert.equal(after.videoPlaylists[0].url, PLAYLIST_URL, 'the surviving playlist lost its url')
  const chip = pageAriaPrefix(pageTree(again), 'Play ')
  const listChip = (() => {
    let found = null
    walk(pageTree(again), node => {
      if (!found && (node.type === 'button' || (node.props && node.props.role === 'button')) && node.props && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].includes('playlist')) found = node
    })
    return found
  })()
  assert.ok(listChip, `the re-registered plugin does not offer the saved playlist (${JSON.stringify((chip && chip.props['aria-label']) || null)})`)
  disposeAgain()
})

// ===================================================================
// Scenario F: dispose leaves nothing behind. (Test 9)
// ===================================================================

const freshF = makeCtx()
const disposeF = pluginModule.default.register(freshF.ctx)

await recordAsync('9. fresh install: dispose leaves nothing behind - no contributions, no timers, no listeners, no iframes', async () => {
  await tickPoll(freshF)
  const hostNode = mountPane(freshF)

  // Live a little first: a new user picks a film so a player and the video
  // bar actually exist and have to be taken down.
  const card = pageAria(pageTree(freshF), 'Play Sintel · Blender film')
  assert.ok(card, 'no starter source to pick')
  card.props.onClick()
  await sleep(60)
  mountPane(freshF)
  assert.ok(hostIframes().length >= 1, 'precondition: no player mounted to clean up')
  const timersStarted = freshF.timers.length
  assert.ok(freshF.listeners.length > 0, 'precondition: no host listener was registered')
  assert.ok(timersStarted > 0, 'precondition: no host timer was registered')

  disposeF()

  assert.equal(freshF.contributions.length, 0, 'a contribution survived dispose')
  assert.ok(freshF.timers.every(t => t.cleared), 'a timer survived dispose')
  assert.ok(freshF.listeners.every(t => t.removed), 'a listener survived dispose')
  assert.equal(hostIframes().length, 0, 'an iframe survived dispose')
  assert.equal(hostStyles().length, 0, 'a host stylesheet survived dispose')
  assert.equal(headChildren.length, 0, `a stylesheet survived dispose (${headChildren.map(n => n.attributes && n.attributes.id).join(', ')})`)
  assert.equal(videoBar(), undefined, 'the video control strip survived dispose')
  assert.equal(panelCards(hostNode).length, 0, 'the panel DOM survived dispose inside the pane box')
  assert.equal(hostNode.children.length, 0, 'the panel node survived inside the pane box')
  assert.doesNotThrow(() => disposeF(), 'dispose is not idempotent')
})

// ===================================================================
// Scenario G: installing a build turns Aura on. (Tests 13-14)
// The owner reinstalled Aura and saw nothing: a saved "off" from an older
// build survived the reinstall, so Aura looked "not installed".
// ===================================================================

await recordAsync('13. a newly installed build turns Aura on, even when the saved settings and the server said off', async () => {
  const storage = new Map([
    ['settings', { enabled: false }],
    ['seenBuild', 'olderbuild0000000']
  ])
  const g = makeCtx(storage, { serverEnabled: false, commit: 'newbuild11111111' })
  const dispose = pluginModule.default.register(g.ctx)
  await sleep(60)
  await tickPoll(g)
  assert.equal(g.storage.get('settings').enabled, true, 'the saved "off" from the older build survived the new install')
  assert.ok(g.controls.some(body => body && body.enabled === true), 'the new build never told the server to switch Aura on')
  assert.equal(g.serverEnabled(), true, 'the server is still off after the new build loaded')
  assert.equal(g.storage.get('seenBuild'), 'newbuild11111111', 'the new build was not remembered, so it would switch Aura on at every start')
  dispose()
})

await recordAsync('14. restarting the same build keeps the owner\'s own "off"', async () => {
  const storage = new Map([
    ['settings', { enabled: false }],
    ['seenBuild', 'samebuild2222222']
  ])
  const g = makeCtx(storage, { serverEnabled: false, commit: 'samebuild2222222' })
  const dispose = pluginModule.default.register(g.ctx)
  await sleep(60)
  await tickPoll(g)
  assert.equal(g.storage.get('settings').enabled, false, 'a restart switched Aura back on although the owner turned it off on this build')
  assert.ok(!g.controls.some(body => body && body.enabled === true), 'a restart told the server to switch Aura on')
  dispose()
})

// Regression (pre-pin review 11-15): an update must never switch Aura back on
// after the USER turned it off (catalog: no re-enabling against the user's choice).
await recordAsync('14b. an update keeps an Off the user chose; it only overrides an off nobody chose', async () => {
  const storage = new Map([
    ['settings', { enabled: true }],
    ['seenBuild', 'userbuild3333333']
  ])
  const g = makeCtx(storage, { commit: 'userbuild3333333' })
  const dispose = pluginModule.default.register(g.ctx)
  await sleep(60)
  await tickPoll(g)
  const quick = g.contributions.find(c => c.area === 'settings.plugins')
  const enabledSwitch = findByAria(renderContribution(quick), 'Aura enabled')
  assert.ok(enabledSwitch, 'no Aura enabled switch')
  enabledSwitch.props.onCheckedChange(false)
  await sleep(60)
  assert.equal(g.storage.get('settings').enabled, false, 'precondition: the user switched Aura off')
  assert.equal(g.storage.get('userChoseOff'), true, 'the user\'s Off was not remembered as a choice')
  dispose()

  const next = makeCtx(g.storage, { serverEnabled: false, commit: 'updatedbuild4444' })
  const disposeNext = pluginModule.default.register(next.ctx)
  await sleep(60)
  await tickPoll(next)
  assert.equal(next.storage.get('settings').enabled, false, 'an update switched Aura back on against the user\'s Off')
  assert.ok(!next.controls.some(body => body && body.enabled === true), 'an update told the server to switch Aura on')
  disposeNext()
})

// ===================================================================
// Scenario H: the floating controls card is never left empty. (Test 15)
// The host can unmount the OLD floating pane after it mounted the NEW one
// (switching strip <-> watch window re-registers the pane). The old pane's
// ref(null) must not pull the strip out of the new card.
// ===================================================================

await recordAsync('15. the floating controls card keeps its strip when the old card unmounts after the new one mounted', async () => {
  const g = makeCtx()
  const dispose = pluginModule.default.register(g.ctx)
  await sleep(40)
  await tickPoll(g)
  // Tray life: a film playing with the Right panel closed -> the strip lives in a floating card.
  const pane = g.contributions.find(c => c.area === 'panes' && c.id !== 'watch' && c.id !== 'strip')
  const card = pageAria(pageTree(g), 'Play Sintel · Blender film')
  assert.ok(card, 'no starter film to play')
  card.props.onClick()
  await sleep(60)
  const quick = g.contributions.find(c => c.area === 'settings.plugins')
  const panelSwitch = findByAria(renderDeep(renderContribution(quick)), 'Right panel')
  if (panelSwitch && panelSwitch.props.checked) panelSwitch.props.onCheckedChange(false)
  await sleep(40)
  await tickPoll(g)
  const watch = watchPane(g)
  assert.ok(watch, 'precondition: no floating controls card with the Right panel closed')
  assert.ok(videoBar(), 'precondition: the strip is not on screen')
  assert.equal(watch.id, 'strip', 'the controls strip shares its card id with the watch window, so a collapsed strip makes pop-outs open collapsed')

  assert.equal(typeof watch.unmountCard, 'function', 'precondition: the test host cannot unmount the card on its own')

  // The host draws the NEW card first (same contribution, fresh DOM) and drops
  // the OLD card a moment later, as React may when the pane is re-registered.
  const firstHosts = floatingHosts.slice()
  const unmountSecond = mountFloatingPane({ ...watch })
  const newHost = floatingHosts.find(h => !firstHosts.includes(h))
  assert.ok(newHost, 'precondition: the second card got no host node')
  assert.ok(newHost.children.includes(videoBar()), 'precondition: the strip did not move into the new card')
  watch.unmountCard()   // the OLD card's refs get null, after the new card mounted

  const bar = videoBar()
  assert.ok(bar, 'the strip vanished from the screen: the old card took it out of the new one (blank controls)')
  assert.ok(newHost.children.includes(bar), 'the new floating card is empty: the strip is not inside it')
  if (unmountSecond) unmountSecond()
  dispose()
})

await recordAsync('16. a strip that floated on its own drops its screen position when a card takes it', async () => {
  // Seen live on Windows: the strip still carried left:614px / top:398px from
  // floating on its own, so inside the card it sat 614px right and 398px down,
  // clipped out of view, and the card looked blank.
  const g = makeCtx()
  const dispose = pluginModule.default.register(g.ctx)
  await sleep(40)
  await tickPoll(g)
  const card = pageAria(pageTree(g), 'Play Sintel · Blender film')
  card.props.onClick()
  await sleep(60)
  const quick = g.contributions.find(c => c.area === 'settings.plugins')
  const panelSwitch = findByAria(renderDeep(renderContribution(quick)), 'Right panel')
  if (panelSwitch && panelSwitch.props.checked) panelSwitch.props.onCheckedChange(false)
  await sleep(40)
  await tickPoll(g)
  const watch = watchPane(g)
  const bar = videoBar()
  assert.ok(watch && bar, 'precondition: no floating card with its strip')
  // The strip floated on its own for a moment (between two cards) and got a screen position.
  bar.style.left = '614px'
  bar.style.top = '398px'
  const unmountSecond = mountFloatingPane({ ...watch })
  assert.equal(bar.style.left, '', `inside the card the strip still sits ${bar.style.left} from the card's left edge`)
  assert.equal(bar.style.top, '', `inside the card the strip still sits ${bar.style.top} below the card's top`)
  // And a layout tick while the card is up must not write a screen position again.
  await tickPoll(g)
  assert.equal(bar.style.left, '', 'a layout tick gave the strip a screen position inside the card')
  if (unmountSecond) unmountSecond()
  dispose()
})

// --------------------------------------------------------------- reporting

console.log(results.join('\n'))
console.log(`\n${results.length - failed} passed, ${failed} failed`)

try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch {
  // the scratch dir is pruned anyway
}

if (failed > 0) process.exitCode = 1
