/**
 * Idle polling test for the Aura desktop half (desktop/plugin.js).
 *
 * The owner's complaint: "Aura is eating my CPU and I'm not even using it".
 * The 250 ms tick polled /status, /state and /player forever — off, idle, hidden
 * — so the backend saw ~12-16 requests a second all day for a UI that was not
 * on screen. The fix keeps the 4 Hz tick and only decides whether a tick is
 * worth a round-trip.
 *
 * This file proves, headlessly and with a fake clock:
 *
 *   a. Aura off, nothing playing: 10 s of ticks makes at most 6 /status calls,
 *   b. hidden window and idle: 30 s makes at most 11 /status calls,
 *   c. Aura on (or a film playing): 2 s keeps the fast cadence (>= 6 /status),
 *   d. an idle Aura that the user switches on answers within 300 ms,
 *   e. pointer moves over the app (a document-wide listener) do not wake it,
 *   f. a placed panel surface with Aura off is not busy (10 s -> <= 6 /status),
 *   g. Aura on, surface placed, window hidden and nothing playing: 30 s -> <= 11,
 *   h. Aura on, surface placed, window visible: 2 s -> >= 6 (stays fast),
 *   i. radio playing with the window hidden: 10 s -> 8..12 (a 1 s glance; the
 *      levels are live but unseen, so 4 Hz was paid for nothing),
 *   j. a film playing with the window hidden: 10 s -> 8..12 (same cadence),
 *   k. radio playing with the window visible: 2 s -> >= 6 (still fast),
 *   l. hidden and idle, an agent audio request appears on the server: it is
 *      handled (play command) within 3.5 s — a 15 s glance is not an answer,
 *   m. Aura off, a mounted frame posts telemetry every 250 ms for 10 s:
 *      at most 6 /status calls — routine reports are not "using Aura",
 *   n. a new build with saved enabled:false and no user-chosen flag leaves
 *      Aura off and sends no /control {enabled:true},
 *   o. a first install with no saved settings at all still starts switched on.
 *
 * (a), (b), (d), (f) and (g) fail on the commit before the fix — they are the
 * CPU bill. (c), (h) and (k) are the anti-regression guards: a live surface
 * must not get slower. (i) and (j) fail on the parent of the hidden-playing
 * cadence: hidden and playing used to stay at 4 Hz. (l), (m) and (n) fail on
 * the tree before the review fixes: the 15 s hidden-idle glance, telemetry
 * that kept Aura busy forever, and a new build re-enabling a saved Off.
 *
 * Same wiring as tests/test_desktop_plugin.mjs: a temp copy has its three
 * import specifiers rewritten to local stubs, and the copy exposes the few
 * modules-internal functions this test drives. Set AURA_PLUGIN=<path> to point
 * the same test at another copy of the plugin (used to prove f/g fail on the
 * old commit without touching this worktree).
 *
 * Run: node tests/test_idle_poll.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGIN = process.env.AURA_PLUGIN || path.join(ROOT, 'desktop', 'plugin.js')

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

// ------------------------------------------------------------------ fake clock
// The plugin reads Date.now() only; patching it is enough to move time without
// making the suite wait in real seconds. setTimeout stays real so the awaits
// inside poll() (all microtasks over stubbed rest calls) still drain.
const clock = { now: 1_700_000_000_000 }
Date.now = () => clock.now

// ------------------------------------------------------------------ document

const bodyChildren = []
const headChildren = []
const sent = []

function makeParent(children) {
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

function makeElement(tagName) {
  const node = {
    tagName: String(tagName).toUpperCase(),
    style: {},
    attributes: {},
    children: [],
    parentNode: null,
    textContent: '',
    dataset: {},
    __handlers: {},
    setAttribute(name, value) { this.attributes[name] = String(value) },
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
    getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 } },
    remove() { if (this.parentNode) this.parentNode.removeChild(this) },
    get firstChild() { return this.children[0] || null }
  }
  if (String(tagName).toLowerCase() === 'iframe') {
    node.__sent = []
    node.contentWindow = {
      postMessage: message => {
        node.__sent.push(message)
        sent.push(message)
      }
    }
  }
  return node
}

globalThis.document = {
  hidden: false,
  visibilityState: 'visible',
  documentElement: {
    style: {},
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return this.attributes[name] },
    removeAttribute(name) { delete this.attributes[name] },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) }
  },
  head: makeParent(headChildren),
  body: makeParent(bodyChildren),
  createElement: makeElement,
  addEventListener() {},
  removeEventListener() {}
}
globalThis.getComputedStyle = () => ({ backgroundColor: 'rgba(0, 0, 0, 0)', getPropertyValue: () => '' })

// ------------------------------------------------------------- temp module

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aura-idlepoll-test-'))
const pluginCopy = path.join(tmp, 'plugin.mjs')

const source = fs.readFileSync(PLUGIN, 'utf8')
fs.writeFileSync(
  pluginCopy,
  source
    .replace(/from\s+'@hermes\/plugin-sdk'/g, "from './sdk-stub.mjs'")
    .replace(/from\s+'react'/g, "from './react-stub.mjs'")
    .replace(/from\s+'react\/jsx-runtime'/g, "from './jsx-stub.mjs'") +
  // The cadence is module state, so the copy hands the test the functions that
  // drive it. `typeof` guards keep this file importable on the old commit,
  // where the idle cadence does not exist yet (the tests then fail on counts,
  // not on a ReferenceError).
  '\nexport const idleTest = {' +
  ' setEnabled: typeof setEnabled === "function" ? setEnabled : null,' +
  ' pollDueMs: typeof pollDueMs === "function" ? pollDueMs : null,' +
  ' auraBusy: typeof auraBusy === "function" ? auraBusy : null,' +
  ' onVideoBarMouseMove: typeof onVideoBarMouseMove === "function" ? onVideoBarMouseMove : null,' +
  ' onBackdropMessage: typeof onBackdropMessage === "function" ? onBackdropMessage : null,' +
  ' setFilm: node => { filmFrame = node },' +
  ' refreshFilmSurface: typeof refreshFilmSurface === "function" ? refreshFilmSurface : null,' +
  ' settings: $settings, live: $live, surface: $filmSurface, audio: $audio, video: $video,' +
  ' lastPollAt: () => (typeof lastPollAt === "number" ? lastPollAt : null) };\n'
)

fs.writeFileSync(path.join(tmp, 'sdk-stub.mjs'), `
function makeAtom(initial) {
  let value = initial
  return { get: () => value, set: next => { value = next }, listen: () => () => {} }
}
export const calls = { navigations: [], external: [] }
export const atom = makeAtom
export const $accentOverride = makeAtom(null)
export const setAccentOverride = () => {}
export const requestTheme = () => true
export const host = {
  state: { focusedStoredSessionId: { get: () => 'chat/1' } },
  navigate: route => { calls.navigations.push(route) },
  notify: () => {}
}
export const useValue = store => store.get()
export const useTheme = () => ({
  themeName: 'nous', theme: { name: 'nous', colors: {} },
  setTheme: () => {}, mode: 'dark', resolvedMode: 'dark', renderedMode: 'dark',
  availableThemes: [], setMode: () => {}, previewTheme: () => {}, clearThemePreview: () => {}
})
export const Button = () => null
export const Switch = () => null
export const SandboxedFrame = () => null
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
export function useEffect() {}
export function useLayoutEffect() {}
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

// ------------------------------------------------------------------- harness

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/** One registration bucket: its own ctx, request log and polling tick. */
function mount(settings, serverEnabled) {
  const storage = new Map()
  const contributions = []
  // `userChoseOff` keeps the "a new build switches Aura on" path out of these
  // numbers: the owner's own Off must be honoured, and it is a different test.
  if (settings) storage.set('settings', settings)
  storage.set('userChoseOff', settings ? settings.enabled !== true : false)
  const requests = []
  const controls = []
  // The agent's requests "appear on the server" when a test pushes here; the
  // next /state answer carries them, exactly like /api/state does.
  const audioRequests = []
  const intervals = []
  const ctx = {
    source: 'plugin:aura',
    os: { openExternal: () => true },
    register(contribution) {
      contributions.push(contribution)
      return () => { contribution.removed = true }
    },
    registerSettingsPage(page) { return ctx.register(page) },
    onDispose() {},
    setInterval(fn, ms) {
      const record = { fn, ms, cleared: false }
      intervals.push(record)
      return () => { record.cleared = true }
    },
    setTimeout() { return () => {} },
    addEventListener() { return () => {} },
    storage: {
      get(key, fallback) { return storage.has(key) ? storage.get(key) : fallback },
      set(key, value) { storage.set(key, value) },
      remove(key) { storage.delete(key) }
    },
    async rest(route, options = {}) {
      requests.push(route)
      if (route === '/status') {
        return { ok: true, port: 4321, url: 'http://127.0.0.1:4321/?token=x', capture: 'none', enabled: serverEnabled }
      }
      if (route === '/state') {
        return { level: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0], silence: true, mood: 'idle', audio_requests: audioRequests }
      }
      if (route === '/version') return { version: '1.0.0', commit: 'idle-poll' }
      if (route === '/player') return { ok: true, window: { open: false }, player: {}, seq: 0 }
      if (route === '/control') {
        controls.push(options.body || {})
        return { ok: true, ...(options.body || {}) }
      }
      return { ok: true }
    }
  }
  const dispose = plugin.default.register(ctx)
  return {
    dispose,
    storage,
    requests,
    controls,
    audioRequests,
    intervals,
    contributions,
    status: () => requests.filter(route => route === '/status').length,
    /** The tick the host would fire, once. */
    tick() {
      for (const record of intervals) if (!record.cleared) record.fn()
    }
  }
}

