/**
 * Desktop-half regressions that only appeared on Windows (desktop/plugin.js).
 *
 * Each block pins one defect, and each block failed on the plugin before its
 * fix:
 *
 *   1. play/pause was a toggle computed from a believed state, so a press could
 *      go the wrong way when that belief was one report behind, and a command
 *      that never reached the frame still flipped the glyph;
 *   2. the per-tick opacity writer forced the film to ~20% inside the docked
 *      panel, which reads as a black player;
 *   3. the saved per-film position never recorded "paused", so every reload
 *      resumed PLAYING;
 *   4. the frame re-pointed itself whenever the whole URL changed, and the URL
 *      carries resume=<position> (rewritten every 5 s), so the film restarted
 *      constantly;
 *   5. a playing film had no full-window host: it filled a box or nothing, and
 *      the see-through pills were offered where they do nothing.
 *
 * Like the main contract test this does not run the plugin inside Hermes. A
 * temp copy has its three import specifiers rewritten to local stubs, so the
 * plugin can be imported by plain Node and driven through its own register()
 * contract and its `__test` surface.
 *
 * Run: node tests/test_desktop_windows.mjs
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
  assert.ok(element && typeof element === 'object', `contribution ${contribution.id} did not render`)
  return typeof element.type === 'function' ? element.type(element.props) : element
}

// ------------------------------------------------------------------ document
const bodyChildren = []
const headChildren = []

function makeChildList(children) {
  const classes = new Set()
  return {
    children,
    style: {},
    className: '',
    dataset: {},
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

function makeElement(tagName) {
  const node = {
    tagName: String(tagName).toUpperCase(),
    style: {},
    attributes: {},
    children: [],
    parentNode: null,
    src: '',
    textContent: '',
    dataset: {},
    __handlers: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    getAttribute(name) {
      return this.attributes[name]
    },
    removeAttribute(name) {
      delete this.attributes[name]
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
    addEventListener(type, fn) {
      const list = this.__handlers[type] || (this.__handlers[type] = [])
      list.push(fn)
    },
    removeEventListener(type, fn) {
      const list = this.__handlers[type]
      if (list) this.__handlers[type] = list.filter(entry => entry !== fn)
    },
    click() {
      for (const fn of [...(this.__handlers.click || [])]) fn({ preventDefault() {}, target: this })
    },
    getBoundingClientRect() {
      return { width: 320, height: 180, left: 0, top: 0, right: 320, bottom: 180 }
    },
    get firstChild() {
      return this.children[0] || null
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this)
    }
  }
  return node
}

const docHandlers = new Map()
globalThis.document = {
  hidden: false,
  visibilityState: 'visible',
  documentElement: { style: {} },
  defaultView: { innerWidth: 1400, innerHeight: 900 },
  head: makeChildList(headChildren),
  body: makeChildList(bodyChildren),
  createElement: makeElement,
  addEventListener(type, fn) {
    const list = docHandlers.get(type) || []
    list.push(fn)
    docHandlers.set(type, list)
  },
  removeEventListener(type, fn) {
    const list = docHandlers.get(type) || []
    docHandlers.set(type, list.filter(entry => entry !== fn))
  }
}
globalThis.getComputedStyle = () => ({
  backgroundColor: 'rgba(0, 0, 0, 0)',
  getPropertyValue: () => ''
})

// -------------------------------------------------------------------- context
function makeCtx(settings) {
  const contributions = []
  const timers = []
  const controls = []
  const requests = []
  const disposers = []
  const storage = new Map()
  if (settings) storage.set('settings', settings)
  let serverEnabled = settings && typeof settings.enabled === 'boolean' ? settings.enabled : true
  const serverSettings = {
    motion: (settings && settings.motion) || 'agent_music',
    behavior: (settings && settings.behavior) || 'balanced',
    intensity: settings && Number.isFinite(settings.intensity) ? settings.intensity : 0.25,
    opacity: settings && Number.isFinite(settings.opacity) ? settings.opacity : 0.25,
    reduced_motion: Boolean(settings && settings.reducedMotion)
  }
  const serverFrame = {
    level: 0.55, bands: [0, 0, 0, 0, 0, 0, 0, 0], onset: false,
    centroid: 0.4, flatness: 0.2, silence: false, mood: 'thinking'
  }
  // What the local server hands out. A "new server" changes the port and token,
  // which is what a restart looks like from this half.
  let live = { port: 4321, token: 'token-a' }
  const playerState = { open: false, player: {} }

  const ctx = {
    source: 'plugin:aura',
    register(contribution) {
      const record = { ...contribution, removed: false }
      contributions.push(record)
      return () => {
        if (record.removed) return
        record.removed = true
        const index = contributions.indexOf(record)
        if (index >= 0) contributions.splice(index, 1)
      }
    },
    registerSettingsPage(page) {
      return ctx.register({
        id: page.id, area: 'settings.plugins', title: page.title,
        data: { children: page.children || [], icon: page.icon },
        render: page.render
      })
    },
    onDispose(fn) {
      disposers.push(fn)
    },
    setInterval(fn, ms) {
      const record = { fn, ms, kind: 'interval', cleared: false }
      timers.push(record)
      return () => { record.cleared = true }
    },
    setTimeout(fn, ms) {
      const record = { fn, ms, kind: 'timeout', cleared: false }
      timers.push(record)
      return () => { record.cleared = true }
    },
    addEventListener(target, type, fn) {
      const record = { target, type, fn, removed: false }
      timers.push(record)
      return () => { record.removed = true }
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
          port: live.port,
          url: `http://127.0.0.1:${live.port}/?token=${live.token}`,
          capture: 'wasapi',
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
        return { ok: true }
      }
      if (route === '/player') {
        return { ok: true, window: { open: playerState.open }, player: playerState.player }
      }
      if (String(route).startsWith('/player/commands')) return { ok: true, head_seq: 0, commands: [] }
      if (route === '/player/command') return { ok: true }
      if (route === '/player/report') return { ok: true }
      if (route === '/window') return { ok: true, available: true, open: false }
      if (route === '/window/open') return { ok: true, window: { open: true } }
      if (route === '/window/close') return { ok: true, closed: true, window: { open: false } }
      if (route === '/version') {
        return { version: '1.0.0', commit: 'abcdef1234567890', commit_short: 'abcdef12', commit_date: '2026-11-13', channel: 'dev', dirty: false }
      }
      if (String(route).startsWith('/quality')) throw new Error('unexpected route /quality')
      if (String(route).startsWith('/playlist')) return { items: [] }
      throw new Error(`unexpected route ${route}`)
    }
  }

  return {
    ctx, contributions, timers, controls, requests, storage,
    serverSettings, serverFrame, playerState,
    setLive: next => { live = next },
    setLiveToken: token => { live = { ...live, token } },
    setLivePort: port => { live = { ...live, port } }
  }
}

// -------------------------------------------------------------------- modules
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aura-win-test-'))
const source = fs.readFileSync(PLUGIN, 'utf8')
const pluginCopy = path.join(tmp, 'plugin.mjs')
const sdkStub = path.join(tmp, 'sdk-stub.mjs')
const reactStub = path.join(tmp, 'react-stub.mjs')
const jsxStub = path.join(tmp, 'jsx-runtime-stub.mjs')

fs.writeFileSync(
  pluginCopy,
  source
    .replace(/from\s+'@hermes\/plugin-sdk'/g, "from './sdk-stub.mjs'")
    .replace(/from\s+'react'/g, "from './react-stub.mjs'")
    .replace(/from\s+'react\/jsx-runtime'/g, "from './jsx-runtime-stub.mjs'") +
  '\nexport const winTest = { video: $video, settings: $settings, live: $live };\n'
)

fs.writeFileSync(
  sdkStub,
  `export const calls = { accent: [], themes: [], navigations: [], notifications: [] }
function makeAtom(initial) {
  let value = initial
  return { get: () => value, set: next => { value = next }, listen: () => () => {} }
}
export const atom = makeAtom
export const $accentOverride = makeAtom(null)
export const setAccentOverride = color => { calls.accent.push(color) }
export const requestTheme = name => { calls.themes.push(name); return true }
export const host = {
  state: { focusedStoredSessionId: { get: () => 'chat/1' } },
  navigate: route => { calls.navigations.push(route) },
  notify: message => { calls.notifications.push(message) },
  undismissPane: () => {},
  revealPane: () => {},
  composer: { focus: () => {} }
}
export const useValue = store => store.get()
export const useTheme = () => ({
  themeName: 'nous',
  theme: { name: 'nous', colors: { accent: '#8b7cff', primary: '#8b7cff', ring: '#8b7cff' } },
  setTheme: () => {}, mode: 'dark', resolvedMode: 'dark', renderedMode: 'dark',
  availableThemes: [], setMode: () => {}, previewTheme: () => {}, clearThemePreview: () => {}
})
export const Button = () => null
export const Switch = () => null
export const StatusDot = () => null
export const Popover = props => ({ type: 'div', props: { children: props && props.children } })
export const PopoverTrigger = props => ({ type: 'div', props: { children: props && props.children } })
export const PopoverContent = props => ({ type: 'div', props: { children: props && props.children } })
export const PALETTE_AREA = 'palette'
export const PANES_AREA = 'panes'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
export const SETTINGS_PLUGINS_AREA = 'settings.plugins'
export const THEMES_AREA = 'themes'
export const TITLEBAR_AREAS = { center: 'titleBar.center', left: 'titleBar.left', right: 'titleBar.right' }
export const COMPOSER_AREAS = {
  top: 'composer.top', bottom: 'composer.bottom', underside: 'composer.underside',
  leading: 'composer.leading', actions: 'composer.actions', middleware: 'composer.middleware',
  attachments: 'composer.attachments', microActions: 'composer.microActions',
  atCompletions: 'composer.atCompletions', modelPill: 'composer.modelPill', contextMenu: 'composer.contextMenu'
}
export const frames = []
globalThis.__sdkFrames = frames
export const SandboxedFrame = props => { frames.push(props); return null }
`
)

fs.writeFileSync(
  reactStub,
  `export const Fragment = Symbol.for('react.fragment')
export function useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] }
export function useEffect(fn) { fn() }
export function useLayoutEffect(fn) { fn() }
export function useRef(value) { return { current: value } }
export function useMemo(fn) { return fn() }
export function useCallback(fn) { return fn }
`
)

fs.writeFileSync(
  jsxStub,
  `export function jsx(type, props, key) { return { type, props, key } }
export const jsxs = jsx
export const Fragment = Symbol.for('react.fragment')
`
)

const pluginModule = await import(pathToFileURL(pluginCopy).href)
const sdk = await import(pathToFileURL(sdkStub).href)
const tx = pluginModule.__test
const atoms = pluginModule.winTest

// ------------------------------------------------------------------- helpers
const VIDEO = 'https://example.test/film.mp4'

/** Run one real poll tick and let its promises settle. */
async function tick(bucket) {
  const interval = bucket.timers.find(t => t.kind === 'interval' && t.ms === 250)
  assert.ok(interval, 'no polling interval')
  interval.fn()
  await sleep(30)
}

