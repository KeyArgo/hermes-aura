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
 *      it (storage backdropMode 'video', videoUrl set, /control backdrop_mode,
 *      and the one SandboxedFrame the pane draws pointing at the player page).
 *   6. Picking a starter film from the RIGHT PANEL does the same (this was
 *      known bug #3 — the panel click applied the source but never flipped the
 *      backdrop mode — and it is fixed).
 *   7. "Frame in Hermes" from the page moves the film to the floating watch
 *      window; the same button brings it back.
 *   8. Pasting a YouTube PLAYLIST link on the page saves it to videoPlaylists
 *      (persisted), and it survives dispose + re-register with the same
 *      storage.
 *   9. Dispose leaves nothing behind: contributions, timers, listeners, frames.
 *
 * The harness is self-contained and mirrors tests/test_desktop_plugin.mjs: a
 * temp copy of the plugin has its three import specifiers rewritten to local
 * stub modules (@hermes/plugin-sdk, react, react/jsx-runtime), a fake DOM
 * stands in for document/getComputedStyle, makeCtx provides the host ctx
 * (contributions, timers, listeners, storage, /status /state /control /version
 * stubs) and the whole file reports with an "N passed, M failed" line.
 *
 * The film is an SDK SandboxedFrame rendered inside Aura's own surfaces, not an
 * iframe on the app body: the stub records every frame it is handed in
 * `globalThis.__sdkFrames`, and a test renders a contribution the way React does
 * before asserting on it.
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

function renderContribution(contribution) {
  const element = contribution.render()
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
function makeCtx(storageMap) {
  const contributions = []
  const timers = []
  const controls = []
  const requests = []
  const disposers = []
  const listeners = []
  const storage = storageMap || new Map()
  // Mirrors the real server. A fresh install has never touched /control, so
  // the server is on with exactly the product defaults.
  let serverEnabled = true
  const serverSettings = {
    motion: 'agent_music',
    behavior: 'balanced',
    intensity: 0.25,
    opacity: 0.25,
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
      return () => {
        if (entry.removed) return
        entry.removed = true
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
          commit: 'abcdef1234567890',
          commit_short: 'abcdef12',
          commit_date: '2026-11-09',
          channel: 'dev',
          dirty: false
        }
      }
      throw new Error(`unexpected route ${route}`)
    }
  }

  return { ctx, contributions, timers, controls, disposers, listeners, requests, storage, serverSettings, serverFrame }
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

fs.writeFileSync(pluginCopy, rewritten)

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

// The composer seams, as the real SDK names them.
export const COMPOSER_AREAS = {
  top: 'composer.top', bottom: 'composer.bottom', underside: 'composer.underside',
  leading: 'composer.leading', actions: 'composer.actions', middleware: 'composer.middleware',
  attachments: 'composer.attachments', microActions: 'composer.microActions',
  atCompletions: 'composer.atCompletions', modelPill: 'composer.modelPill', contextMenu: 'composer.contextMenu'
}

// The SDK's sandboxed frame. The film is drawn by THIS element (React), never
// by a raw iframe appended to the app body, so the stub records the src/title it
// was handed for a test to assert against.
export const frames = []
globalThis.__sdkFrames = frames
export const SandboxedFrame = props => { frames.push(props); return null }
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
const documentElement = { style: {} }
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