// --------------------------------------------------------- panel surface mount
// tests/test_no_backdrop.mjs mounts the Right panel by rendering its
// contribution and handing the theatre ref a host node. A placed surface needs
// the same wiring here, so the panel really exists before the ticks run.

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

/** Mount the panel's stage into a fake host, as test_no_backdrop does. */
function mountPanel(bucket) {
  const panel = bucket.contributions.find(item => item.id === 'panel' && item.removed !== true)
  assert.ok(panel, 'the Right panel contribution was not registered')
  const nodes = []
  if (typeof panel.render === 'function') expand(panel.render(), nodes)
  const theatre = nodes.find(node => node.props && typeof node.props.ref === 'function')
  assert.equal(typeof (theatre && theatre.props.ref), 'function', 'the panel has no host ref')
  theatre.props.ref(makeElement('div'))
  return panel
}


/** Move time without a tick, so a "just used" hold from boot expires. */
async function elapse(ms) {
  clock.now += ms
  await settle()
}

/** Expire the boot hold and let the one poll the idle cadence already owes
 *  happen, so each scenario measures from a settled state. */
async function warm(bucket) {
  await elapse(HOLD_MS + 1000)
  await advance(bucket, 250)
}

/** Run `ms` of ticks at the host's 250 ms period. */
async function advance(bucket, ms, step = 250) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    clock.now += step
    bucket.tick()
    await settle()
  }
}