/** Prime the live atom (server url + token) the way a real poll does. */
async function primeLive(bucket) {
  for (let attempt = 0; attempt < 8 && !tx.liveUrlForTest(); attempt += 1) {
    await tx.poll()
    await sleep(20)
  }
  assert.ok(tx.liveUrlForTest(), 'the live server url never landed')
  void bucket
}

/** Render the pane and return its theatre host node with the DOM panel inside. */
function mountPane(bucket) {
  const pane = bucket.contributions.find(c => c.area === 'panes')
  assert.ok(pane, 'no pane contribution')
  let ref = null
  walk(renderContribution(pane), node => {
    if (!ref && node.props && node.props.key === 'theatre') ref = node.props.ref
  })
  assert.equal(typeof ref, 'function', 'the pane has no theatre ref')
  const host = makeElement('div')
  ref(host)
  const panel = host.children.find(node => node.attributes && node.attributes.id === 'aura-panel')
  assert.ok(panel, 'the panel did not mount into its host')
  return { host, panel }
}

function findByAria(root, label) {
  let found = null
  const scan = node => {
    if (!node || found) return
    if (node.attributes && node.attributes['aria-label'] === label) { found = node; return }
    for (const child of node.children || []) scan(child)
  }
  scan(root)
  return found
}

function frameFor(bucket) {
  const pane = bucket.contributions.find(c => c.area === 'panes')
  globalThis.__sdkFrames.length = 0
  if (pane) {
    let tree = pane.render()
    if (typeof tree.type === 'function') tree = tree.type(tree.props)
    const expand = node => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) { node.forEach(expand); return }
      if (typeof node.type === 'function') {
        const out = node.type(node.props || {})
        if (out && typeof out === 'object') { node.type = out.type; node.props = out.props; expand(node) }
        return
      }
      if (node.props) expand(node.props.children)
    }
    expand(tree)
  }
  return globalThis.__sdkFrames.find(f => String(f.src || '').includes('/player.html')) || null
}

