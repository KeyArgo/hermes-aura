/**
 * The Desktop OS window must follow the backdrop mode (owner bug): in
 * Visualizer mode "Desktop" in Watch in / Send to opened the FILM page
 * (player.html) even though the panel and the watch window showed the
 * visualiser. These checks fail on that build and pass once the window
 * opens the visualiser page in Visualizer mode, keeps the film in Video
 * mode, swaps pages when the mode changes while it is open, and never
 * carries the server token in a window URL or request body.
 *
 * Run: node tests/test_desktop_visualiser.mjs
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
const LIVE_TOKEN = 'not-shown-in-ui'

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

// ------------------------------------------------------------- DOM stubs

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
    getBoundingClientRect() { return { width: 320, height: 180, left: 0, top: 0, right: 320, bottom: 180 } },
    remove() { if (this.parentNode) this.parentNode.removeChild(this) },
    querySelector() { throw new Error('querySelector') },
    querySelectorAll() { throw new Error('querySelectorAll') },
    get firstChild() { return this.children[0] || null }
  }
  return node
}

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
    appendChild(node) { node.parentNode = this; children.push(node); return node },
    removeChild(node) {
      const index = children.indexOf(node)
      if (index >= 0) children.splice(index, 1)
      node.parentNode = null
      return node
    },
    querySelector() { throw new Error('querySelector') },
    querySelectorAll() { throw new Error('querySelectorAll') }
  }
}

const documentElement = {
  style: {},
  attributes: {},
  setAttribute(name, value) { this.attributes[name] = String(value) },
  getAttribute(name) { return this.attributes[name] },
  removeAttribute(name) { delete this.attributes[name] },
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) }
}

globalThis.document = {
  hidden: false,
  visibilityState: 'visible',
  documentElement,
  head: makeParent([]),
  body: makeParent([]),
  createElement: makeElement,
  addEventListener() {},
  removeEventListener() {},
  querySelector() { throw new Error('querySelector') },
  querySelectorAll() { throw new Error('querySelectorAll') },
  getElementById() { throw new Error('getElementById') }
}
globalThis.getComputedStyle = () => ({ backgroundColor: 'rgba(0,0,0,0)', getPropertyValue: () => '' })

// ---------------------------------------------------------- plugin module

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aura-deskviz-'))
const pluginCopy = path.join(tmp, 'plugin.mjs')
fs.writeFileSync(
  pluginCopy,
  fs.readFileSync(PLUGIN, 'utf8')
    .replace(/from\s+'@hermes\/plugin-sdk'/g, "from './sdk-stub.mjs'")
    .replace(/from\s+'react'/g, "from './react-stub.mjs'")
    .replace(/from\s+'react\/jsx-runtime'/g, "from './jsx-stub.mjs'") +
  '\nexport const deskvizTest = { setDesktopWindow, setBackdropMode, openDesktopWindow, setEnabled, sync: typeof syncPlayerOwnership === "function" ? syncPlayerOwnership : null, poll, settings: $settings, live: $live, owned: () => desktopOwned, placement: filmPlacement, hint: panelHintState }\n'
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

// ------------------------------------------------------------- ctx harness

function makeCtx(settings, windowState, openFailure = '') {
  const contributions = []
  const storage = new Map()
  const requests = []
  const win = windowState || { open: false, page: '' }
  if (settings) storage.set('settings', settings)
  const serverFrame = {
    level: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0], silence: true, mood: 'idle', enabled: true
  }
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
    setTimeout(fn, ms) { return () => {} },
    addEventListener() { return () => {} },
    storage: {
      get(key, fallback) { return storage.has(key) ? storage.get(key) : fallback },
      set(key, value) { storage.set(key, value) },
      remove(key) { storage.delete(key) }
    },
    async rest(route, options = {}) {
      requests.push({ route, options })
      if (route === '/status') {
        return { ok: true, port: 4321, url: `http://127.0.0.1:4321/?token=${LIVE_TOKEN}`, capture: 'none', enabled: true }
      }
      if (route === '/state') return { ...serverFrame, bands: [...serverFrame.bands] }
      if (route === '/version') return { version: '1.2.3' }
      if (route === '/control') return { ok: true }
      if (route === '/window') return { ok: true, available: true, open: win.open, page: win.page }
      if (route === '/window/open') {
        const body = options.body || {}
        if (openFailure) {
          // The host rejects a refusal with "<status>: {body}" — the shape the
          // plugin has to read the server's sentence out of.
          throw new Error(`503: ${JSON.stringify({ ok: false, error: openFailure, window: { open: false, page: '' } })}`)
        }
        win.open = true
        win.page = body.page === 'visualizer' ? 'visualizer' : 'player'
        return { ok: true, open: true, url: body.url || '' }
      }
      if (route === '/window/close') {
        win.open = false
        win.page = ''
        return { ok: true, closed: true, window: { open: false } }
      }
      if (route === '/player') {
        return { ok: true, seq: 1, window: { open: win.open, page: win.page }, player: { desktop: win.open } }
      }
      if (route === '/player/report') return { ok: true }
      if (route === '/player/commands?after=0') return { ok: true, head_seq: 1, commands: [] }
      return { ok: true }
    }
  }
  return { ctx, contributions, storage, requests, win }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const opensIn = bucket => bucket.requests.filter(r => r.route === '/window/open')

// ------------------------------------------------------------------ tests

await record('Desktop in Visualizer mode opens the visualiser page, with no film loaded', async () => {
  const bucket = makeCtx({ enabled: true, backdropMode: 'aura', panelEnabled: true, videoUrl: '' })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    await plugin.deskvizTest.setDesktopWindow(true)
    const opens = opensIn(bucket)
    assert.equal(opens.length, 1, 'Visualizer mode never asked for a desktop window (the film-only guard refused)')
    const body = opens[0].options.body
    assert.equal(body.page, 'visualizer', 'the desktop window was not asked to show the visualiser page')
    assert.ok(!body.url, 'the visualiser pop-out still sent a film url')
    assert.equal(plugin.deskvizTest.owned(), true, 'the plugin does not own the visualiser window')
    assert.ok(!JSON.stringify(opens.map(o => o.options.body)).includes(LIVE_TOKEN),
      'the window request carried the server token')
  } finally {
    dispose()
  }
})

await record('Desktop in Video mode still opens the film', async () => {
  const bucket = makeCtx({ enabled: true, backdropMode: 'video', panelEnabled: true, videoUrl: FILM, videoClosed: false })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    await plugin.deskvizTest.setDesktopWindow(true)
    const opens = opensIn(bucket)
    assert.equal(opens.length, 1, 'Video mode did not open a desktop window')
    const body = opens[0].options.body
    assert.equal(body.page, 'player', 'the film pop-out did not say it wants the player page')
    assert.equal(body.url, FILM, 'the film pop-out lost its url')
    assert.equal(plugin.deskvizTest.owned(), true)
  } finally {
    dispose()
  }
})

await record('switching mode while the Desktop window is open swaps what it shows', async () => {
  const bucket = makeCtx({ enabled: true, backdropMode: 'aura', panelEnabled: true, videoUrl: FILM, videoClosed: false })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    await plugin.deskvizTest.setDesktopWindow(true)
    assert.equal(opensIn(bucket).length, 1)
    assert.equal(opensIn(bucket)[0].options.body.page, 'visualizer')
    // Visualizer -> Video: the open window must become the film.
    await plugin.deskvizTest.setBackdropMode('video')
    let opens = opensIn(bucket)
    assert.equal(opens.length, 2, 'switching to Video left the open window on the visualiser')
    assert.equal(opens[1].options.body.page, 'player')
    assert.equal(opens[1].options.body.url, FILM)
    assert.equal(plugin.deskvizTest.owned(), true, 'the mode switch lost ownership of the window')
    // Video -> Visualizer: and back again.
    await plugin.deskvizTest.setBackdropMode('aura')
    opens = opensIn(bucket)
    assert.equal(opens.length, 3, 'switching to Visualizer left the open window on the film')
    assert.equal(opens[2].options.body.page, 'visualizer')
    assert.equal(bucket.win.page, 'visualizer')
  } finally {
    dispose()
  }
})

await record('the ownership poll reconciles a window showing the wrong page', async () => {
  // A mode change can land while a slow open is still in flight; the poll is
  // the authoritative reconciliation, so it must fix a stale page too.
  const bucket = makeCtx({ enabled: true, backdropMode: 'aura', panelEnabled: true, videoUrl: '' },
    { open: true, page: 'player' })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    await plugin.deskvizTest.sync()
    const opens = opensIn(bucket)
    assert.ok(opens.length >= 1, 'the poll left the film page up in Visualizer mode')
    assert.equal(opens[opens.length - 1].options.body.page, 'visualizer')
  } finally {
    dispose()
  }
})

await record('reduced motion travels to the visualiser window', async () => {
  const bucket = makeCtx({ enabled: true, backdropMode: 'aura', panelEnabled: true, videoUrl: '', reducedMotion: true })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    await plugin.deskvizTest.setDesktopWindow(true)
    const opens = opensIn(bucket)
    assert.equal(opens.length, 1)
    assert.equal(opens[0].options.body.reducedMotion, true, 'reduced motion was not sent to the window')
  } finally {
    dispose()
  }
})

await record('Off still closes the visualiser Desktop window', async () => {
  const bucket = makeCtx({ enabled: true, backdropMode: 'aura', panelEnabled: true, videoUrl: '' })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    await plugin.deskvizTest.setDesktopWindow(true)
    assert.equal(plugin.deskvizTest.owned(), true)
    plugin.deskvizTest.settings.set({ ...plugin.deskvizTest.settings.get(), enabled: false })
    plugin.deskvizTest.live.set({ ...plugin.deskvizTest.live.get(), ok: true, enabled: false })
    await plugin.deskvizTest.sync()
    assert.ok(bucket.requests.some(r => r.route === '/window/close'),
      'Off did not close the visualiser desktop window')
    assert.equal(plugin.deskvizTest.owned(), false)
  } finally {
    dispose()
  }
})

await record('the in-app visualiser parks while the Desktop window shows it', async () => {
  const bucket = makeCtx({ enabled: true, backdropMode: 'aura', panelEnabled: true, videoUrl: '' })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    await plugin.deskvizTest.setDesktopWindow(true)
    assert.equal(plugin.deskvizTest.owned(), true)
    assert.equal(plugin.deskvizTest.placement(), '',
      'the panel kept a second visualiser running beside the Desktop window')
  } finally {
    dispose()
  }
})

await record('unloading the plugin closes the Desktop window', async () => {
  const bucket = makeCtx({ enabled: true, backdropMode: 'aura', panelEnabled: true, videoUrl: '' })
  const dispose = plugin.default.register(bucket.ctx)
  await sleep(30)
  await plugin.deskvizTest.setDesktopWindow(true)
  assert.equal(plugin.deskvizTest.owned(), true)
  dispose()
  await sleep(10)
  assert.ok(bucket.requests.some(r => r.route === '/window/close'),
    'dispose left the OS window running')
})

await record('a refused Desktop open says why, then falls back to the in-app window', async () => {
  // The owner's bug: after a backend restart the window from the old server
  // still held the profile, so Desktop 503'd and the plugin fell back without a
  // word. The server's own sentence has to reach the user, not a blanket
  // "the local server is not answering".
  const reason = 'google-chrome exited immediately (is another Aura window already open?)'
  const bucket = makeCtx({ enabled: true, backdropMode: 'video', panelEnabled: true, videoUrl: FILM, videoClosed: false },
    null, reason)
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    await plugin.deskvizTest.setDesktopWindow(true)
    assert.equal(opensIn(bucket).length, 1, 'the Desktop click never asked the server for a window')
    assert.equal(plugin.deskvizTest.owned(), false, 'a refused window was still claimed as open')
    assert.match(plugin.deskvizTest.live.get().error, /exited immediately/,
      'the fall-back threw the server\'s reason away')
    assert.match(plugin.deskvizTest.hint().text, /exited immediately/,
      'the pane never showed why the Desktop window did not open')
  } finally {
    dispose()
  }
})

await record('the visualiser watch window closes when the Desktop window takes the picture', async () => {
  const bucket = makeCtx({ enabled: true, backdropMode: 'aura', panelEnabled: true, videoUrl: '', videoWindow: true })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    await plugin.deskvizTest.setDesktopWindow(true)
    assert.equal(plugin.deskvizTest.owned(), true)
    assert.equal(plugin.deskvizTest.settings.get().videoWindow, false,
      'the watch window stayed switched on behind the Desktop visualiser')
  } finally {
    dispose()
  }
})

await record('a mode switch with a poll in flight swaps the Desktop window once', async () => {
  const bucket = makeCtx({ enabled: true, backdropMode: 'aura', panelEnabled: true, videoUrl: FILM, videoClosed: false })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    await plugin.deskvizTest.setDesktopWindow(true)
    assert.equal(opensIn(bucket).length, 1)
    const switching = plugin.deskvizTest.setBackdropMode('video')
    await Promise.all([plugin.deskvizTest.sync(), plugin.deskvizTest.sync(), switching])
    assert.equal(opensIn(bucket).length, 2, 'the poll launched a second window during the mode switch')
    assert.equal(bucket.win.page, 'player')
  } finally {
    dispose()
  }
})

await record('Off sends one close, even with a poll in flight', async () => {
  const bucket = makeCtx({ enabled: true, backdropMode: 'aura', panelEnabled: true, videoUrl: '' })
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    await plugin.deskvizTest.setDesktopWindow(true)
    // The poll reads the window as open, then Off lands before it acts.
    const poll = plugin.deskvizTest.sync()
    const off = plugin.deskvizTest.setEnabled(false)
    plugin.deskvizTest.live.set({ ...plugin.deskvizTest.live.get(), ok: true, enabled: false })
    await Promise.all([poll, off])
    const closes = bucket.requests.filter(r => r.route === '/window/close')
    assert.equal(closes.length, 1, `Off sent ${closes.length} closes`)
  } finally {
    dispose()
  }
})

await record('a refused Desktop open in Visualizer mode names the visualiser window', async () => {
  const bucket = makeCtx({ enabled: true, backdropMode: 'aura', panelEnabled: true, videoUrl: '' },
    null, 'no Chrome or Chromium found')
  const dispose = plugin.default.register(bucket.ctx)
  try {
    await sleep(30)
    await plugin.deskvizTest.setDesktopWindow(true)
    assert.match(plugin.deskvizTest.live.get().error, /visualiser window/,
      'the Visualizer-mode error talks about a film window')
  } finally {
    dispose()
  }
})

// ------------------------------------------- the window page itself (static)

const indexHtml = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8')
const auraJs = fs.readFileSync(path.join(ROOT, 'web', 'aura.js'), 'utf8')
const audioJs = fs.readFileSync(path.join(ROOT, 'web', 'audio.js'), 'utf8')

await record('the visualiser page bootstraps a one-time ticket, never a URL token', () => {
  assert.match(indexHtml, /\/api\/window\/bootstrap/, 'index.html has no ticket bootstrap')
  assert.match(indexHtml, /params\.delete\('ticket'\)/, 'the ticket is not scrubbed from the address')
  assert.match(indexHtml, /history\.replaceState/, 'the ticket stays in the address bar')
  assert.match(indexHtml, /auraDesktopToken/, 'the bootstrapped token is not kept for the page scripts')
  assert.doesNotMatch(indexHtml, /[?&]token=/, 'index.html builds a token-bearing URL')
})

await record('aura.js and audio.js accept the bootstrapped desktop token', () => {
  assert.match(auraJs, /sessionStorage\.getItem\('auraDesktopToken'\)/,
    'aura.js only reads ?token=, so the ticket-bootstrapped window has no token')
  assert.match(audioJs, /sessionStorage\.getItem\('auraDesktopToken'\)/,
    'audio.js only reads ?token= for the radio stream')
})

await record('the REVamp card copies a command Hermes actually has', () => {
  const source = fs.readFileSync(path.join(ROOT, 'desktop', 'plugin.js'), 'utf8')
  const install = source.match(/const REVAMP_INSTALL = '([^']+)'/)
  assert.ok(install, 'REVAMP_INSTALL is gone')
  assert.match(install[1], /^hermes plugins install \S+$/,
    '"hermes plugin" is not a Hermes command; the copied line fails when pasted')
})

// ------------------------------------------------------------------ report

for (const line of results) process.stdout.write(line + '\n')
process.stdout.write(`${results.length - failed}/${results.length} passed\n`)
if (failed) process.exit(1)