const IDLE_MS = 2000
const HIDDEN_MS = 3000
const BUSY_MS = 250
const HIDDEN_PLAYING_MS = 1000
const HOLD_MS = 10000

// ------------------------------------------------------------------ the checks

await record('the tick is still 250 ms and the idle cadences are 2 s / 3 s', async () => {
  const bucket = mount({ enabled: false }, false)
  await settle()
  const tick = bucket.intervals.find(record => !record.cleared)
  assert.ok(tick, 'the plugin registered no polling interval')
  assert.equal(tick.ms, BUSY_MS, `the tick is ${tick.ms} ms, expected ${BUSY_MS}`)
  assert.equal(typeof plugin.idleTest.pollDueMs, 'function', 'pollDueMs() is missing')
  // Let the boot hold expire, then ask the cadence directly.
  await elapse(HOLD_MS + 1000)
  assert.equal(plugin.idleTest.auraBusy(), false, 'an off, idle Aura reports itself busy')
  assert.equal(plugin.idleTest.pollDueMs(), IDLE_MS, 'the visible idle cadence is not 2 s')
  globalThis.document.hidden = true
  globalThis.document.visibilityState = 'hidden'
  assert.equal(plugin.idleTest.pollDueMs(), HIDDEN_MS, 'the hidden idle cadence is not 3 s')
  globalThis.document.hidden = false
  globalThis.document.visibilityState = 'visible'
  bucket.dispose()
  await settle()
})

await record('a. Aura off and nothing playing: 10 s of ticks makes at most 6 /status calls', async () => {
  const bucket = mount({ enabled: false, backdropMode: 'aura' }, false)
  await settle()
  // The owner had not touched Aura for a while: let the boot hold expire so the
  // window measured here is genuinely idle.
  await warm(bucket)
  const before = bucket.status()
  await advance(bucket, 10000)
  const made = bucket.status() - before
  assert.ok(made <= 6, `10 s idle made ${made} /status calls, expected at most 6 (was ~40)`)
  assert.ok(made >= 1, 'idle Aura never polls: a change made elsewhere would never show up')
  bucket.dispose()
  await settle()
})