const videoMode = (extra = {}) => makeCtx({
  enabled: true,
  backdropMode: 'video',
  panelEnabled: true,
  videoUrl: VIDEO,
  showWhen: 'always',
  panelSettingsOpen: false,
  ...extra
})

// ================================================ 2. the panel is a window
// The opacity writer runs four times a second; a panel-held film must stay at
// full strength instead of being dimmed to the behind-the-app wash.

await recordAsync('the per-tick opacity writer leaves a pane-held film at full strength', async () => {
  const bucket = videoMode({ filmFullWindow: false })
  const dispose = pluginModule.default.register(bucket.ctx)
  try {
    await primeLive(bucket)
    const framed = frameFor(bucket)
    assert.ok(framed, 'the pane drew no player frame')
    const node = { style: {} }
    framed.ref(node)
    tx.applyVideoOpacity()
    assert.equal(node.style.opacity, '1',
      `the tick dimmed the panel's film to ${node.style.opacity} (a black player)`)
  } finally {
    dispose()
  }
})

await recordAsync('a film filling the window behind the panel is a wash, not a window', async () => {
  const bucket = videoMode({ videoOpacityAuto: false, videoOpacity: 0.25 })
  const dispose = pluginModule.default.register(bucket.ctx)
  try {
    await primeLive(bucket)
    assert.equal(tx.filmBehindApp(), true, 'a playing film is not behind the app')
    const framed = frameFor(bucket)
    const node = { style: {} }
    framed.ref(node)
    tx.applyVideoOpacity()
    assert.equal(node.style.opacity, '0.25',
      'the window-filling film ignored the pinned transparency')
  } finally {
    dispose()
  }
})

