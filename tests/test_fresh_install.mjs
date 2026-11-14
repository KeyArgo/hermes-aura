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

  record(`14. ${mode} mode: the film stage is ${expectControls ? 'hidden' : 'shown'} in the Right panel`, () => {
    const stage = domFind(paneH, node => node.className === 'ap-stage')
    assert.ok(body && stage, 'the panel has no film body or stage')
    assert.equal(body.style.display === 'none', expectControls,
      `${mode} mode: the film controls display is "${body.style.display || ''}"`)
    assert.equal(stage.style.display === 'none', expectControls,
      `${mode} mode: the film stage display is "${stage.style.display || ''}"`)
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
    const frame = hostIframes().find(f => f.style.display !== 'none' && !['-1', '1'].includes(f.style.zIndex))
    assert.ok(frame, 'no watch window')
    const view = globalThis.document.defaultView || {}
    const vw = Number.isFinite(view.innerWidth) ? view.innerWidth : 1400
    const right = parseFloat(frame.style.left) + parseFloat(frame.style.width)
    assert.ok(right <= vw - 320, `the watch window reaches x=${right}, over the Right panel (starts at ${vw - 320})`)
  })
  record('20. with the Right panel open the watch window still carries its strip, with a drag grip', () => {
    assert.ok(videoBar(), 'no control strip under the watch window while the Right panel is open')
    assert.ok(domFind(videoBar(), node => node.attributes && node.attributes['aria-label'] === 'Drag to move the watch window'),
      'the strip has no drag grip')
  })
  record('21. the strip offers where to send the film: Right panel, behind the chat, desktop', () => {
    for (const label of ['Send the film to the Right panel', 'Send the film behind the chat', 'Pop the film out to the desktop']) {
      assert.ok(stripButton(label), `the strip has no "${label}"`)
    }
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
  await recordAsync('23. "Behind the chat" on the strip moves the film behind the chat', async () => {
    clickDom(stripButton('Send the film behind the chat'))
    await sleep(40)
    const saved = scenario.bucket.storage.get('settings')
    assert.equal(saved.videoWindow, false, 'the watch window stayed open')
    assert.equal(saved.filmBehind, true, 'the film was not sent behind the chat')
  })
  safeDispose('the watch-window behind-chat scenario (J)', scenario.dispose)
}

{
  const scenario = await watchWindowScenario({ watchControls: false })
  record('24. the strip under the watch window can be switched off in favour of the Right panel', () => {
    assert.equal(videoBar(), undefined, 'the strip still shows with "Controls under the watch window" off')
  })
  safeDispose('the watch-window no-strip scenario (J)', scenario.dispose)
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

  record('26. the Right panel has the film tools: paste a link, jump to a time, close, pop out to desktop', () => {
    for (const label of ['Paste a video or playlist link', 'Jump to time (Right panel)', 'Close the film', 'Pop the film out to the desktop (Right panel)']) {
      assert.ok(paneControl(label), `the Right panel has no "${label}"`)
    }
  })

  record('27. with the film in the watch window, Watch in marks neither Panel nor Behind chat', () => {
    const panelPill = paneControl('Watch the film in the Right panel')
    const behindPill = paneControl('Watch the film behind the chat')
    assert.ok(panelPill && behindPill, 'the Watch in pills are missing')
    assert.notEqual(panelPill.attributes['data-active'], 'true', 'Watch in shows Panel while the film is in the watch window')
    assert.notEqual(behindPill.attributes['data-active'], 'true', 'Watch in shows Behind chat while the film is in the watch window')
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

  record('31. playlist-only buttons are disabled for a single film, and say why', () => {
    for (const label of ['Manage playlist', 'Hide this episode']) {
      const button = control(label)
      assert.ok(button, `the panel has no "${label}"`)
      assert.equal(button.disabled === true || button.attributes.disabled !== undefined, true,
        `"${label}" looks live for a single film but does nothing`)
      assert.match(String(button.title || ''), /playlist/i, `"${label}" does not say it is for playlists`)
    }
  })

  record('32. the Right panel scrolls when its content is taller than the pane', () => {
    const style = domFind(globalThis.document.head, node => node.attributes && node.attributes.id === 'aura-panel-style')
    assert.ok(style, 'no panel stylesheet')
    const css = String(style.textContent || '')
    const body = /\.ap-body\s*\{([^}]*)\}/.exec(css)
    assert.ok(body, 'the panel body has no rule, so it never limits its height')
    assert.match(body[1], /overflow-y:\s*auto/, 'the panel body cannot scroll')
    assert.match(body[1], /min-height:\s*0/, 'the panel body cannot shrink to scroll')
  })

  await recordAsync('33. Watch in offers Panel, Behind chat, Window and Desktop, and marks where the film is', async () => {
    for (const label of ['Watch the film in the Right panel', 'Watch the film behind the chat',
      'Watch the film in the watch window', 'Watch the film in a desktop window']) {
      assert.ok(control(label), `Watch in has no "${label}"`)
    }
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
  clickDom(control('Pop the film out to the desktop (Right panel)'))
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

  await recordAsync('38. switching to the visualiser while the film is on the desktop shows the visualiser', async () => {
    const visualizer = domFind(scenario.pane, node => node.attributes && node.attributes['data-mode'] === 'aura')
    assert.ok(visualizer, 'no Visualizer mode button in the panel')
    clickDom(visualizer)
    await sleep(60)
    await tickPoll(scenario.bucket)
    const frame = hostIframes()[0]
    assert.ok(frame, 'no visualiser frame')
    assert.notEqual(frame.style.display, 'none', 'the visualiser is hidden because the film is on the desktop')
  })

  record('39. the visualiser-mode panel has no tall empty box above its controls', () => {
    const panelBox = domFind(scenario.pane, node => node.attributes && node.attributes.id === 'aura-panel')
    assert.ok(panelBox, 'no #aura-panel')
    assert.equal(panelBox.style.height, 'auto', 'the panel still reserves the hidden film stage height')
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

// Scenario O: the Aura page header's on/off pill is a real control, with the
// same two-click turn-off as the panel's power button.
{
  const scenario = await watchWindowScenario({})
  const enabledSent = () => scenario.bucket.controls.filter(c => c && typeof c.enabled === 'boolean').map(c => c.enabled)
  const pill = () => pageAriaPrefix(pageTree(scenario.bucket), 'Aura on') || pageAriaPrefix(pageTree(scenario.bucket), 'Aura off') ||
    pageAriaPrefix(pageTree(scenario.bucket), 'Click again')
  await recordAsync('43. the page header Aura on/off pill turns Aura off (two clicks) and on (one click)', async () => {
    const first = pill()
    assert.ok(first && typeof first.props.onClick === 'function', 'the page header Aura on/off pill does nothing when clicked')
    first.props.onClick({ preventDefault() {} })
    await sleep(30)
    assert.deepEqual(enabledSent(), [], 'one click turned Aura off (it needs a second click)')
    pill().props.onClick({ preventDefault() {} })
    await sleep(30)
    assert.deepEqual(enabledSent(), [false], 'the second click did not turn Aura off')
    await tickPoll(scenario.bucket)
    pill().props.onClick({ preventDefault() {} })
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
    const style = headChildren.find(node => node.attributes && node.attributes.id === 'aura-panel-style')
    assert.ok(style, 'no panel stylesheet')
    const css = String(style.textContent || '')
    const rule = /#aura-panel\s*\{[^}]*-webkit-app-region:\s*no-drag/.test(css)
    assert.ok(rule, 'the Right panel does not opt out of the host title-bar drag region')
  })
  safeDispose('the no-drag scenario (P)', scenario.dispose)
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
  const seeThrough = domFind(pane, node => node.attributes && node.attributes['aria-label'] === '25% film strength')
  const seeThroughRow = seeThrough && seeThrough.parentNode && seeThrough.parentNode.parentNode
  return { bucket, dispose, pane, stage, seeThroughRow }
}

{
  const behind = await watchInScenario(true)
  record('15. Behind chat: with the Right panel open the film fills the window behind the chat', () => {
    const frame = hostIframes()[0]
    assert.ok(frame, 'no film frame mounted')
    assert.equal(frame.style.zIndex, '-1', `the film is not behind the app (z-index ${frame.style.zIndex})`)
    assert.equal(frame.style.width, '100vw', `the film does not fill the window (width ${frame.style.width})`)
    assert.equal(String(frame.style.opacity), '0.25', 'the film behind the chat lost the see-through setting')
  })
  record('16. Behind chat: the panel is the remote, with no second picture and its see-through shown', () => {
    assert.ok(behind.stage, 'the panel has no stage')
    assert.equal(behind.stage.style.display, 'none', 'the panel still draws a film stage while the film is behind the chat')
    assert.ok(behind.seeThroughRow, 'the panel has no see-through row')
    assert.notEqual(behind.seeThroughRow.style.display, 'none', 'see-through is hidden while it is the film behind the chat it controls')
  })
  safeDispose('the behind-chat scenario (I)', behind.dispose)
}

{
  const inPanel = await watchInScenario(false)
  record('17. Panel: the film plays in the Right panel at full strength, see-through hidden', () => {
    const frame = hostIframes()[0]
    assert.ok(frame, 'no film frame mounted')
    assert.notEqual(frame.style.zIndex, '-1', 'the film went behind the app while set to play in the panel')
    assert.equal(String(frame.style.opacity), '1', 'the panel film is not at full strength')
    assert.ok(inPanel.seeThroughRow, 'the panel has no see-through row')
    assert.equal(inPanel.seeThroughRow.style.display, 'none', 'see-through is shown while it cannot change anything')
  })
  await recordAsync('18. the panel switches the film behind the chat in one click', async () => {
    const button = domFind(inPanel.pane, node => node.attributes && node.attributes['aria-label'] === 'Watch the film behind the chat')
    assert.ok(button, 'the panel has no "Behind chat" choice')
    clickDom(button)
    await sleep(40)
    assert.equal(inPanel.bucket.storage.get('settings').filmBehind, true, 'Behind chat was not saved')
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

  const onPage = () => hostIframes().filter(frame => frame.style.width === '800px')
  assert.equal(onPage().length, 1, 'the picked film did not land on the page stage')
  assert.equal(onPage()[0].style.zIndex, '1', 'the page film must sit above the page')

  // Pop out: the film leaves the page and becomes the floating watch window.
  // Pop out asks the host for a real OS window first; this host cannot give one,
  // so the film settles in the in-app watch window. Both steps are async.
  const pop = pageAria(pageTree(freshD), 'Pop out')
  assert.ok(pop, 'the page has no Pop out button')
  pop.props.onClick()
  await sleep(80)
  assert.equal(onPage().length, 0, 'Pop out left the film on the page')
  // The watch window floats above the app (not behind it at -1, not on the page
  // stage at 1) and still below the host's menus.
  const floating = hostIframes().find(frame =>
    frame.style.display !== 'none' && !['-1', '1'].includes(frame.style.zIndex) && Number(frame.style.zIndex) < 50)
  assert.ok(floating, 'Pop out did not hand the film to the floating watch window')
  assert.equal(freshD.storage.get('settings').videoWindow, true, 'the watch window was not persisted')

  // Bring back: the same single player returns to the page stage.
  const back = pageAria(pageTree(freshD), 'Bring back')
  assert.ok(back, 'a popped-out film offers no Bring back')
  back.props.onClick()
  await sleep(80)
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

// --------------------------------------------------------------- reporting

console.log(results.join('\n'))
console.log(`\n${results.length - failed} passed, ${failed} failed`)

try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch {
  // the scratch dir is pruned anyway
}

if (failed > 0) process.exitCode = 1