await record('b. hidden window and idle: 30 s of ticks makes at most 11 /status calls', async () => {
  globalThis.document.hidden = true
  globalThis.document.visibilityState = 'hidden'
  const bucket = mount({ enabled: false, backdropMode: 'aura' }, false)
  await settle()
  await warm(bucket)
  const before = bucket.status()
  await advance(bucket, 30000)
  const made = bucket.status() - before
  assert.ok(made <= 11, `30 s hidden+idle made ${made} /status calls, expected at most 11 (was ~120)`)
  globalThis.document.hidden = false
  globalThis.document.visibilityState = 'visible'
  bucket.dispose()
  await settle()
})

await record('c. Aura on: 2 s of ticks keeps the fast cadence (at least 6 /status calls)', async () => {
  const bucket = mount({ enabled: true, backdropMode: 'aura', panelEnabled: true }, true)
  await settle()
  await warm(bucket)
  const before = bucket.status()
  await advance(bucket, 2000)
  const made = bucket.status() - before
  assert.ok(made >= 6, `2 s with Aura on made only ${made} /status calls: the visualiser got slower`)
  bucket.dispose()
  await settle()
})

await record('d. switching an idle Aura on answers within 300 ms', async () => {
  const bucket = mount({ enabled: false, backdropMode: 'aura' }, false)
  await settle()
  await warm(bucket)
  // Precondition: the tick really is idle, so the answer cannot come from it.
  // 1.5 s is inside the 2 s idle glance, so no poll may happen here.
  const idleBefore = bucket.status()
  await advance(bucket, 1500)
  assert.equal(bucket.status() - idleBefore, 0,
    'an idle Aura polled on every tick: there is no idle cadence to wake from')
  assert.equal(typeof plugin.idleTest.setEnabled, 'function', 'setEnabled() is not exposed')
  const beforeSwitch = bucket.status()
  void plugin.idleTest.setEnabled(true)
  await settle()
  assert.ok(bucket.status() > beforeSwitch,
    'turning Aura on did not ask /status at once: the switch would wait for an idle glance')
  // And the fast cadence is back: one 250 ms tick later it asks again.
  const afterSwitch = bucket.status()
  await advance(bucket, 300)
  assert.ok(bucket.status() > afterSwitch, 'the fast cadence did not resume after turning Aura on')
  bucket.dispose()
  await settle()
})

await record('e. moving the mouse over the app does not wake an idle Aura', async () => {
  const bucket = mount({ enabled: false, backdropMode: 'aura' }, false)
  await settle()
  await warm(bucket)
  // The strip's mousemove listener is document-wide: every pointer move in
  // Hermes reaches it. That must not count as using Aura.
  const before = bucket.status()
  for (let i = 0; i < 40; i += 1) {
    plugin.idleTest.onVideoBarMouseMove()
    await advance(bucket, 250)
  }
  const made = bucket.status() - before
  assert.equal(plugin.idleTest.auraBusy(), false, 'a pointer move over the app marked an unused Aura busy')
  assert.ok(made <= 6, `10 s of pointer moves made ${made} /status calls, expected at most 6`)
  bucket.dispose()
  await settle()
})

await record('f. Aura off with the visualiser placed in the panel: 10 s of ticks makes at most 6 /status calls', async () => {
  // The owner's measured state: the app's own switch is off, the Right panel is
  // still registered, and the backend still reports Aura enabled, so a surface
  // is placed while nothing draws. That must not be worth a 4 Hz poll.
  const bucket = mount({ enabled: false, backdropMode: 'aura', panelEnabled: true }, true)
  await settle()
  mountPanel(bucket)
  await settle()
  assert.ok(plugin.idleTest.surface.get().placement, 'precondition: no Aura surface is placed')
  await warm(bucket)
  const before = bucket.status()
  await advance(bucket, 10000)
  const made = bucket.status() - before
  assert.ok(made <= 6, `10 s with a placed surface and Aura off made ${made} /status calls, expected at most 6`)
  assert.equal(plugin.idleTest.auraBusy(), false, 'a placed surface alone marked Aura busy')
  bucket.dispose()
  await settle()
})