const hostIframes = () => bodyChildren.filter(node => node.tagName === 'IFRAME')
// The film is drawn by the SDK's SandboxedFrame inside Aura's own surface (never
// an iframe appended to the app body), so a test renders a contribution the way
// React does; the stub records each frame it is handed.
const framesNow = () => globalThis.__sdkFrames
const clearFrames = () => { globalThis.__sdkFrames.length = 0 }
const playerFrames = () => framesNow().filter(props => String(props.src || '').includes('/player.html'))
function renderSurface(bucket, id) {
  const contribution = bucket.contributions.find(entry => entry.id === id)
  assert.ok(contribution, `no '${id}' contribution to render`)
  return renderDeep(renderContribution(contribution))
}
// The panel/page stylesheets are product surfaces (id 'aura-panel-style' /
// 'aura-ui-style'), not host injections; the guarded "effect" styles are the
// glass and theme injections the other suite covers.
const UI_STYLE_IDS = new Set(['aura-panel-style', 'aura-ui-style'])
const hostStyles = () => headChildren.filter(node => node.tagName === 'STYLE' && !UI_STYLE_IDS.has(node.attributes && node.attributes.id))
const videoBar = () => bodyChildren.find(node => node.attributes && node.attributes.role === 'toolbar')

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
const PLAYLIST_URL = 'https://youtube.com/playlist?list=PLabcdefghij&si=x'

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
  const tree = renderContribution(pane)
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
}

// ===================================================================
// Scenario A: a brand-new user, EMPTY storage, server reachable.
// (Tests 1-4 run against this one registration.)
// ===================================================================

const freshA = makeCtx()
const storageWasEmptyAtBoot = !freshA.storage.has('settings')
const disposeA = pluginModule.default.register(freshA.ctx)
await sleep(50)

