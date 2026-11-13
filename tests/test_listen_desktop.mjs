/**
 * [listen lane] Desktop-half audio tests: web/audio.js is checked elsewhere
 * (it needs a browser); this file proves the parts a headless Node process can
 * prove about desktop/plugin.js:
 *
 *   1. readAudioSettings() validates the audio settings the way readSettings
 *      expects: strings trimmed and capped, volume clamped, booleans typed,
 *      seq a positive integer, and no label left behind without a URL;
 *   2. handleAudioRequest() honours the seq contract: a new seq plays, an old
 *      seq never replays, the seq is remembered in settings, and a request
 *      older than 60 s is ignored on the first poll (but not later);
 *   3. stop / volume / mute_video / unmute_video travel to the page through
 *      the same bridge and touch only their own setting (the video's mute is
 *      not the audio channel's);
 *   4. the page that hosts audio.js (web/audio.js) exists whenever the music
 *      does — including while the film is closed — and it is the SDK's
 *      SandboxedFrame inside Aura's own surfaces, not an iframe on the app
 *      body;
 *   5. REVAMP_PITCH says what it must say, and revampCard() wires
 *      "Open REVamp" to host.navigate('/revamp') and "Get REVamp" to the
 *      public repo.
 *
 * The plugin is imported from a temp copy with its three import specifiers
 * rewritten to local stubs, exactly like tests/test_desktop_plugin.mjs does.
 * The SDK stub records every SandboxedFrame it is handed in
 * `globalThis.__sdkFrames` and posts the frame's own messages into
 * `globalThis.__sdkFrameMessages`, which is what "reaches the page" means here.
 *
 * Run: node tests/test_listen_desktop.mjs
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

async function record(name, fn) {
  try {
    await fn()
    results.push(`PASS ${name}`)
  } catch (error) {
    failed += 1
    results.push(`FAIL ${name}: ${error && error.message ? error.message : error}`)
  }
}

// ------------------------------------------------------------------ document

const bodyChildren = []
const headChildren = []

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
    // Every iframe the plugin mounts talks back: that is how the audio and
    // video commands are observed from here.
    node.contentWindow = { postMessage: message => { sent.push(message) } }
  }
  return node
}

globalThis.document = {
  hidden: false,
  visibilityState: 'visible',
  documentElement: { style: {} },
  head: makeParent(headChildren),
  body: makeParent(bodyChildren),
  createElement: makeElement,
  addEventListener() {},
  removeEventListener() {}
}
globalThis.getComputedStyle = () => ({ backgroundColor: 'rgba(0, 0, 0, 0)', getPropertyValue: () => '' })

// ------------------------------------------------------------- temp module

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aura-listen-test-'))
const pluginCopy = path.join(tmp, 'plugin.mjs')

const source = fs.readFileSync(PLUGIN, 'utf8')
fs.writeFileSync(
  pluginCopy,
  source
    .replace(/from\s+'@hermes\/plugin-sdk'/g, "from './sdk-stub.mjs'")
    .replace(/from\s+'react'/g, "from './react-stub.mjs'")
    .replace(/from\s+'react\/jsx-runtime'/g, "from './jsx-stub.mjs'")
)

fs.writeFileSync(path.join(tmp, 'sdk-stub.mjs'), `
export const calls = { navigations: [], external: [] }
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
export const COMPOSER_AREAS = {
  top: 'composer.top', bottom: 'composer.bottom', underside: 'composer.underside',
  leading: 'composer.leading', actions: 'composer.actions', middleware: 'composer.middleware',
  attachments: 'composer.attachments', microActions: 'composer.microActions',
  atCompletions: 'composer.atCompletions', modelPill: 'composer.modelPill', contextMenu: 'composer.contextMenu'
}

// The SDK's sandboxed frame. The film/visualiser page is drawn by THIS element
// (React), not by a raw iframe the plugin appends to the app body, so the stub
// records what it was handed AND hands the plugin the frame node its ref would
// get: that node's contentWindow is the page the audio commands must reach.
export const frames = []
globalThis.__sdkFrames = frames
globalThis.__sdkFrameMessages = []
const frameNode = { contentWindow: { postMessage: message => { globalThis.__sdkFrameMessages.push(message) } } }
export const SandboxedFrame = props => {
  frames.push(props)
  if (typeof props.ref === 'function') props.ref(frameNode)
  return null
}
`)

fs.writeFileSync(path.join(tmp, 'react-stub.mjs'), `
export const Fragment = Symbol.for('react.fragment')
export function useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] }
export function useEffect(fn) { }
export function useLayoutEffect(fn) { }
export function useRef(value) { return { current: value } }
export function useMemo(fn) { return fn() }
export function useCallback(fn) { return fn }
`)

fs.writeFileSync(path.join(tmp, 'jsx-stub.mjs'), `
export function jsx(type, props, key) { return { type, props, key } }
export const jsxs = jsx
export const Fragment = Symbol.for('react.fragment')
`)

const sdkStub = await import(pathToFileURL(path.join(tmp, 'sdk-stub.mjs')).href)
const plugin = await import(pathToFileURL(pluginCopy).href)

// -------------------------------------------------------------------- ctx

function makeCtx(initialSettings) {
  const storage = new Map()
  if (initialSettings) storage.set('settings', initialSettings)
  const messages = []
  const contributions = []
  const intervals = []
  const ctx = {
    source: 'plugin:aura',
    os: { openExternal: url => { sdkStub.calls.external.push(url); return true } },
    register(contribution) {
      const entry = { ...contribution }
      contributions.push(entry)
      return () => {
        const index = contributions.indexOf(entry)
        if (index >= 0) contributions.splice(index, 1)
      }
    },
    registerSettingsPage(page) { return ctx.register(page) },
    onDispose() {},
    setInterval(fn) { intervals.push(fn); return () => {} },
    setTimeout(fn) { return () => {} },
    addEventListener() { return () => {} },
    storage: {
      get(key, fallback) { return storage.has(key) ? storage.get(key) : fallback },
      set(key, value) { storage.set(key, value) },
      remove(key) { storage.delete(key) }
    },
    async rest(route) {
      messages.push(route)
      if (route === '/status') {
        return { ok: true, port: 4321, url: 'http://127.0.0.1:4321/?token=x', capture: 'none', enabled: true }
      }
      if (route === '/state') {
        return { level: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0], silence: true, mood: 'idle', audio_request: null }
      }
      if (route === '/version') return { version: '1.0.0' }
      return { ok: true }
    }
  }
  return { ctx, storage, messages, contributions, intervals }
}

// The page the audio channel lives in is an SDK SandboxedFrame rendered inside
// Aura's own surfaces (never an iframe appended to the app body), so a test has
// to let React do its job: expand function elements until the frame is drawn
// and the recorded props hold the src the page will load.
const expandTree = (node, depth = 0) => {
  if (depth > 8 || node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(child => expandTree(child, depth)); return }
  if (typeof node.type === 'function') {
    const out = node.type(node.props || {})
    if (!out || typeof out !== 'object') return
    node.type = out.type
    node.props = out.props
    if (typeof node.type === 'function') { expandTree(node, depth + 1); return }
  }
  if (node.props) expandTree(node.props.children, depth + 1)
}

// The frames the SDK stub was handed since the last reset.
const framed = () => globalThis.__sdkFrames
const clearFrames = () => { globalThis.__sdkFrames.length = 0 }

// Capture what the plugin posts to its page: the contract is the message, not
// the DOM. The stub's frame node records every postMessage it receives.
const sent = globalThis.__sdkFrameMessages

// Mount the docked pane's tree the way a real render does, so the film/audio
// page exists before a command is posted into it.
function mountSurface(contributions) {
  const pane = contributions.find(contribution => contribution.area === 'panes')
  if (!pane) return null
  const tree = pane.render()
  expandTree(tree)
  return tree
}

// A fresh instance with a mounted surface — the audio channel only exists while
// the page that hosts it does. One poll tick fills the live server state (url +
// token) the frame's src is built from.
async function remount(settings = {}) {
  clearFrames()
  const { ctx, contributions, intervals } = makeCtx({ enabled: true, windowVisual: true, backdropMode: 'aura', ...settings })
  const dispose = plugin.default.register(ctx)
  if (intervals.length) intervals[0]()
  await new Promise(resolve => setTimeout(resolve, 20))
  mountSurface(contributions)
  return dispose
}

// --------------------------------------------------------------- the checks

await record('default export is still { id, name, register }', () => {
  assert.equal(plugin.default.id, 'aura')
  assert.equal(typeof plugin.default.register, 'function')
})

let api
await record('register() exposes the audio functions', async () => {
  const dispose = await remount({ audioVolume: 0.4, videoMuted: false, audioRequestSeq: 3 })
  api = {
    playAudioSource: plugin.playAudioSource,
    stopAudio: plugin.stopAudio,
    setAudioVolume: plugin.setAudioVolume,
    setVideoMuted: plugin.setVideoMuted,
    handleAudioRequest: plugin.handleAudioRequest,
    revampCard: plugin.revampCard,
    readAudioSettings: plugin.readAudioSettings,
    audioState: plugin.audioState,
    pitch: plugin.REVAMP_PITCH,
    dispose
  }
  for (const [name, fn] of Object.entries(api)) {
    if (name === 'pitch') continue
    assert.equal(typeof fn, 'function', `${name} is not exported`)
  }
  assert.equal(api.audioState().settings.audioVolume, 0.4)
  assert.equal(api.audioState().settings.audioRequestSeq, 3)
})

await record('readAudioSettings validates every key', () => {
  const empty = api.readAudioSettings(null)
  assert.equal(empty.audioUrl, '')
  assert.equal(empty.audioVolume, 0.7)
  assert.equal(empty.videoMuted, false)
  assert.equal(empty.audioRequestSeq, 0)
  const messy = api.readAudioSettings({
    audioUrl: `  https://ice.example/stream.mp3  `,
    audioLabel: '  NTS 1  ',
    audioVolume: 3,
    videoMuted: 'yes',
    audioRequestSeq: -4
  })
  assert.equal(messy.audioUrl, 'https://ice.example/stream.mp3')
  assert.equal(messy.audioLabel, 'NTS 1')
  assert.equal(messy.audioVolume, 1, 'volume must clamp to 0..1')
  assert.equal(messy.videoMuted, false, 'a non-boolean mute is not a mute')
  assert.equal(messy.audioRequestSeq, 0, 'a negative seq is not a seq')
  const noUrl = api.readAudioSettings({ audioUrl: '', audioLabel: 'stale label', audioVolume: 0.2 })
  assert.equal(noUrl.audioLabel, '', 'a label without a URL must not survive')
  assert.equal(noUrl.audioVolume, 0.2)
  const long = api.readAudioSettings({ audioUrl: 'u'.repeat(4000), audioLabel: 'l'.repeat(400) })
  assert.ok(long.audioUrl.length <= 2048)
  assert.ok(long.audioLabel.length <= 120)
})

await record('handleAudioRequest: no request is not an action', () => {
  assert.equal(api.handleAudioRequest({}), 'none')
  assert.equal(api.handleAudioRequest(null), 'none')
  assert.equal(api.handleAudioRequest({ audio_request: null }), 'none')
})

await record('handleAudioRequest: an old seq never replays', () => {
  // Settings already remember seq 3 (set in register()).
  const outcome = api.handleAudioRequest({ audio_request: { url: 'https://ice.example/a', seq: 3, at: Date.now() } })
  assert.equal(outcome, 'seen')
  assert.equal(api.handleAudioRequest({ audio_request: { url: 'https://ice.example/a', seq: 1, at: Date.now() } }), 'seen')
})

await record('handleAudioRequest: a new play reaches the page and is remembered', async () => {
  const outcome = api.handleAudioRequest({
    audio_request: { action: 'play', url: 'https://ice.example/live.mp3', label: 'Example Radio', seq: 4, at: Date.now() }
  })
  assert.equal(outcome, 'played')
  assert.equal(api.audioState().settings.audioRequestSeq, 4)
  // playAudioSource is async; let its promise land.
  await new Promise(resolve => setTimeout(resolve, 0))
  const play = sent.find(message => message.aura === 'audio' && message.cmd === 'play')
  assert.ok(play, 'no play command reached the audio channel')
  assert.equal(play.url, 'https://ice.example/live.mp3')
  assert.equal(play.label, 'Example Radio')
  assert.equal(api.audioState().settings.audioUrl, 'https://ice.example/live.mp3')
})

await record('handleAudioRequests: every unseen request is applied in order', async () => {
  const dispose = await remount({ audioRequestSeq: 200 })
  const outcomes = plugin.handleAudioRequests({
    audio_requests: [
      { action: 'play', url: 'https://ice.example/batch.mp3', label: 'Batch', seq: 201, at: Date.now() },
      { action: 'mute_video', seq: 202, at: Date.now() }
    ]
  })
  assert.deepEqual(outcomes, ['played', 'muted'])
  assert.equal(plugin.audioState().settings.audioRequestSeq, 202)
  assert.equal(plugin.audioState().settings.audioUrl, 'https://ice.example/batch.mp3')
  assert.equal(plugin.audioState().settings.videoMuted, true)
  assert.ok(sent.some(message => message.aura === 'audio' && message.cmd === 'play' && message.url === 'https://ice.example/batch.mp3'))
  assert.ok(sent.some(message => message.aura === 'transport' && message.cmd === 'mute'))
  dispose()
})

await record('audio-only still mounts the backdrop that hosts audio.js', async () => {
  const dispose = await remount({
    windowVisual: false,
    backdropMode: 'aura',
    audioUrl: 'https://ice.example/audio-only.mp3',
    audioLabel: 'Audio only'
  })
  const frame = framed().find(props => String(props.src || '').includes('overlay=1'))
  assert.ok(frame, `no page was framed for an audio-only session: ${JSON.stringify(framed().map(props => props.src))}`)
  dispose()
})

await record('a closed film does not tear down the audio-only backdrop', async () => {
  const dispose = await remount({
    windowVisual: false,
    backdropMode: 'video',
    videoClosed: true,
    videoUrl: '',
    audioUrl: 'https://ice.example/audio-only.mp3',
    audioLabel: 'Audio only'
  })
  const frame = framed().find(props => String(props.src || '').includes('token='))
  assert.ok(frame, `the closed-film branch removed the audio channel page: ${JSON.stringify(framed().map(props => props.src))}`)
  assert.ok(!String(frame.src).includes('/player.html'),
    'a closed film put a dead player page back on screen for the music to live in')
  dispose()
})

await record('music keeps its page when the film is closed in visualiser mode', async () => {
  // The same gate, asked the other way round: closing the film must not take the
  // music's page down with it, whatever mode the backdrop is in.
  const dispose = await remount({
    windowVisual: false,
    backdropMode: 'aura',
    videoClosed: true,
    audioUrl: 'https://ice.example/audio-only.mp3',
    audioLabel: 'Audio only'
  })
  const frame = framed().find(props => String(props.src || '').includes('overlay=1'))
  assert.ok(frame, `a closed film took the music page down with it: ${JSON.stringify(framed().map(props => props.src))}`)
  dispose()
})

await record('handleAudioRequest: a request older than 60 s is stale on first poll', async () => {
  const dispose = await remount({})  // seq 0: a fresh install
  const outcome = plugin.handleAudioRequest({
    audio_request: { action: 'play', url: 'https://ice.example/old.mp3', seq: 9, at: Date.now() - 120000 }
  })
  assert.equal(outcome, 'stale')
  assert.equal(plugin.audioState().settings.audioRequestSeq, 9, 'the stale seq must be consumed')
  // …and the same age is fine once the install has a history.
  const fresh = plugin.handleAudioRequest({
    audio_request: { action: 'stop', url: '', seq: 10, at: Date.now() - 120000 }
  })
  assert.equal(fresh, 'stopped')
  dispose()
})

// A later test disposed the instance above; every following check needs a live
// one (and its mounted backdrop).
await remount({ audioVolume: 0.4, videoMuted: false })

await record('volume, mute_video and unmute_video only touch their own setting', () => {
  const before = api.audioState().settings
  api.handleAudioRequest({ audio_request: { action: 'volume', value: 0.25, seq: 100, at: Date.now() } })
  assert.equal(api.audioState().settings.audioVolume, 0.25)
  assert.equal(api.audioState().settings.videoMuted, before.videoMuted)
  assert.equal(api.audioState().settings.audioUrl, before.audioUrl, 'a volume change must not stop the music')
  const volumeMessage = sent.find(message => message.aura === 'audio' && message.cmd === 'volume')
  assert.ok(volumeMessage)
  assert.equal(volumeMessage.value, 0.25)

  api.handleAudioRequest({ audio_request: { action: 'mute_video', seq: 101, at: Date.now() } })
  assert.equal(api.audioState().settings.videoMuted, true)
  assert.equal(api.audioState().settings.audioUrl, before.audioUrl, 'muting the film must not stop the music')
  assert.equal(api.audioState().settings.audioVolume, 0.25, 'muting the film must not change the music volume')
  assert.ok(sent.some(message => message.aura === 'transport' && message.cmd === 'mute'))

  api.handleAudioRequest({ audio_request: { action: 'unmute_video', seq: 102, at: Date.now() } })
  assert.equal(api.audioState().settings.videoMuted, false)
  assert.ok(sent.some(message => message.aura === 'transport' && message.cmd === 'unmute'))
})

await record('stop clears the channel source but keeps the volume', () => {
  const volume = api.audioState().settings.audioVolume
  api.handleAudioRequest({ audio_request: { action: 'stop', seq: 103, at: Date.now() } })
  const settings = api.audioState().settings
  assert.equal(settings.audioUrl, '')
  assert.equal(settings.audioLabel, '')
  assert.equal(settings.audioVolume, volume)
  assert.ok(sent.some(message => message.aura === 'audio' && message.cmd === 'stop'))
})

await record('playAudioSource refuses an empty URL and exposes state', async () => {
  assert.equal(await api.playAudioSource('', 'nothing'), false)
  assert.equal(await api.playAudioSource(null, null), false)
})

await record('REVAMP_PITCH names the pitch and revampCard wires both buttons', () => {
  assert.match(api.pitch, /Winamp-style player/)
  assert.match(api.pitch, /REVamp plays it/)
  assert.match(api.pitch, /Aura’s visuals react to it/)
  const card = api.revampCard()
  assert.ok(card, 'revampCard() returned nothing with a document present')
  const all = []
  const walk = node => {
    if (!node || typeof node !== 'object') return
    all.push(node)
    for (const child of node.children || []) walk(child)
  }
  walk(card)
  const text = all.map(node => node.textContent).filter(Boolean).join(' ')
  assert.match(text, /Winamp-style player/)
  const open = all.find(node => node.textContent === 'Open REVamp')
  const get = all.find(node => node.textContent === 'Get REVamp')
  assert.ok(open && get, 'revampCard() is missing a button')
  open.__handlers.click[0]()
  assert.deepEqual(sdkStub.calls.navigations.slice(-1), ['/revamp'])
  get.__handlers.click[0]()
  assert.deepEqual(sdkStub.calls.external.slice(-1), ['https://github.com/KeyArgo/hermes-revamp'])
})

await record('the video backdrop carries mute=1 when the film is muted', () => {
  // The player page reads ?mute=1; without it a muted film comes back loud.
  assert.match(source, /if \(settings\.videoMuted\) query\.append\('mute', '1'\)/)
})

// --------------------------------------------------------------------- report

for (const line of results) console.log(line)
const summary = `${failed === 0 ? 'PASS' : 'FAIL'} listen desktop: ${results.length - failed}/${results.length}`
console.log(summary)
process.exit(failed === 0 ? 0 : 1)