await record('g. Aura on, surface placed, window hidden and nothing playing: 30 s makes at most 11 /status calls', async () => {
  globalThis.document.hidden = true
  globalThis.document.visibilityState = 'hidden'
  const bucket = mount({ enabled: true, backdropMode: 'aura', panelEnabled: true }, true)
  await settle()
  mountPanel(bucket)
  await settle()
  assert.ok(plugin.idleTest.surface.get().placement, 'precondition: no Aura surface is placed')
  await warm(bucket)
  const before = bucket.status()
  await advance(bucket, 30000)
  const made = bucket.status() - before
  assert.ok(made <= 11, `30 s hidden with a placed surface made ${made} /status calls, expected at most 11`)
  globalThis.document.hidden = false
  globalThis.document.visibilityState = 'visible'
  bucket.dispose()
  await settle()
})

await record('h. Aura on, surface placed and visible: 2 s keeps the fast cadence (at least 6 /status calls)', async () => {
  const bucket = mount({ enabled: true, backdropMode: 'aura', panelEnabled: true }, true)
  await settle()
  mountPanel(bucket)
  await settle()
  assert.ok(plugin.idleTest.surface.get().placement, 'precondition: no Aura surface is placed')
  await warm(bucket)
  const before = bucket.status()
  await advance(bucket, 2000)
  const made = bucket.status() - before
  assert.ok(made >= 6, `2 s with a placed, visible visualiser made only ${made} /status calls: the visualiser got slower`)
  bucket.dispose()
  await settle()
})

await record('i. radio playing with the window hidden: 10 s makes 8..12 /status calls (1 s cadence)', async () => {
  globalThis.document.hidden = true
  globalThis.document.visibilityState = 'hidden'
  const bucket = mount({ enabled: false, backdropMode: 'aura', panelEnabled: true }, false)
  await settle()
  const audio = plugin.idleTest.audio.get()
  plugin.idleTest.audio.set({ ...audio, url: 'https://ice.example/live.mp3', label: 'Live', playing: true, reportedAt: clock.now })
  await warm(bucket)
  assert.equal(plugin.idleTest.pollDueMs(), HIDDEN_PLAYING_MS,
    'a hidden, playing radio does not use the 1 s cadence')
  const before = bucket.status()
  await advance(bucket, 10000)
  const made = bucket.status() - before
  assert.ok(made >= 8 && made <= 12,
    `10 s of hidden radio made ${made} /status calls, expected 8..12 (was ~40 at 4 Hz)`)
  globalThis.document.hidden = false
  globalThis.document.visibilityState = 'visible'
  bucket.dispose()
  await settle()
})

await record('j. a film playing with the window hidden: 10 s makes 8..12 /status calls (1 s cadence)', async () => {
  globalThis.document.hidden = true
  globalThis.document.visibilityState = 'hidden'
  const bucket = mount({ enabled: false, backdropMode: 'aura', panelEnabled: true }, false)
  await settle()
  const video = plugin.idleTest.video.get()
  plugin.idleTest.video.set({ ...video, url: 'https://www.youtube.com/watch?v=demo', title: 'Demo', playing: true, reportedAt: clock.now })
  await warm(bucket)
  assert.equal(plugin.idleTest.pollDueMs(), HIDDEN_PLAYING_MS,
    'a hidden, playing film does not use the 1 s cadence')
  const before = bucket.status()
  await advance(bucket, 10000)
  const made = bucket.status() - before
  assert.ok(made >= 8 && made <= 12,
    `10 s of a hidden playing film made ${made} /status calls, expected 8..12`)
  globalThis.document.hidden = false
  globalThis.document.visibilityState = 'visible'
  bucket.dispose()
  await settle()
})

await record('k. radio playing with the window visible: 2 s keeps the fast cadence (at least 6 /status calls)', async () => {
  const bucket = mount({ enabled: false, backdropMode: 'aura', panelEnabled: true }, false)
  await settle()
  const audio = plugin.idleTest.audio.get()
  plugin.idleTest.audio.set({ ...audio, url: 'https://ice.example/live.mp3', label: 'Live', playing: true, reportedAt: clock.now })
  await warm(bucket)
  assert.equal(plugin.idleTest.pollDueMs(), BUSY_MS, 'a visible, playing radio lost the 4 Hz cadence')
  const before = bucket.status()
  await advance(bucket, 2000)
  const made = bucket.status() - before
  assert.ok(made >= 6, `2 s of visible radio made only ${made} /status calls: the music lost its levels`)
  bucket.dispose()
  await settle()
})