await recordAsync('1. fresh install: Aura is enabled by default and the Right panel is a video-mode surface', async () => {
  assert.ok(storageWasEmptyAtBoot, 'the scenario did not start from EMPTY storage (no "settings" key)')
  assert.equal(freshA.requests.some(r => r.route === '/status'), true, 'the plugin never asked the server /status')

  // Enabled by default: the settings row shows Aura on, the quick menu too.
  const settings = freshA.contributions.find(c => c.area === 'settings.plugins')
  assert.ok(settings, 'no settings page contribution')
  const enabledSwitch = findByAria(renderContribution(settings), 'Aura enabled')
  assert.ok(enabledSwitch, 'the settings page has no Aura enabled switch')
  assert.equal(enabledSwitch.props.checked, true, 'Aura is not enabled by default on a fresh install')

  // A fresh install is in VISUALISER mode, and the Right panel is a video
  // surface: the owner's rule ("if you aren't in video mode the right panel
  // should automatically disappear") means there is no panel here at all.
  assert.equal(freshA.contributions.find(c => c.area === 'panes'), undefined,
    'a fresh install (visualiser mode) contributes a Right panel')

  // …and video mode brings it back on its own, docked right and enforced.
  await pluginModule.__test.setBackdropMode('video')
  const pane = freshA.contributions.find(c => c.area === 'panes')
  assert.ok(pane, 'video mode did not bring the Right panel back')
  assert.equal(pane.id, 'panel')
  assert.equal(pane.data.placement, 'right', 'the pane must prefer the right')
  assert.deepEqual(
    pane.data.dock,
    { pane: 'workspace', pos: 'right', enforce: true },
    'a new user must get the pane docked right even if their layout disagrees'
  )

  // Leaving video mode takes it away again, without a restart.
  await pluginModule.__test.setBackdropMode('aura')
  assert.equal(freshA.contributions.find(c => c.area === 'panes'), undefined,
    'the Right panel stayed after visualiser mode came back')
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

await recordAsync('4. fresh install: the starter films are offered on the page, and in the panel once video mode is on', async () => {
  const tree = pageTree(freshA)
  const chips = []
  walk(tree, node => {
    if ((node.type === 'button' || (node.props && node.props.role === 'button')) && node.props && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith('Play ')) {
      chips.push(node.props['aria-label'])
    }
  })
  assert.ok(chips.length >= 20, `expected the expanded starter pack on the page, got ${chips.length}: ${JSON.stringify(chips)}`)
  assert.ok(chips.includes('Play Sintel · Blender film'), 'Sintel is not offered on the page')
  assert.ok(chips.includes('Play Big Buck Bunny · Blender film'), 'Big Buck Bunny is not offered on the page')

  // The Right panel is a video surface, so a fresh install has none to mount:
  // the starter list has to be there in video mode, where the panel lives.
  assert.equal(freshA.contributions.find(c => c.area === 'panes'), undefined,
    'the Right panel is contributed in visualiser mode')
  await pluginModule.__test.setBackdropMode('video')
  const hostNode = mountPane(freshA)
  const cards = panelCards(hostNode)
  // The A menu's card list is capped at PANEL_SCORE_MAX (12) sources.
  assert.equal(cards.length, Math.min(12, chips.length), `expected ${Math.min(12, chips.length)} starter cards in the pane, got ${cards.length}`)
  assert.ok(cards.some(card => cardTitle(card).includes('Sintel')), 'the pane card list has no Sintel')
  const kinds = domFindAll(hostNode, node => node.className === 'ap-kind').map(node => node.textContent)
  assert.ok(kinds.includes('youtube'), 'the pane does not label the starter cards as youtube sources')
  await pluginModule.__test.setBackdropMode('aura')
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
  // "plays it": ONE player, drawn by the pane's own SandboxedFrame and pointing
  // at the local video player page for the picked film.
  clearFrames()
  renderSurface(freshB, 'panel')
  const frames = playerFrames()
  assert.equal(frames.length, 1, `the page pick should mount exactly one player, got ${frames.length}`)
  assert.match(frames[0].src, /player\.html/)
  assert.ok(decodeURIComponent(frames[0].src).includes(SINTEL_URL), 'the player is not showing the picked film')
})

safeDispose('the page-pick scenario (B)', disposeB)

// ===================================================================
// Scenario C: a new user picks a starter film from the RIGHT PANEL.
// (Test 6 — the panel only exists in video mode now, which is where a user
// with a film open picks their next one.)
// ===================================================================

const freshC = makeCtx()
const disposeC = pluginModule.default.register(freshC.ctx)
await tickPoll(freshC)

await recordAsync('6. fresh install: picking a starter film from the RIGHT PANEL plays it in the panel', async () => {
  // No panel in visualiser mode; video mode is what puts one on screen.
  assert.equal(freshC.contributions.find(c => c.area === 'panes'), undefined,
    'the Right panel is contributed in visualiser mode')
  await pluginModule.__test.setBackdropMode('video')
  const hostNode = mountPane(freshC)
  const cards = panelCards(hostNode)
  const sintel = cards.find(card => cardTitle(card).includes('Sintel'))
  assert.ok(sintel, 'the pane card list does not offer the starter sources')
  clickDom(sintel)
  await sleep(60)
  const saved = freshC.storage.get('settings')
  assert.ok(saved, 'a pane pick never persisted any settings')
  assert.equal(saved.videoUrl, SINTEL_URL, 'the pane pick did not save the picked film url')
  assert.equal(saved.backdropMode, 'video', 'the pane pick did not keep video mode: the pane shows a stage that plays nothing')
  assert.ok(
    freshC.controls.some(patch => patch && patch.backdrop_mode === 'video'),
    `no /control patch with backdrop_mode 'video' from the pane (got ${JSON.stringify(freshC.controls)})`
  )
  // "plays it": the one frame inside the panel is the local player page for the
  // picked film.
  clearFrames()
  renderSurface(freshC, 'panel')
  const frames = playerFrames()
  assert.equal(frames.length, 1, `the pane pick should mount exactly one player, got ${frames.length}`)
  assert.ok(decodeURIComponent(frames[0].src).includes(SINTEL_URL), 'the panel player is not showing the picked film')
})

safeDispose('the pane-pick scenario (C)', disposeC)

// ===================================================================
// Scenario D: pop out from the page / bring back on a fresh install.
// (Test 7)
// ===================================================================

const freshD = makeCtx()
const disposeD = pluginModule.default.register(freshD.ctx)
await tickPoll(freshD)

await recordAsync('7. fresh install: "Frame in Hermes" on the page moves the film to the floating watch window, and the same button brings it back', async () => {
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

  // The picked film is on the page stage: the page owns the ONE frame, and that
  // frame is the local player page for the picked film.
  clearFrames()
  pageTree(freshD)
  const onPage = playerFrames()
  assert.equal(onPage.length, 1, 'the picked film did not land on the page stage')
  assert.equal(pluginModule.__test.filmOwner(), 'page', 'the page does not own the player')

  // Pop out: the film leaves the page and becomes the floating watch window
  // inside Hermes. The product names that button "Frame in Hermes" (the OS
  // window is a separate button, "Pop out to desktop").
  const pop = pageAria(pageTree(freshD), 'Frame in Hermes')
  assert.ok(pop, 'the page has no way to put the film in its floating frame')
  pop.props.onClick()
  await sleep(20)
  clearFrames()
  pageTree(freshD)
  assert.equal(playerFrames().length, 0, 'the floating frame left the film on the page')
  clearFrames()
  renderSurface(freshD, 'watch')
  assert.equal(playerFrames().length, 1, 'the floating watch window did not get the film')
  assert.equal(freshD.storage.get('settings').videoWindow, true, 'the watch window was not persisted')

  // Bring it back: the same single player returns to the page stage.
  const back = pageAria(pageTree(freshD), 'Frame in Hermes')
  assert.ok(back, 'a framed film offers no way back')
  back.props.onClick()
  await sleep(20)
  // Every surface that exists now, at once: exactly one player between them.
  clearFrames()
  pageTree(freshD)
  for (const id of ['panel', 'watch']) {
    const surface = freshD.contributions.find(entry => entry.id === id)
    if (surface) renderDeep(renderContribution(surface))
  }
  assert.equal(playerFrames().length, 1, 'Bring back did not return the film to the page, or a second player was left behind')
  assert.equal(pluginModule.__test.filmOwner(), 'page', 'the page did not take the player back')
  assert.equal(freshD.storage.get('settings').videoWindow, false, 'bring-back did not persist')
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

await recordAsync('9. fresh install: dispose leaves nothing behind - no contributions, no timers, no listeners, no frames', async () => {
  await tickPoll(freshF)

  // Visualiser mode has no Right panel (it is a video surface), so nothing is
  // mounted into a pane box yet — and none of it may survive dispose either.
  assert.equal(freshF.contributions.find(c => c.area === 'panes'), undefined,
    'the Right panel is contributed in visualiser mode')

  // Live a little first: a new user picks a film on the page. That starts video
  // mode, which is what brings the panel and a player with it.
  const card = pageAria(pageTree(freshF), 'Play Sintel · Blender film')
  assert.ok(card, 'no starter source to pick')
  card.props.onClick()
  await sleep(60)
  const hostNode = mountPane(freshF)
  clearFrames()
  renderSurface(freshF, 'panel')
  assert.ok(playerFrames().length >= 1, 'precondition: no player drawn to clean up')
  const timersStarted = freshF.timers.length
  assert.ok(freshF.listeners.length > 0, 'precondition: no host listener was registered')
  assert.ok(timersStarted > 0, 'precondition: no host timer was registered')

  clearFrames()
  disposeF()

  assert.equal(freshF.contributions.length, 0, 'a contribution survived dispose')
  assert.ok(freshF.timers.every(t => t.cleared), 'a timer survived dispose')
  assert.ok(freshF.listeners.every(t => t.removed), 'a listener survived dispose')
  assert.equal(framesNow().length, 0, 'a frame was still drawn after dispose')
  assert.equal(hostIframes().length, 0, 'an iframe survived dispose')
  assert.equal(hostStyles().length, 0, 'a host stylesheet survived dispose')
  assert.equal(headChildren.length, 0, `a stylesheet survived dispose (${headChildren.map(n => n.attributes && n.attributes.id).join(', ')})`)
  assert.equal(videoBar(), undefined, 'the video control strip survived dispose')
  assert.equal(panelCards(hostNode).length, 0, 'the panel DOM survived dispose inside the pane box')
  assert.equal(hostNode.children.length, 0, 'the panel node survived inside the pane box')
  assert.doesNotThrow(() => disposeF(), 'dispose is not idempotent')
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