// ==================================================== 5. the full-window host
// A playing film fills the app window behind everything, even with the panel
// open; the see-through controls are offered only there.

await recordAsync('filmFullWindow decides the host: default on, off for the page and the OS window', async () => {
  const bucket = videoMode()
  const dispose = pluginModule.default.register(bucket.ctx)
  try {
    await primeLive(bucket)
    assert.equal(atoms.settings.get().filmFullWindow, true, 'the key does not default to true')
    assert.equal(tx.filmFullWindowOn(), true, 'a playing film is not hosted by the window')
    assert.equal(tx.filmFullWindowOn(), true, 'the docked panel vetoed the full-window host')

    atoms.settings.set({ ...atoms.settings.get(), filmFullWindow: false })
    assert.equal(tx.filmFullWindowOn(), false, 'the setting was ignored')
    atoms.settings.set({ ...atoms.settings.get(), filmFullWindow: true })

    atoms.settings.set({ ...atoms.settings.get(), videoClosed: true })
    assert.equal(tx.filmFullWindowOn(), false, 'a closed film still asked for the window')
  } finally {
    dispose()
  }
})

await recordAsync('the layout picker fills the window over the panel and the frame flag', async () => {
  const bucket = videoMode()
  const dispose = pluginModule.default.register(bucket.ctx)
  try {
    await primeLive(bucket)
    const host = tx.filmHostStyle('pane')
    assert.ok(host, `the pane did not get the window-filling layout: ${JSON.stringify(tx.filmGates())}`)
    assert.equal(host.position, 'fixed', 'the host is not a full-window layer')
    assert.equal(host.inset, 0)
    assert.equal(host.zIndex, -1, 'the film is not behind the app')
    assert.equal(host.pointerEvents, 'none', 'the host would swallow clicks meant for the app')

    // A stray watch-window flag must not take the window away.
    atoms.settings.set({ ...atoms.settings.get(), videoWindow: true })
    assert.equal(tx.filmFullWindowOn(), true, 'a watch-window flag vetoed the full-window host')
    assert.ok(tx.filmHostStyle('pane'), 'the watch-window flag demoted the pane to a box')
    // The floating frame itself is a box of its own, and the page owns its stage.
    assert.equal(tx.filmHostStyle('window'), null, 'the floating frame was turned into the window host')
    assert.equal(tx.filmHostStyle('page'), null, 'the page lost its own stage')
    // While the frame holds the picture it is a box, not a wash: the
    // see-through controls would do nothing there.
    assert.equal(tx.filmBehindApp(), false, 'a framed film was treated as a wash behind the app')

    // The pane really renders the picture as the window host.
    atoms.settings.set({ ...atoms.settings.get(), videoWindow: false })
    const framed = frameFor(bucket)
    assert.ok(framed, 'the pane drew no frame')
    assert.equal(framed.style.position, 'fixed', 'the pane drew a box instead of the window host')
    assert.equal(framed.style.zIndex, -1, 'the pane film is not behind the app')

    // And the panel is glass over it.
    const { panel } = mountPane(bucket)
    assert.equal(panel.getAttribute('data-glass'), 'true', 'the panel is not see-through over the film')
    assert.match(tx.panelCss(), /#aura-panel\[data-glass="true"\]/)
    void panel
  } finally {
    dispose()
  }
})

await recordAsync('the see-through pills are hidden while the panel holds the picture', async () => {
  // Panel holds it (full-window host off): the setting does nothing there.
  const boxed = videoMode({ filmFullWindow: false })
  const disposeBoxed = pluginModule.default.register(boxed.ctx)
  try {
    await primeLive(boxed)
    assert.equal(tx.filmBehindApp(), false, 'a boxed film was treated as behind the app')
    const { panel } = mountPane(boxed)
    assert.equal(panel.getAttribute('data-glass'), 'false', 'the panel went glassy over a boxed film')
    assert.equal(tx.panelOpacityRowForTest(), 'none', 'the panel still offers see-through over its own box')
    const menu = renderContribution(boxed.contributions.find(c => c.id === 'quick-menu'))
    let pill = null
    walk(menu, node => {
      if (!pill && node.props && node.props['aria-label'] === '50% video transparency') pill = node
    })
    assert.equal(pill, null, 'the quick menu still offers see-through for a boxed film')
  } finally {
    disposeBoxed()
  }

  // Film behind the app: the pills are exactly what the user needs.
  const behind = videoMode()
  const disposeBehind = pluginModule.default.register(behind.ctx)
  try {
    await primeLive(behind)
    assert.equal(tx.filmBehindApp(), true, 'a film behind the app was not recognised')
    const { panel } = mountPane(behind)
    assert.equal(panel.getAttribute('data-glass'), 'true', 'the glass was not switched on')
    assert.equal(tx.panelOpacityRowForTest(), '', 'the see-through row stayed hidden behind the app')
    assert.ok(findByAria(panel, '25% film see-through'), 'the panel has no see-through pills')
    const menu = renderContribution(behind.contributions.find(c => c.id === 'quick-menu'))
    let pill = null
    walk(menu, node => {
      if (!pill && node.props && node.props['aria-label'] === '50% video transparency') pill = node
    })
    assert.ok(pill, 'the quick menu lost the see-through pills behind the app')
  } finally {
    disposeBehind()
  }
})

await recordAsync('with no panel or page, a playing film fills the window instead of a 0x0 seat', async () => {
  const bucket = videoMode({ panelEnabled: false })
  const dispose = pluginModule.default.register(bucket.ctx)
  try {
    await primeLive(bucket)
    assert.equal(tx.filmOwner(), 'fullwindow',
      `the film fell back to "${tx.filmOwner()}" instead of the window host`)
    globalThis.__sdkFrames.length = 0
    const seat = bucket.contributions.find(c => c.id === 'audio-surface')
    assert.ok(seat, 'the always-mounted seat vanished')
    const tree = seat.render()
    const rendered = tree.type(tree.props)
    const frame = rendered.props.children
    const film = typeof frame.type === 'function' ? frame.type(frame.props) : frame
    assert.ok(film && film.props, 'the seat rendered no film')
    assert.match(String(film.props.src), /\/player\.html/, 'the seat is not showing the film')
    assert.equal(film.props.style.position, 'fixed', 'the seat kept the film in an invisible box')
    assert.equal(film.props.style.zIndex, -1, 'the seat film is not behind the app')
  } finally {
    dispose()
  }
})

// ------------------------------------------------------------------- report
for (const line of results) process.stdout.write(`${line}\n`)
process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`)
if (failed) process.exitCode = 1
void sdk