await record('l. hidden and idle: an agent audio request is handled within 3.5 s', async () => {
  globalThis.document.hidden = true
  globalThis.document.visibilityState = 'hidden'
  const bucket = mount({ enabled: true, backdropMode: 'aura', panelEnabled: true }, true)
  await settle()
  mountPanel(bucket)
  await settle()
  const frame = makeElement('iframe')
  frame.src = 'http://127.0.0.1:4321/player.html?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Ddemo'
  plugin.idleTest.setFilm(frame)
  await warm(bucket)
  assert.equal(plugin.idleTest.auraBusy(), false,
    'precondition: hidden with nothing playing must be idle, not busy')
  // The agent's "play this" lands on the server now; only a poll discovers it.
  const askedAt = clock.now
  bucket.audioRequests.push({ seq: 1, action: 'play', url: 'https://ice.example/live.mp3', label: 'Live', at: askedAt })
  let handledAfter = null
  for (let t = 250; t <= 3500; t += 250) {
    clock.now += 250
    bucket.tick()
    await settle()
    if (plugin.idleTest.settings.get().audioRequestSeq >= 1) {
      handledAfter = clock.now - askedAt
      break
    }
  }
  assert.ok(handledAfter !== null && handledAfter <= 3500,
    `the agent's play request was ${handledAfter === null ? 'not handled within 3.5 s' : 'handled after ' + handledAfter + ' ms'}: the hidden idle glance is too slow`)
  const command = plugin.audioState().lastCommand
  assert.ok(command && command.cmd === 'play' && command.url === 'https://ice.example/live.mp3',
    'the request was consumed but no play command reached the frame')
  globalThis.document.hidden = false
  globalThis.document.visibilityState = 'visible'
  bucket.dispose()
  await settle()
})

await record('m. Aura off: 10 s of frame telemetry every 250 ms makes at most 6 /status calls', async () => {
  const bucket = mount({ enabled: false, backdropMode: 'aura' }, false)
  await settle()
  const frame = makeElement('iframe')
  frame.src = 'http://127.0.0.1:4321/player.html?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Ddemo'
  plugin.idleTest.setFilm(frame)
  // The frame's first report after mounting (a new source — a real edge).
  // What follows in the measured window is the routine position report
  // player.html posts at <= 4 Hz, with nothing changing.
  const report = position => ({
    source: frame.contentWindow,
    data: {
      aura: 'video-state', url: 'https://www.youtube.com/watch?v=demo', kind: 'youtube',
      playing: false, position, duration: 600, muted: false, title: 'Demo', controllable: true
    }
  })
  plugin.idleTest.onBackdropMessage(report(60))
  await warm(bucket)
  const before = bucket.status()
  let position = 60
  for (let t = 0; t < 10000; t += 250) {
    clock.now += 250
    position += 0.25
    plugin.idleTest.onBackdropMessage(report(position))
    bucket.tick()
    await settle()
  }
  const made = bucket.status() - before
  assert.ok(made <= 6,
    `10 s of routine telemetry made ${made} /status calls, expected at most 6: the reports kept Aura busy`)
  assert.equal(plugin.idleTest.auraBusy(), false, 'a periodic position report marked Aura busy')
  bucket.dispose()
  await settle()
})

await record('n. a new build leaves a saved enabled:false off, even with no user-chosen flag', async () => {
  const bucket = mount({ enabled: false, backdropMode: 'aura' }, false)
  // The server (or an older build) wrote enabled:false without recording who
  // chose it. The saved Off itself must survive the update, not just the flag.
  bucket.storage.set('userChoseOff', false)
  await settle()   // /version answers -> turnOnForNewBuild
  await warm(bucket)
  await advance(bucket, 3000)
  assert.equal(plugin.idleTest.settings.get().enabled, false,
    'a new build switched a saved Off back on')
  assert.ok(!bucket.controls.some(body => body && body.enabled === true),
    'a new build sent /control {enabled:true} over a saved Off')
  bucket.dispose()
  await settle()
})

await record('o. a first install with no saved settings still starts switched on', async () => {
  const bucket = mount(null, false)
  await settle()
  await warm(bucket)
  await advance(bucket, 3000)
  assert.equal(plugin.idleTest.settings.get().enabled, true,
    'a first install no longer starts switched on')
  bucket.dispose()
  await settle()
})

// ------------------------------------------------------------------ report

for (const line of results) console.log(line)
console.log(`\nidle poll: ${results.length - failed}/${results.length}`)
process.exit(failed ? 1 : 0)
