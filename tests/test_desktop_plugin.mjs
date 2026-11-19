/**
 * Contract test for the Aura desktop half (desktop/plugin.js).
 *
 * This does NOT run the plugin inside Hermes. It proves the things a headless
 * Node process can prove, and nothing it cannot:
 *
 *   1. the file is plain ESM that Node can parse (JSX syntax would fail here),
 *   2. its default export is { id, name, register },
 *   3. register() contributes the expected areas and returns a disposer that
 *      removes every contribution, clears the timers and listeners, clears the
 *      accent override and restores the theme it replaced,
 *   4. the stage era is gone: no palette command — the Right panel, the Aura
 *      page, the watch window and Settings are the product, plus the
 *      deliberate status-bar quick menu (see 9), and (since the page work)
 *      one sidebar row that opens the full Aura page (see scenario P),
 *   5. the polling interval is never faster than 4 Hz,
 *   6. the static SDK rules hold: no eval / new Function / JSX / dynamic
 *      import, no imports outside the three allowed specifiers, no
 *      document.querySelector('[data-slot=...]'), no document.body observer,
 *      no console output,
 *   7. host safety: nothing Aura does is appended to the host body, and no
 *      #aura-glass style or data-aura-backdrop attribute is created. A saved
 *      windowVisual value is ignored. The full-window visual returns with the
 *      SDK backdrop area (#155903),
 *   8. there is no "Visual behind the app" switch,
 *   9. the status-bar quick menu registers on STATUSBAR_AREAS.right, renders
 *      the owner's controls (on/off, "Reacts to", intensity, transparency,
 *      style, gentle motion, All Aura settings), drives them through the
 *      same /control pushes and storage writes as the settings page, keeps
 *      the pulse dot still under reduced motion, adds the web half's
 *      reduced-motion=1 force-switch to the visualiser URL, and leaves no
 *      listener behind on dispose.
 *
 * To import the plugin without Hermes, a temp copy has its three import
 * specifiers rewritten to local stub modules; the stubs record the calls the
 * plugin makes (accent overrides, theme requests, navigation) so the test can
 * assert on them.
 *
 * Run: node tests/test_desktop_plugin.mjs
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

/** Remove strings, template literals, regex bodies and comments so the static
 *  checks see code only (a `//` inside /^https?:\/\// must not eat the line). */
function stripNonCode(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const d = text[i + 1]
    if (c === '/' && d === '/' && text[i - 1] !== '\\') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && d === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      i += 1
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      out += ' '
      continue
    }
    out += c
    i += 1
  }
  return out
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Fire one polling tick the way the host does: pollDue() is elapsed-time
 *  based, so wait out whatever is left of the 250 ms busy cadence since the
 *  last poll before firing. Tests that mean to tick INSIDE the cadence (the
 *  overlap guard) keep firing raw ticks. */
async function dueTick(bucket) {
  const since = Date.now() - pluginModule.wiringTest.lastPollAt()
  if (since < 250) await sleep(250 - since)
  bucket.timers.find(t => t.ms === 250).fn()
}

/** dueTick, but it guarantees the tick really polled. An idle Aura only asks
 *  /status every 2-3 s (see pollDueMs), so one 250 ms tick can leave the
 *  previous answer — and the error it carried — in place. Tests that read what
 *  a poll learned wait for lastPollAt to move instead of assuming one tick was
 *  enough; without this the check failed whenever the suite ran slowly enough
 *  for the busy hold to expire. */
async function pollTick(bucket) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const before = pluginModule.wiringTest.lastPollAt()
    await dueTick(bucket)
    await sleep(30)
    if (pluginModule.wiringTest.lastPollAt() !== before) return
  }
  throw new Error('the plugin never polled: the 250 ms tick stopped asking')
}

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
    const props = element.props || {}
    if (typeof props.ref === 'function' && typeof element.type === 'string') {
      const existing = refs[slot]
      slot += 1
      if (existing) { existing.ref = props.ref; props.ref(existing.host); walk(props.children); return }
      const host = globalThis.document.createElement(element.type)
      host.floatingPane = record.id
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

function makeCtx(settings) {
  const contributions = []
  const timers = []
  const controls = []
  const requests = []
  const disposers = []
  const listeners = []
  const storage = new Map()
  if (settings) storage.set('settings', settings)
  // Mirrors the real server: /status reports the enabled flag the last
  // /control {enabled} actually applied, so off really stays off. The display
  // controls are mirrored too, so /state is a truthful server source.
  let serverEnabled = settings && typeof settings.enabled === 'boolean' ? settings.enabled : true
  // The OS film window: available means the host can give us a real window.
  let windowAvailable = true
  let windowOpen = false
  const serverSettings = {
    motion: settings && typeof settings.motion === 'string' ? settings.motion : 'agent_music',
    behavior: settings && typeof settings.behavior === 'string' ? settings.behavior : 'calm',
    intensity: settings && Number.isFinite(settings.intensity) ? settings.intensity : 0,
    opacity: settings && Number.isFinite(settings.opacity) ? settings.opacity : 0.25,
    reduced_motion: settings && typeof settings.reducedMotion === 'boolean' ? settings.reducedMotion : false
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
      const record = { ...contribution, removed: false }
      contributions.push(record)
      // The host draws placement:'floating' panes as cards; mirror that so the
      // strip/watch window inside Aura's floating pane is reachable in tests.
      const unmount = mountFloatingPane(record)
      return () => {
        if (record.removed) return
        record.removed = true
        if (unmount) unmount()
        const index = contributions.indexOf(record)
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
      const record = { fn, ms, kind: 'interval', cleared: false }
      timers.push(record)
      return () => {
        record.cleared = true
      }
    },
    setTimeout(fn, ms) {
      const record = { fn, ms, kind: 'timeout', cleared: false }
      timers.push(record)
      return () => {
        record.cleared = true
      }
    },
    addEventListener(target, type, fn) {
      const record = { target, type, fn, removed: false }
      listeners.push(record)
      return () => {
        record.removed = true
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
          capture: settings && typeof settings.capture === 'string' ? settings.capture : 'pipewire',
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
          if (route === '/window') {
        return { ok: true, available: windowAvailable, open: windowOpen }
      }
      if (route === '/window/open') {
        if (!windowAvailable) return { ok: false, error: 'window unavailable' }
        windowOpen = true
        return { ok: true, open: true, url: options.body ? options.body.url : '' }
      }
      if (route === '/window/close') {
        windowOpen = false
        return { ok: true, window: { open: false }, closed: true }
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

  return {
    ctx, contributions, timers, controls, disposers, listeners, requests, storage, serverSettings, serverFrame,
    windowState: () => ({ available: windowAvailable, open: windowOpen }),
    setWindowAvailable: value => { windowAvailable = value }
  }
}

// -------------------------------------------------------------- static checks

const source = fs.readFileSync(PLUGIN, 'utf8')
const code = stripNonCode(source)

record('plugin.js parses as plain ESM (imported below)', () => assert.ok(source.length > 0))
record('no eval()', () => assert.doesNotMatch(code, /\beval\s*\(/))
record('no new Function', () => assert.doesNotMatch(code, /new\s+Function\b/))
record('no dynamic import()', () => assert.doesNotMatch(code, /\bimport\s*\(/))
record('no JSX syntax', () => assert.doesNotMatch(code, /<[A-Za-z/]/))
record('no document.querySelector on app markup', () => assert.doesNotMatch(source, /document\s*\.\s*querySelector/))
record('the strip never scans the chat composer DOM', () => {
  // Review ask: position the strip from the window/saved position, never by
  // finding and measuring the host's text fields.
  assert.doesNotMatch(source, /composerRect/)
  assert.doesNotMatch(source, /querySelector(?:All)?\s*\(\s*['"][^'"]*(?:textarea|contenteditable|composer)/i)
})
record('no data-slot selector anywhere', () => assert.doesNotMatch(source, /data-slot/))
record('no MutationObserver / document.body observer', () => assert.doesNotMatch(source, /MutationObserver/))
record('no console output', () => assert.doesNotMatch(source, /console\s*\./))
record('only the three allowed import specifiers', () => {
  const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1])
  assert.ok(specifiers.length >= 2, 'expected static imports')
  for (const specifier of specifiers) {
    assert.ok(
      ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'].includes(specifier),
      `unexpected import specifier: ${specifier}`
    )
  }
})
record('clears the accent override with setAccentOverride(null)', () =>
  assert.match(source, /setAccentOverride\(null\)/)
)
record('polls at most 4 Hz (250 ms)', () => assert.match(source, /POLL_MS\s*=\s*250/))
record('no user-facing "Left panel" remains', () => assert.doesNotMatch(source, /Left panel/))

// ------------------------------------------------------- page: idle motion
// web/aura.js is a browser IIFE. This pulls the shipped idleGate() out of the
// file and runs it, so the precedence rules are exercised as written rather
// than restated here.
const AURA = path.join(ROOT, 'web', 'aura.js')
const auraSource = fs.readFileSync(AURA, 'utf8')
const gateMatch = /function idleGate\(\) \{[\s\S]*?\n  \}/.exec(auraSource)

record('page ships an idleGate() for motion-follows-the-agent', () => {
  assert.ok(gateMatch, 'no idleGate() in web/aura.js')
  assert.match(auraSource, /const IDLE_MOTIONS = \['stop', 'ember', 'always'\]/)
  assert.match(auraSource, /IDLE_EMBER_GAIN = 0\.06/)
})

record('page idle gate: attention beats the gate, working moods restore, idle/done follow the setting', () => {
  assert.ok(gateMatch, 'no idleGate() in web/aura.js')
  const makeGate = new Function('ATTENTION', 'mood', 'state', 'IDLE_EMBER_GAIN',
    `${gateMatch[0]}\nreturn idleGate;`)
  const gateFor = (idleMotion, moodName) =>
    makeGate(['approval', 'error'], { current: moodName }, { idleMotion }, 0.06)()

  // An attention mood beats the idle gate, whatever the setting says.
  assert.equal(gateFor('stop', 'approval'), 1)
  assert.equal(gateFor('stop', 'error'), 1)
  assert.equal(gateFor('ember', 'approval'), 1)

  // Idle and done follow the setting: dark for stop, a low ember for ember.
  assert.equal(gateFor('stop', 'idle'), 0)
  assert.equal(gateFor('stop', 'done'), 0)
  assert.equal(gateFor('ember', 'idle'), 0.06)
  assert.equal(gateFor('ember', 'done'), 0.06)

  // Any working mood restores the render gain.
  for (const working of ['thinking', 'tool', 'streaming']) {
    assert.equal(gateFor('stop', working), 1, `${working} did not restore the gain`)
    assert.equal(gateFor('ember', working), 1, `${working} did not restore the gain`)
  }

  // always never gates.
  for (const moodName of ['idle', 'done', 'thinking', 'approval', 'error']) {
    assert.equal(gateFor('always', moodName), 1)
  }
})

record('page eases the gate through the existing gain ramp, not a new render path', () => {
  assert.match(auraSource, /rampGain\(audio\.realGain\.gain, \(target === 'real' \? 1 : 0\) \* gate, fade\)/)
  assert.match(auraSource, /rampGain\(audio\.ambientGain\.gain, \(target === 'ambient' \? 1 : 0\) \* gate, fade\)/)
  assert.match(auraSource, /if \(typeof cfg\.idle_motion === 'string'\) \{\s*setIdleMotionUI\(cfg\.idle_motion\)/)
})

// --------------------------------------------------------------- temp module

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aura-plugin-test-'))
const pluginCopy = path.join(tmp, 'plugin.mjs')
const sdkStub = path.join(tmp, 'sdk-stub.mjs')
const reactStub = path.join(tmp, 'react-stub.mjs')
const jsxStub = path.join(tmp, 'jsx-runtime-stub.mjs')

const rewritten = source
  .replace(/from\s+'@hermes\/plugin-sdk'/g, "from './sdk-stub.mjs'")
  .replace(/from\s+'react'/g, "from './react-stub.mjs'")
  .replace(/from\s+'react\/jsx-runtime'/g, "from './jsx-runtime-stub.mjs'")

fs.writeFileSync(pluginCopy, rewritten + '\nexport const wiringTest = { sync: typeof syncPlayerOwnership === "function" ? syncPlayerOwnership : null, urlBinding: typeof pageUrlInputBinding === "function" ? pageUrlInputBinding : null, setWindow: typeof setDesktopWindow === "function" ? setDesktopWindow : null, positionVideoBar: typeof positionVideoBar === "function" ? positionVideoBar : null, beginStripDrag: typeof beginStripDrag === "function" ? beginStripDrag : null, onStripDragMove: typeof onStripDragMove === "function" ? onStripDragMove : null, endStripDrag: typeof endStripDrag === "function" ? endStripDrag : null, post: typeof postToBackdrop === "function" ? postToBackdrop : null, audio: typeof audioCommand === "function" ? audioCommand : null, devStatsKey: typeof onDevStatsKeydown === "function" ? onDevStatsKeydown : null, panelHost: typeof panelHostRef === "function" ? panelHostRef : null, video: $video, settings: $settings, remember: typeof rememberPosition === "function" ? rememberPosition : null, refreshFilm: typeof refreshFilmSurface === "function" ? refreshFilmSurface : null, filmSurface: typeof $filmSurface === "object" ? $filmSurface : null, owned: () => desktopOwned, command: (cmd, value) => videoCommand(cmd, value), lastPollAt: () => (typeof lastPollAt === "number" ? lastPollAt : 0) };\n')

fs.writeFileSync(
  sdkStub,
  `// Stub of @hermes/plugin-sdk: records the calls the plugin makes.
export const calls = { accent: [], themes: [], navigations: [], notifications: [], undismissed: [], revealed: [], composer: [] }

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
// Injected host failures (a real host call can throw during teardown).
export const failures = { accent: 0 }

export const setAccentOverride = color => {
  if (failures.accent > 0) {
    failures.accent -= 1
    throw new Error('accent host failure')
  }
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
  revealPane: paneId => { calls.revealed.push(paneId) },
  composer: { focus: sessionId => { calls.composer.push(sessionId) } }
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

// SandboxedFrame stand-in: records its props and hands the test a frame element
// with a contentWindow, so the plugin's postMessage transport can be exercised
// without a renderer.
export const frames = []
export const SandboxedFrame = props => {
  const posted = []
  const node = {
    tagName: 'IFRAME',
    src: props.src,
    style: { ...(props.style || {}) },
    dataset: {},
    attributes: {},
    contentWindow: {
      posted,
      postMessage: (message, origin) => posted.push({ message, origin })
    },
    getBoundingClientRect: () => ({ width: 320, height: 180, left: 10, top: 20, right: 330, bottom: 200 })
  }
  frames.push({ props, node })
  if (typeof props.ref === 'function') props.ref(node)
  else if (props.ref && typeof props.ref === 'object') props.ref.current = node
  return node
}
// Host popover used by the status-bar quick menu; the real one owns
// Escape/outside-click/focus, the stub just has to exist so the plugin's
// import resolves and the descriptor tree can be walked.
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
// outside a renderer; the test invokes the theme probe and the settings page.
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

// The plugin reads document/getComputedStyle for the theme accent and the
// background-window check; a minimal stand-in keeps the import headless while
// still proving the plugin never appends anything to the host document.
const bodyChildren = []
const headChildren = []
const createdElements = []
// Document-level listeners are recorded so a test can prove Aura never grabs
// keys or focus on the host document (Teknium review ask 2).
const documentListeners = []
const isCapture = options => options === true || (options && options.capture === true)
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
    createdElements.push(node)
    return node
  },
  __handlers: {},
  addEventListener(type, fn, options) {
    documentListeners.push({ type, fn, options, removed: false })
    const list = this.__handlers[type] || (this.__handlers[type] = [])
    list.push(fn)
  },
  removeEventListener(type, fn, options) {
    const record = documentListeners.find(entry =>
      !entry.removed && entry.type === type && entry.fn === fn && isCapture(entry.options) === isCapture(options))
    if (record) record.removed = true
    const list = this.__handlers[type]
    if (list) this.__handlers[type] = list.filter(entry => entry !== fn)
  }
}
const FAKE_VARS = {
  '--ui-accent': '#8b7cff',
  '--ui-base': '#0b0a14',
  '--background': '#0b0a14',
  '--card': '#221d3d',
  '--ui-bg-chrome': '#12101f',
  '--ui-bg-sidebar': '#1a1730',
  '--ui-chat-surface-background': '#12101f'
}
const hexToRgb = hex => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`
globalThis.getComputedStyle = el => ({
  // A probe element styled `background-color: var(--x)` resolves like a browser would.
  backgroundColor: (() => {
    const m = el && el.style && /^var\((--[a-z0-9-]+)\)$/.exec(el.style.backgroundColor || '')
    return m && FAKE_VARS[m[1]] ? hexToRgb(FAKE_VARS[m[1]]) : 'rgba(0, 0, 0, 0)'
  })(),
  getPropertyValue: name => {
    const vars = {
      '--ui-accent': '#8b7cff',
      '--ui-base': '#0b0a14',
      '--ui-bg-chrome': '#12101f',
      '--ui-bg-sidebar': '#1a1730',
      '--ui-bg-editor': '#0b0a14',
      '--ui-chat-surface-background': '#12101f',
      '--ui-sidebar-surface-background': '#1a1730',
      '--ui-editor-surface-background': '#0b0a14',
      '--ui-widget-surface-background': '#221d3d'
    }
    return vars[name] || ''
  }
})

const hostIframes = () => bodyChildren.filter(node => node.tagName === 'IFRAME')
// The docked panel's own stylesheet is a product surface, on by default; the
// "effect" styles this contract guards are the glass and theme injections.
const panelStyles = () => headChildren.filter(node => node.attributes && node.attributes.id === 'aura-panel-style')
const UI_STYLE_IDS = new Set(['aura-panel-style', 'aura-ui-style'])
const hostStyles = () => headChildren.filter(node => node.tagName === 'STYLE' && !UI_STYLE_IDS.has(node.attributes.id))
const glassStyles = () => hostStyles().filter(node => node.attributes.id === 'aura-glass')
const hostHasNegativeZ = () =>
  [...bodyChildren, ...headChildren].some(node => node.style && node.style.zIndex === '-1')

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
// AuraFilm descriptors carry the surface they belong to. Finding one proves the
// pane/page/watch-window film is an SDK SandboxedFrame, not a body iframe.
const filmNodes = tree => {
  const found = []
  walk(tree, node => {
    if (node.props && ['panel', 'page', 'window'].includes(node.props.placement) &&
        typeof node.type === 'function') {
      found.push(node)
    }
  })
  return found
}
// Render just the AuraFilm component and its SandboxedFrame, so the stub hands
// back the frame element and its contentWindow.
const mountFilm = node => {
  const film = renderContribution({ render: () => node })
  const frame = film && film.type === 'iframe' && film.props.title === 'Aura film' ? sdk.SandboxedFrame(film.props) : null
  return { film, frame }
}
const findSwitch = (tree, label) => {
  let found = null
  walk(tree, node => {
    if (!found && node.props && node.props['aria-label'] === label) found = node
  })
  return found
}

const pluginModule = await import(pathToFileURL(pluginCopy).href)
const sdk = await import(pathToFileURL(sdkStub).href)

// ---------------------------------------------------------------- export shape

record('default export is { id: "aura", name: "Aura", register }', () => {
  const exported = pluginModule.default
  assert.ok(exported && typeof exported === 'object', 'no default export object')
  assert.equal(exported.id, 'aura')
  assert.equal(exported.name, 'Aura')
  assert.equal(typeof exported.register, 'function')
})

// ------------------------------------------------------------- scenario A

const a = makeCtx({ enabled: true, intensity: 0.5, followAudio: true })
let disposeA = null

record('register() returns a disposer function', () => {
  disposeA = pluginModule.default.register(a.ctx)
  assert.equal(typeof disposeA, 'function')
})

record('contributes the Aura page route and its sidebar row', () => {
  const route = a.contributions.find(c => c.area === 'routes')
  assert.ok(route, 'no routes contribution: the Aura page has no route')
  assert.equal(route.data.path, '/aura', 'the page must live at /aura')
  assert.equal(typeof route.render, 'function', 'the route needs a render function')
  const nav = a.contributions.find(c => c.area === 'sidebar.nav')
  assert.ok(nav, 'no sidebar.nav contribution: the page has no sidebar row')
  assert.equal(nav.data.path, '/aura', 'the row must open the page')
  assert.equal(nav.data.label, 'Aura', 'the row must read "Aura"')
  assert.equal(typeof nav.data.codicon, 'string')
  assert.ok(nav.data.codicon.length > 0, 'the row needs a codicon')
  assert.equal(a.contributions.some(c => c.area === 'palette'), false, 'no palette command is wanted')
})

record('docks the theatre as an enforced right-hand pane the host lays out', () => {
  const pane = a.contributions.find(c => c.area === 'panes')
  assert.ok(pane, 'no panes contribution: the panel has no home')
  assert.equal(pane.id, 'panel')
  assert.equal(typeof pane.render, 'function', 'the pane needs a render function')
  assert.equal(pane.data.placement, 'right', 'owner prefers right-hand panels')
  assert.deepEqual(
    pane.data.dock,
    { pane: 'workspace', pos: 'right', enforce: true },
    'existing layouts must be moved to the right on boot'
  )
  assert.match(String(pane.data.width), /^\d+px$/, 'the host needs a width')
  // The host remembers a dragged width per machine; without a floor a stale
  // 135px pane clipped the controls and shelf (Linux report, 11-13).
  assert.match(String(pane.data.minWidth), /^\d+px$/, 'the host needs a minimum width')
  assert.ok(parseInt(pane.data.minWidth, 10) >= 240, 'the controls need at least ~240px')
  assert.ok(parseInt(pane.data.minWidth, 10) <= parseInt(pane.data.width, 10), 'the floor cannot exceed the default width')
  // A pane is laid out by the app; anything we would have to pin ourselves is
  // exactly what broke the layout before.
  assert.ok(!('position' in pane.data), 'pane must not set its own position')
})

// Owner (11-15): new installs start at a fixed 25% video strength and 25%
// visual opacity; a level the user already chose (Auto included) is kept.
record('new installs start at a fixed 25% video strength and 25% visual opacity', () => {
  const defaults = source.slice(source.indexOf('const DEFAULT_SETTINGS'), source.indexOf('})', source.indexOf('const DEFAULT_SETTINGS')))
  assert.match(defaults, /\n  opacity: 0\.25,/, 'the visual opacity default is not 25%')
  assert.match(defaults, /videoOpacity: 0\.25,/, 'the video strength default is not 25%')
  assert.match(defaults, /videoOpacityAuto: false,/, 'new installs still start on Auto video strength')
  // A saved choice (Auto included) is read back as-is, never reset to the new default.
  assert.match(source, /if \(typeof raw\.videoOpacityAuto === 'boolean'\) out\.videoOpacityAuto = raw\.videoOpacityAuto/)
})

// Frosted glass and Video strength only washed the host page. They leave with
// the body backdrop and come back on the SDK backdrop area (#155903).
record('Frosted glass and Video strength are not in this build', () => {
  const start = source.indexOf('function AuraSettings(')
  const body = source.slice(start, source.indexOf('\nfunction ', start + 20))
  assert.equal(body.includes('Frosted glass'), false, 'Frosted glass is still in settings')
  assert.equal(body.includes('Video strength'), false, 'Video strength is still in settings')
  assert.equal(body.includes('frostRow'), false, 'the frost row builder is still in settings')
  assert.equal(body.includes('Visual behind the app'), false, 'Visual behind the app is still in settings')
})

record('the visualizer card does not offer a host-page visual', () => {
  const start = source.indexOf('function AuraPaneVisualControls(')
  const body = source.slice(start, source.indexOf('\nfunction ', start + 20))
  assert.equal(body.includes('Show the visual behind the app'), false, 'the pane still offers the host-page visual')
  assert.equal(body.includes('setWindowVisual'), false, 'the pane still turns the host-page visual on')
})

// Owner (11-15): the pane embedded the whole Settings page under its own quick
// controls - duplicate rows, a version line and an ad in a narrow column. The
// pane now links to the full settings instead.
record('the Right panel links to all settings instead of embedding a second copy', () => {
  const pane = a.contributions.find(c => c.area === 'panes')
  const tree = renderContribution(pane)
  assert.equal(tree.props.style.overflowY, 'auto', 'the pane must scroll when content is taller than the window')
  assert.equal(texts(tree).includes('Aura enabled'), false, 'the pane embeds the full settings list again')
  let button = null
  walk(tree, node => {
    if (!button && node.props && node.props['aria-label'] === 'All Aura settings') button = node
  })
  assert.ok(button, 'the pane has no All settings button')
  const before = sdk.calls.navigations.length
  button.props.onClick()
  assert.equal(sdk.calls.navigations[before], '/settings?tab=plugins&agent=aura', 'All settings does not open Aura\'s settings page')
})

record('occupies the status bar with exactly one quick-menu contribution', () => {
  const statusBar = a.contributions.filter(c => c.area.startsWith('statusBar.'))
  assert.equal(statusBar.length, 1, 'expected exactly one status-bar contribution')
  const menu = statusBar[0]
  assert.equal(menu.area, sdk.STATUSBAR_AREAS.right, 'quick menu must sit on the right')
  assert.equal(menu.id, 'quick-menu')
  assert.equal(typeof menu.render, 'function')
  assert.ok(Number.isFinite(menu.order), 'quick menu needs a stable order')
})

record('contributes no theme', () => {
  const theme = a.contributions.find(c => c.area === 'themes')
  assert.equal(theme, undefined, 'a themes contribution was registered')
})

record('contributes the settings page under settings.plugins', () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  assert.ok(settings, 'no settings.plugins contribution')
  assert.equal(typeof settings.render, 'function')
})

record('the settings page calls the pane the Right panel', () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  assert.ok(findSwitch(renderContribution(settings), 'Right panel'), 'the settings page has no Right panel switch')
  assert.equal(findSwitch(renderContribution(settings), 'Left panel'), null, 'the settings page still says "Left panel"')
})

record('contributes a permanently mounted theme probe', () => {
  const probe = a.contributions.find(c => c.area === 'titleBar.center')
  assert.ok(probe, 'no titleBar.center contribution')
  assert.equal(typeof probe.render, 'function')
})

record('polls at 250 ms or slower (never faster than 4 Hz)', () => {
  const intervals = a.timers.filter(t => t.kind === 'interval')
  const interval = intervals.find(t => t.ms && t.ms >= 250)
  assert.ok(interval, 'no polling interval >= 250 ms')
  assert.ok(intervals.every(t => t.ms >= 250), 'a poll interval is faster than 250 ms')
})

await recordAsync('status request leaves time for a cold gateway', async () => {
  await sleep(30)
  const status = a.requests.find(call => call.route === '/status')
  assert.ok(status && status.options.timeoutMs >= 10000, 'status timeout is too short for cold startup')
})

record('settings have no Aura theme rows', () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  const body = texts(tree)
  assert.equal(body.includes('Use Aura theme'), false, 'the Use Aura theme row is still rendered')
  assert.equal(body.includes('Keep my theme when idle'), false, 'the Keep my theme when idle row is still rendered')
  assert.equal(findSwitch(tree, 'Use Aura theme'), null, 'the Use Aura theme switch is still rendered')
})

await recordAsync('nothing is injected with no opt-in', async () => {
  await sleep(30)
  assert.equal(hostStyles().length, 0, 'injected a stylesheet into the host head')
  assert.equal(hostIframes().length, 0, 'mounted a backdrop iframe on the host body')
  assert.equal(hostHasNegativeZ(), false, 'a host node uses a negative z-index')
  assert.deepEqual(Object.keys(documentElement.style), [], 'host html/root style was mutated')
  assert.deepEqual(Object.keys(document.body.style), [], 'host body style was mutated')
})

await recordAsync('the whole-window visual is not in this build', async () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  assert.equal(findSwitch(tree, 'Visual behind the app'), null, 'the host-page visual switch is still rendered')
  assert.equal(hostIframes().length, 0, 'a body iframe was mounted')
  assert.equal(glassStyles().length, 0, 'a #aura-glass style was mounted')
  assert.equal(hostHasNegativeZ(), false, 'a host node uses a negative z-index')
})

const findSettingsSwitches = tree => {
  const found = {}
  walk(tree, node => {
    if (!node.props) return
    if (node.props['aria-label'] === 'Aura enabled') found.enabled = node
    if (node.props['aria-label'] === 'Visual behind the app') found.visual = node
  })
  return found
}

await recordAsync('Aura enabled is the only on switch, and it does not paint the host page', async () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const switches = findSettingsSwitches(renderContribution(settings))
  assert.ok(switches.enabled, 'Aura enabled switch missing')
  assert.equal(switches.visual, undefined, 'Visual behind the app is still a switch')
  switches.enabled.props.onCheckedChange(false)
  await sleep(30)
  switches.enabled.props.onCheckedChange(true)
  await sleep(30)
  assert.equal(hostIframes().length, 0, 'enabling Aura mounted a body iframe')
  assert.equal(glassStyles().length, 0, 'enabling Aura mounted #aura-glass')
  assert.doesNotMatch(texts(renderContribution(settings)), /turn it on to see the visual/)
})

record('no Background visibility control remains', () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let visibility = null
  walk(tree, node => {
    if (!visibility && node.type === 'input' && node.props && node.props['aria-label'] === 'Background visibility') visibility = node
  })
  assert.equal(visibility, null, 'the dropped host-glass control is still rendered')
})

await recordAsync('motion select offers the agent modes and hides legacy designs', async () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  const select = findSwitch(tree, 'Motion source')
  assert.ok(select, 'Motion source select missing')
  const options = select.props.children.map(option => option.props.value)
  assert.deepEqual(options, ['both', 'music', 'agent', 'agent_music'], 'unexpected motion options')
  assert.equal(options.includes('designs'), false, 'legacy designs is still offered')
  const labels = select.props.children.map(option => option.props.children)
  assert.deepEqual(labels, [
    'Music, or gentle designs',
    'Music only',
    'Agent activity',
    'Agent + music (default)'
  ])
})

await recordAsync('agent_music saves and reaches /control', async () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const select = findSwitch(renderContribution(settings), 'Motion source')
  assert.ok(select, 'Motion source select missing')
  select.props.onChange({ target: { value: 'agent_music' } })
  await sleep(30)
  assert.equal(a.storage.get('settings').motion, 'agent_music', 'agent_music was not persisted')
  assert.deepEqual(a.controls.at(-1), { motion: 'agent_music' }, 'agent_music did not reach /control')
  const rerendered = findSwitch(renderContribution(settings), 'Motion source')
  assert.equal(rerendered.props.value, 'agent_music', 'saved motion did not round-trip into the select')
  // Put the shared scenario back on its default for the remaining checks.
  select.props.onChange({ target: { value: 'both' } })
  await sleep(30)
})

await recordAsync('disabling Aura clears the accent and leaves the host untouched', async () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let enabledSwitch = null
  walk(tree, node => {
    if (!enabledSwitch && node.props && node.props['aria-label'] === 'Aura enabled') enabledSwitch = node
  })
  assert.ok(enabledSwitch, 'no Aura enabled switch rendered')
  enabledSwitch.props.onCheckedChange(false)
  await sleep(20)
  assert.equal(sdk.calls.accent.at(-1), null, 'accent override survived disabling Aura')
  assert.equal(hostStyles().length, 0)
  assert.equal(hostIframes().length, 0)
  enabledSwitch.props.onCheckedChange(true)
  await sleep(40)
  assert.equal(hostStyles().length, 0)
  assert.equal(hostIframes().length, 0)
})

record('no app-overlay on/off setting remains', () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let oldSwitch = null
  walk(tree, node => {
    if (!oldSwitch && node.props && node.props['aria-label'] === 'App overlay') oldSwitch = node
  })
  assert.equal(oldSwitch, null, 'the old App overlay switch is still rendered')
})

await recordAsync('a slow status response does not trigger overlapping requests', async () => {
  const oldRest = a.ctx.rest
  let count = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  a.ctx.rest = async (route, options) => {
    if (route === '/status') {
      count += 1
      await gate
    }
    return oldRest(route, options)
  }
  try {
    const tick = a.timers.find(t => t.ms === 250)
    await dueTick(a)
    await sleep(10)
    tick.fn()
    tick.fn()
    await sleep(10)
    assert.equal(count, 1)
  } finally {
    release()
    await sleep(30)
    a.ctx.rest = oldRest
  }
})

await recordAsync('accent pulse applies a hex derived from the theme accent', async () => {
  const probe = a.contributions.find(c => c.area === 'titleBar.center')
  renderContribution(probe)
  await sleep(30)
  const tick = a.timers.find(t => t.ms === 250)
  tick.fn()
  await sleep(30)
  const applied = sdk.calls.accent.filter(value => typeof value === 'string')
  assert.ok(applied.length >= 1, 'no accent override was applied')
  for (const value of applied) assert.match(value, /^#[0-9a-f]{6}$/i)
})

await recordAsync('one tick never applies more than one accent colour', async () => {
  const before = sdk.calls.accent.length
  const tick = a.timers.find(t => t.ms === 250)
  tick.fn()
  await sleep(30)
  assert.ok(sdk.calls.accent.length - before <= 1, 'accent applied more than once per tick')
})

await recordAsync('status timeout is reported without leaking error details', async () => {
  const oldRest = a.ctx.rest
  a.ctx.rest = async () => { throw new Error('Timed out connecting to Hermes backend after 3000ms token=secret') }
  try {
    await pollTick(a)
    const text = texts(renderContribution(a.contributions.find(c => c.area === 'settings.plugins')))
    assert.match(text, /timed out/i)
    assert.doesNotMatch(text, /secret|token/)
  } finally {
    a.ctx.rest = oldRest
    await pollTick(a)
  }
})

await recordAsync('status failures are classified safely', async () => {
  const oldRest = a.ctx.rest
  try {
    for (const [detail, expected] of [
      ['403: profile_scope_mismatch token=secret', /selected profile/i],
      ['Gateway ticket bootstrap failed token=secret', /gateway connection/i],
      ['401 token=secret', /authorize/i],
      ['unexpected token=secret', /could not complete/i]
    ]) {
      a.ctx.rest = async () => { throw new Error(detail) }
      await pollTick(a)
      const text = texts(renderContribution(a.contributions.find(c => c.area === 'settings.plugins')))
      assert.match(text, expected)
      assert.doesNotMatch(text, /secret|token/)
    }
  } finally {
    a.ctx.rest = oldRest
    await pollTick(a)
  }
})

await recordAsync('intensity 0 clears the accent override and pushes the change', async () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let slider = null
  walk(tree, node => {
    if (!slider && node.type === 'input' && node.props && node.props.type === 'range') slider = node
  })
  assert.ok(slider, 'no intensity slider rendered')
  slider.props.onChange({ target: { value: '0' } })
  await sleep(30)
  assert.equal(sdk.calls.accent.at(-1), null, 'accent override was not cleared')
  assert.deepEqual(a.controls.at(-1), { intensity: 0 })
})

await recordAsync('opacity slider persists and pushes the display control', async () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let slider = null
  walk(tree, node => {
    if (!slider && node.type === 'input' && node.props && node.props['aria-label'] === 'Visual opacity') slider = node
  })
  assert.ok(slider, 'no opacity slider rendered')
  assert.equal(slider.props.min, 0)
  assert.equal(slider.props.max, 100)
  slider.props.onChange({ target: { value: '40' } })
  await sleep(30)
  assert.deepEqual(a.controls.at(-1), { opacity: 0.4 })
})

await recordAsync('behaviour select offers calm/balanced/intense and pushes the choice', async () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let select = null
  walk(tree, node => {
    if (!select && node.type === 'select' && node.props && node.props['aria-label'] === 'Behaviour profile') select = node
  })
  assert.ok(select, 'no behaviour select rendered')
  const values = (select.props.children || []).map(option => option.props.value)
  assert.deepEqual(values, ['calm', 'balanced', 'intense'])
  select.props.onChange({ target: { value: 'calm' } })
  await sleep(30)
  assert.deepEqual(a.controls.at(-1), { behavior: 'calm' })
})

await recordAsync('accent pulse switch off clears the override and pushes accent_pulse=false', async () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let accentSwitch = null
  walk(tree, node => {
    if (!accentSwitch && node.props && node.props['aria-label'] === 'Accent pulse') accentSwitch = node
  })
  assert.ok(accentSwitch, 'no accent pulse switch rendered')
  accentSwitch.props.onCheckedChange(false)
  await sleep(30)
  assert.equal(sdk.calls.accent.at(-1), null, 'accent override was not cleared')
  assert.deepEqual(a.controls.at(-1), { accent_pulse: false })
})

await recordAsync('mood-reactive switch off leaves no stale accent and pushes mood_reactive=false', async () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let moodSwitch = null
  walk(tree, node => {
    if (!moodSwitch && node.props && node.props['aria-label'] === 'React to agent mood') moodSwitch = node
  })
  assert.ok(moodSwitch, 'no mood-reactive switch rendered')
  moodSwitch.props.onCheckedChange(false)
  await sleep(30)
  assert.equal(sdk.calls.accent.at(-1), null, 'mood switch left a stale accent')
  assert.deepEqual(a.controls.at(-1), { mood_reactive: false })
})

await recordAsync('automatic-presets switch pushes auto_preset=false', async () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let autoSwitch = null
  walk(tree, node => {
    if (!autoSwitch && node.props && node.props['aria-label'] === 'Automatic presets') autoSwitch = node
  })
  assert.ok(autoSwitch, 'no auto-preset switch rendered')
  autoSwitch.props.onCheckedChange(false)
  await sleep(30)
  assert.deepEqual(a.controls.at(-1), { auto_preset: false })
})

await recordAsync('disposer removes every contribution, clears timers/listeners, accent, glass and theme', async () => {
  assert.equal(glassStyles().length, 0, 'a #aura-glass style was mounted')
  assert.equal(hostIframes().length, 0, 'a body iframe was mounted')
  const themeCallsBefore = sdk.calls.themes.length
  disposeA()
  assert.equal(a.contributions.length, 0, 'contributions survived dispose')
  assert.ok(a.timers.every(t => t.cleared), 'a timer survived dispose')
  assert.ok(a.listeners.length > 0, 'no listener was registered')
  assert.ok(a.listeners.every(t => t.removed), 'a listener survived dispose')
  assert.equal(sdk.calls.accent.at(-1), null, 'accent override survived dispose')
  assert.equal(sdk.calls.themes.length, themeCallsBefore, 'theme switched on a plugin that never opted in')
  assert.equal(glassStyles().length, 0, 'the #aura-glass style survived dispose')
  assert.equal(hostStyles().length, 0, 'a host style survived dispose')
  assert.equal(hostIframes().length, 0, 'a host iframe survived dispose')
  assert.doesNotThrow(() => disposeA(), 'dispose is not idempotent')
})

// ------------------------------------------------------------- scenario D
// Backdrop containment: the glass stylesheet is scoped by one attribute on
// <html>, exists only while the full-window backdrop shows, and every way out
// (off, closed, framed in the panel, a failed load, a host with no root)
// removes the attribute with the style. The sandbox carries only what the
// player needs and messages go to the frame's own origin.

const rootHasBackdrop = () => documentElement.hasAttribute('data-aura-backdrop')
const newestGlassCss = () => {
  const style = glassStyles()[glassStyles().length - 1]
  return style ? String(style.textContent || '') : ''
}

{
  const off = makeCtx({ enabled: false, windowVisual: false })
  const dispose = pluginModule.default.register(off.ctx)
  await sleep(25)
  record('D1. no #aura-glass and no backdrop attribute while the backdrop is off', () => {
    assert.equal(glassStyles().length, 0, 'the glass style exists with the backdrop off')
    assert.equal(rootHasBackdrop(), false, 'the data-aura-backdrop attribute survived with the backdrop off')
    assert.equal(hostIframes().length, 0, 'a backdrop iframe exists with the backdrop off')
  })
  dispose()
}

{
  const on = makeCtx({ enabled: true, backdropMode: 'aura', windowVisual: true, panelEnabled: false })
  const dispose = pluginModule.default.register(on.ctx)
  await sleep(30)
  record('D2. a saved window visual does not mount a backdrop or glass on the host page', () => {
    assert.equal(hostIframes().length, 0, 'windowVisual mounted a body iframe')
    assert.equal(glassStyles().length, 0, 'windowVisual mounted #aura-glass')
    assert.equal(rootHasBackdrop(), false, 'windowVisual set data-aura-backdrop')
    assert.doesNotMatch(source, /data-hermes-glass-on/, 'Aura still reads the host glass attribute')
    assert.doesNotMatch(source, /data-aura-backdrop/, 'Aura still sets a backdrop attribute')
  })

  await recordAsync('D3. the in-pane iframe sandbox stays scripts, same-origin and presentation', async () => {
    const placed = makeCtx({
      enabled: true, backdropMode: 'video', panelEnabled: true,
      videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
    })
    const stop = pluginModule.default.register(placed.ctx)
    try {
      placed.timers.find(t => t.ms === 250).fn()
      await sleep(40)
      const film = filmNodes(renderContribution(placed.contributions.find(c => c.id === 'panel')))
      assert.equal(film.length, 1, 'the panel did not mount a film to check')
      const element = renderContribution({ render: () => film[0] })
      assert.equal(element.type, 'iframe', 'the panel film is not an iframe')
      assert.equal(element.props.sandbox, 'allow-scripts allow-same-origin allow-presentation')
      assert.equal(element.props.allow, 'autoplay; fullscreen; encrypted-media; picture-in-picture')
      assert.equal(hostIframes().length, 0, 'the panel film was appended to the host body')
    } finally {
      stop()
    }
  })

  await recordAsync('D4. with no Aura surface open, transport has no host frame to post into', async () => {
    assert.equal(hostIframes().length, 0, 'a body iframe was there to post into')
    assert.equal(pluginModule.wiringTest.post({ cmd: 'pause' }), false, 'transport posted with no in-pane frame')
  })

  dispose()
  record('D5. removing the backdrop removes the attribute with the style', () => {
    assert.equal(glassStyles().length, 0, 'the glass style survived the backdrop')
    assert.equal(rootHasBackdrop(), false, 'the data-aura-backdrop attribute survived the backdrop')
  })
}

{
  const panelled = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: true, filmBehind: false,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
  })
  const dispose = pluginModule.default.register(panelled.ctx)
  await sleep(30)
  record('D6. a film framed in the Right panel never mounts the glass or a body iframe', () => {
    assert.equal(hostIframes().length, 0, 'the pane film was appended to document.body')
    assert.equal(glassStyles().length, 0, 'the glass style exists over a panel film')
    assert.equal(rootHasBackdrop(), false, 'the scoping attribute exists over a panel film')
    const film = filmNodes(renderContribution(panelled.contributions.find(c => c.id === 'panel')))
    assert.equal(film.length, 1, 'the panel film is not a SandboxedFrame in AuraPane')
    assert.match(film[0].props.src, /\/player\.html/, 'the pane frame is not on the player page')
  })
  dispose()
}

{
  const closed = makeCtx({
    enabled: true, backdropMode: 'video', videoClosed: true, windowVisual: false,
    panelEnabled: false, videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
  })
  const dispose = pluginModule.default.register(closed.ctx)
  await sleep(25)
  record('D7. a closed film never leaves the glass (or the attribute) behind', () => {
    assert.equal(hostIframes().length, 0, 'a closed film kept its iframe')
    assert.equal(glassStyles().length, 0, 'a closed film kept the glass style')
    assert.equal(rootHasBackdrop(), false, 'a closed film kept the scoping attribute')
  })
  dispose()
}

{
  const failing = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: true, filmBehind: true,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', windowVisual: true
  })
  const dispose = pluginModule.default.register(failing.ctx)
  await sleep(30)
  record('D8. an old Behind chat setting stays in the panel and never mounts a body iframe', () => {
    assert.equal(hostIframes().length, 0, 'filmBehind mounted a body iframe')
    assert.equal(glassStyles().length, 0, 'filmBehind mounted the glass style')
    assert.equal(rootHasBackdrop(), false, 'filmBehind set data-aura-backdrop')
    const film = filmNodes(renderContribution(failing.contributions.find(c => c.id === 'panel')))
    assert.equal(film.length, 1, 'the film did not stay in the Right panel')
    assert.match(film[0].props.src, /\/player\.html/)
  })
  dispose()
}

// ------------------------------------------------------- review 3: frames
// The visualiser and the film live in Aura's own iframe, in the pane, the page
// or the watch window. Nothing is appended to the host body. The full-window
// visual returns with the SDK backdrop area (#155903).

await recordAsync('review 3a: Panel, Page and Window modes put no iframe on document.body', async () => {
  // Panel.
  const panel = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: true, windowVisual: false,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
  })
  let dispose = pluginModule.default.register(panel.ctx)
  try {
    panel.timers.find(t => t.ms === 250).fn()
    await sleep(60)
    assert.equal(hostIframes().length, 0, 'Panel mode appended a raw iframe to document.body')
    const film = filmNodes(renderContribution(panel.contributions.find(c => c.id === 'panel')))
    assert.equal(film.length, 1, 'Panel mode did not render AuraFilm in the pane')
    assert.equal(film[0].props.placement, 'panel')
  } finally {
    dispose()
  }

  // Page: the stage ref makes the page the film's surface.
  const page = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: false, windowVisual: false,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
  })
  dispose = pluginModule.default.register(page.ctx)
  try {
    page.timers.find(t => t.ms === 250).fn()
    await sleep(40)
    const route = page.contributions.find(c => c.area === 'routes')
    let tree = renderContribution(route)
    let stageRef = null
    walk(tree, node => {
      if (!stageRef && node.props && typeof node.props.ref === 'function') stageRef = node.props.ref
    })
    assert.equal(typeof stageRef, 'function', 'the page has no stage ref')
    stageRef({ getBoundingClientRect: () => ({ left: 40, top: 60, width: 800, height: 450 }) })
    tree = renderContribution(page.contributions.find(c => c.area === 'routes'))
    assert.equal(hostIframes().length, 0, 'Page mode appended a raw iframe to document.body')
    const film = filmNodes(tree)
    assert.equal(film.length, 1, 'Page mode did not render AuraFilm in the stage')
    assert.equal(film[0].props.placement, 'page')
  } finally {
    dispose()
  }

  // Watch window.
  const watch = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: false, videoWindow: true,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
  })
  dispose = pluginModule.default.register(watch.ctx)
  try {
    watch.timers.find(t => t.ms === 250).fn()
    await sleep(60)
    assert.equal(hostIframes().length, 0, 'Window mode appended a raw iframe to document.body')
    const film = filmNodes(renderContribution(watch.contributions.find(c => c.id === 'watch')))
    assert.equal(film.length, 1, 'Window mode did not render AuraFilm for the watch window')
    assert.equal(film[0].props.placement, 'window')
  } finally {
    dispose()
  }
})

await recordAsync('review 3b: an old Behind chat setting keeps the film in the panel and off the host body', async () => {
  const behind = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: true, filmBehind: true,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
  })
  const dispose = pluginModule.default.register(behind.ctx)
  try {
    behind.timers.find(t => t.ms === 250).fn()
    await sleep(60)
    assert.equal(hostIframes().length, 0, 'Behind chat appended an iframe to document.body')
    const film = filmNodes(renderContribution(behind.contributions.find(c => c.id === 'panel')))
    assert.equal(film.length, 1, 'the film left the Right panel')
    assert.equal(film[0].props.placement, 'panel')
    assert.match(film[0].props.src, /\/player\.html/)
  } finally {
    dispose()
  }
})

await recordAsync('review 3c: transport and audio posts reach the SandboxedFrame window', async () => {
  const panel = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: true, windowVisual: false,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
  })
  const dispose = pluginModule.default.register(panel.ctx)
  try {
    panel.timers.find(t => t.ms === 250).fn()
    await sleep(60)
    const film = filmNodes(renderContribution(panel.contributions.find(c => c.id === 'panel')))
    assert.equal(film.length, 1, 'no pane film to drive')
    const { frame } = mountFilm(film[0])
    assert.ok(frame, 'AuraFilm did not render a SandboxedFrame')
    assert.ok(pluginModule.wiringTest.post({ cmd: 'pause' }), 'the transport post did not reach the SandboxedFrame')
    pluginModule.wiringTest.audio({ cmd: 'mute' })
    const posts = frame.contentWindow.posted
    assert.ok(posts.some(entry => entry.message && entry.message.aura === 'transport' && entry.message.cmd === 'pause'),
      'transport did not arrive at the SandboxedFrame window')
    assert.ok(posts.some(entry => entry.message && entry.message.aura === 'audio' && entry.message.cmd === 'mute'),
      'audio did not arrive at the SandboxedFrame window')
    for (const entry of posts) {
      // The film frame has the Aura server's own origin: never post to '*'.
      assert.equal(entry.origin, new URL(frame.src).origin, `posted to ${entry.origin} instead of the film's origin`)
    }
    assert.equal(hostIframes().length, 0, 'the framed film also created a body iframe')
  } finally {
    dispose()
  }
})

{
  const root = globalThis.document.documentElement
  const setAttribute = root.setAttribute
  const removeAttribute = root.removeAttribute
  const noRoot = makeCtx({ enabled: true, backdropMode: 'aura', windowVisual: true, panelEnabled: false })
  root.setAttribute = undefined
  root.removeAttribute = undefined
  const dispose = pluginModule.default.register(noRoot.ctx)
  try {
    await sleep(25)
    record('D9. a host with no usable root fails safe: no glass, no transparent chat', () => {
      assert.equal(glassStyles().length, 0, 'the glass style mounted with no root to scope it')
      assert.equal(rootHasBackdrop(), false, 'a scoping attribute appeared on an unusable root')
      assert.equal(hostIframes().length, 0, 'the visualiser was left over an unwashable (transparent) chat')
    })
  } finally {
    root.setAttribute = setAttribute
    root.removeAttribute = removeAttribute
    dispose()
  }
}

// ------------------------------------------------------------- scenario B

sdk.themeState.name = 'nous'
const b = makeCtx({ enabled: true, intensity: 0.5, followAudio: true })
const disposeB = pluginModule.default.register(b.ctx)

await recordAsync('Restore my theme still works', async () => {
  const settings = b.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let restore = null
  walk(tree, node => {
    if (!restore && node.props && node.props['aria-label'] === 'Restore my theme') restore = node
  })
  assert.ok(restore, 'no Restore my theme control rendered')
  restore.props.onClick()
  await sleep(30)
  assert.equal(sdk.calls.accent.at(-1), null, 'accent override was not cleared')
  assert.deepEqual(b.controls.at(-1), { accent_pulse: false })
  const saved = b.storage.get('settings')
  assert.equal(saved.accentPulse, false, 'accent pulse was not turned off')
  assert.equal('themeOptIn' in saved, false, 'Restore my theme still writes a theme opt-in')
  assert.equal(hostStyles().length, 0, 'Restore my theme left a host style')
  assert.equal(glassStyles().length, 0, 'Restore my theme left the #aura-glass style')
  assert.equal(hostIframes().length, 0, 'Restore my theme left a host iframe')
})

record('dispose after Restore my theme is clean and does not re-request a theme', () => {
  const themeCallsBefore = sdk.calls.themes.length
  disposeB()
  assert.equal(b.contributions.length, 0)
  assert.ok(b.timers.every(t => t.cleared))
  assert.ok(b.listeners.every(t => t.removed))
  assert.equal(sdk.calls.themes.length, themeCallsBefore, 'dispose requested a theme after restore')
})

// ------------------------------------------- upgrading from the old theme
// The optional Aura Live theme is gone from this build, but an upgrading user's
// host can still be wearing it. Aura must hand a real theme back once, and must
// never mount the backdrop just because the old theme is active.

await recordAsync('an active aura-live theme from an older version is handed back', async () => {
  sdk.themeState.name = 'nous'
  const old = makeCtx({ enabled: true, intensity: 0.5, windowVisual: false })
  const disposeOld = pluginModule.default.register(old.ctx)
  const probe = old.contributions.find(c => c.area === 'titleBar.center')
  try {
    // The user's own theme is known from this boot before the old skin appears.
    renderContribution(probe)
    await sleep(20)
    const before = sdk.calls.themes.length
    sdk.themeState.name = 'aura-live'
    renderContribution(probe)
    await sleep(20)
    assert.equal(sdk.calls.themes.length, before + 1, 'the old aura-live theme was not handed back')
    assert.equal(sdk.calls.themes.at(-1), 'nous', 'Aura did not hand back the previous user theme')
    old.timers.filter(t => t.ms === 250).forEach(t => t.fn())
    await sleep(30)
    assert.equal(hostIframes().length, 0, 'the leftover aura-live theme mounted the backdrop')
    assert.equal(glassStyles().length, 0, 'the leftover aura-live theme mounted the glass style')
  } finally {
    disposeOld()
    sdk.themeState.name = 'nous'
  }
})

await recordAsync('an aura-live theme with no known previous theme falls back to default', async () => {
  sdk.themeState.name = 'aura-live'
  const unknown = makeCtx({ enabled: true })
  const disposeUnknown = pluginModule.default.register(unknown.ctx)
  const probe = unknown.contributions.find(c => c.area === 'titleBar.center')
  try {
    renderContribution(probe)
    await sleep(20)
    assert.equal(sdk.calls.themes.at(-1), 'default', 'no previous theme was known and default was not requested')
    assert.equal(hostIframes().length, 0, 'the leftover aura-live theme mounted the backdrop')
  } finally {
    disposeUnknown()
    sdk.themeState.name = 'nous'
  }
})

// ------------------------------------------------- a skin change keeps the visual
// Changing the app's own theme used to switch "Visual behind the app" off in
// silence, so the visualiser vanished and the switch had to be found again. The
// glass is measured from the theme's colours, so it is re-measured instead.

sdk.themeState.name = 'nous'
const skin = makeCtx({ enabled: true, backdropMode: 'aura', windowVisual: true, panelEnabled: true })
const disposeSkin = pluginModule.default.register(skin.ctx)
const probeSkin = skin.contributions.find(c => c.area === 'titleBar.center')

await recordAsync('changing the app theme leaves the in-pane visualiser mounted and paints nothing on the host', async () => {
  renderContribution(probeSkin)
  skin.timers.filter(t => t.ms === 250).forEach(t => t.fn())
  await sleep(40)
  const before = filmNodes(renderContribution(skin.contributions.find(c => c.id === 'panel')))
  assert.equal(before.length, 1, 'the visualiser was not in the panel before the theme change')
  assert.match(before[0].props.src, /overlay=1/)
  sdk.themeState.name = 'midnight'
  renderContribution(probeSkin)
  skin.timers.filter(t => t.ms === 250).forEach(t => t.fn())
  await sleep(40)
  const again = filmNodes(renderContribution(skin.contributions.find(c => c.id === 'panel')))
  assert.equal(again.length, 1, 'a theme change unmounted the in-pane visualiser')
  assert.match(again[0].props.src, /overlay=1/)
  assert.equal(hostIframes().length, 0, 'a theme change painted the host page')
  assert.equal(glassStyles().length, 0, 'a theme change mounted #aura-glass')
})

record('dispose of the skin-change instance is clean', () => {
  disposeSkin()
  sdk.themeState.name = 'nous'
  assert.equal(skin.contributions.length, 0)
})

// ------------------------------------------------------------- scenario C
// Legacy glass keys are accepted but ignored; host glass is gone. The active
// theme is deliberately NOT aura-live, so any mounted glass would prove the
// legacy keys themselves mounted something.

sdk.themeState.name = 'nous'
const c = makeCtx({ enabled: true, intensity: 0.5, overlayOpacity: 0.3, glass: 0.5, motion: 'designs' })
const disposeC = pluginModule.default.register(c.ctx)

await recordAsync('legacy glass keys are ignored and no host glass is mounted', async () => {
  const probe = c.contributions.find(x => x.area === 'titleBar.center')
  renderContribution(probe)
  await sleep(30)
  const settings = c.contributions.find(x => x.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let visibility = null
  walk(tree, node => {
    if (!visibility && node.type === 'input' && node.props && node.props['aria-label'] === 'Background visibility') visibility = node
  })
  assert.equal(visibility, null, 'legacy host-glass control is still rendered')
  assert.equal(glassStyles().length, 0, 'legacy glass keys mounted the #aura-glass style')
  assert.equal(hostStyles().length, 0)
  assert.equal(hostIframes().length, 0)
})

record('a legacy designs motion value is accepted and shown as a legacy option', () => {
  const settings = c.contributions.find(x => x.area === 'settings.plugins')
  const select = findSwitch(renderContribution(settings), 'Motion source')
  assert.ok(select, 'Motion source select missing')
  assert.equal(select.props.value, 'designs', 'legacy designs was dropped from the saved settings')
  const options = select.props.children.map(option => option.props.value)
  assert.ok(options.includes('designs'), 'the saved legacy designs value has no matching option')
  const legacy = select.props.children.find(option => option.props.value === 'designs')
  assert.equal(legacy.props.children, 'Designs only (legacy)')
})

record('dispose from the legacy-storage scenario is clean', () => {
  disposeC()
  assert.equal(c.contributions.length, 0)
  assert.ok(c.timers.every(t => t.cleared))
  assert.ok(c.listeners.every(t => t.removed))
})

// ------------------------------------------------------------- scenario E
// Opt-in by default: a fresh install applies no accent override.

const e = makeCtx()
const disposeE = pluginModule.default.register(e.ctx)

await recordAsync('accent pulse is off by default', async () => {
  await sleep(20)
  const accentBefore = sdk.calls.accent.length
  const probe = e.contributions.find(c => c.area === 'titleBar.center')
  renderContribution(probe)
  e.timers.find(t => t.ms === 250).fn()
  await sleep(30)
  assert.equal(sdk.calls.accent.length, accentBefore, 'accent was applied without opt-in')
  const settings = e.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let accentSwitch = null
  walk(tree, node => {
    if (!accentSwitch && node.props && node.props['aria-label'] === 'Accent pulse') accentSwitch = node
  })
  assert.ok(accentSwitch, 'the accent switch is missing')
  assert.equal(accentSwitch.props.checked, false, 'accent pulse defaults on')
  assert.equal(hostStyles().length, 0)
  assert.equal(hostIframes().length, 0)

  // Desktop defaults for a new user: agent_music, calm, 0.4 opacity, 0 intensity,
  // "Show: Always". Saved settings keep their own values (covered elsewhere).
  const motion = findSwitch(tree, 'Motion source')
  assert.equal(motion.props.value, 'agent_music', 'motion default is not agent_music')
  const behavior = (() => {
    let found = null
    walk(tree, node => {
      if (!found && node.type === 'select' && node.props && node.props['aria-label'] === 'Behaviour profile') found = node
    })
    return found
  })()
  assert.equal(behavior.props.value, 'calm', 'behaviour default is not calm')
  const opacity = (() => {
    let found = null
    walk(tree, node => {
      if (!found && node.type === 'input' && node.props && node.props['aria-label'] === 'Visual opacity') found = node
    })
    return found
  })()
  assert.equal(opacity.props.value, 25, 'opacity default is not 0.25')
  const show = (() => {
    let found = null
    walk(tree, node => {
      if (!found && node.type === 'select' && node.props && node.props['aria-label'] === 'Show') found = node
    })
    return found
  })()
  assert.equal(show.props.value, 'always', 'showWhen default is not always')
  const intensity = (() => {
    let found = null
    walk(tree, node => {
      if (!found && node.type === 'input' && node.props && node.props['aria-label'] === 'Reaction strength') found = node
    })
    return found
  })()
  assert.equal(intensity.props.value, 0, 'intensity default is not 0')
})

record('dispose from the defaults scenario is clean', () => {
  disposeE()
  assert.equal(e.contributions.length, 0)
  assert.ok(e.timers.every(t => t.cleared))
  assert.ok(e.listeners.every(t => t.removed))
})

// ------------------------------------------------------------- scenario F
// The status-bar quick menu (owner ask: "small icon of an A ... with a drop
// down" exposing the essentials). One register, one set of controls.

sdk.themeState.name = 'nous'
const f = makeCtx({
  enabled: true,
  intensity: 0.5,
  opacity: 0.75,
  behavior: 'balanced',
  motion: 'both',
  reducedMotion: false
})
const disposeF = pluginModule.default.register(f.ctx)

const quickTree = () => {
  const menu = f.contributions.find(c => c.id === 'quick-menu')
  assert.ok(menu, 'quick menu contribution vanished')
  return renderContribution(menu)
}
const findByText = (tree, text) => {
  let found = null
  walk(tree, node => {
    if (!found && node.props && node.props.children === text) found = node
  })
  return found
}
const findByAria = (tree, label) => {
  let found = null
  walk(tree, node => {
    if (!found && node.props && node.props['aria-label'] === label) found = node
  })
  return found
}
const quickTrigger = tree => {
  let found = null
  walk(tree, node => {
    if (
      !found &&
      node.type === sdk.Button &&
      node.props &&
      node.props['aria-label'] === 'Aura quick settings'
    ) found = node
  })
  return found
}
const quickDot = tree => {
  let found = null
  walk(tree, node => {
    if (
      !found &&
      node.type === 'span' &&
      node.props &&
      node.props.style &&
      node.props.style.borderRadius === 999
    ) found = node
  })
  return found
}
const fTick = async () => {
  // A host tick is always >= 250 ms after the last poll; wait out the cadence
  // so this manual tick stands in for one (pollDue is elapsed-time based).
  const since = Date.now() - pluginModule.wiringTest.lastPollAt()
  if (since < 250) await sleep(250 - since)
  f.timers.find(t => t.ms === 250).fn()
  await sleep(30)
}
const fSaved = () => f.storage.get('settings', {})
const fLastControl = () => f.controls.at(-1)

record('quick menu renders the button, every control and no stray popover state', () => {
  const tree = quickTree()
  const trigger = quickTrigger(tree)
  assert.ok(trigger, 'no quick-menu trigger button')
  assert.equal(trigger.props.title, 'Aura', 'the tooltip must read "Aura"')
  assert.equal(trigger.props['aria-expanded'], false, 'menu must start closed')
  let glyph = null
  walk(tree, node => {
    if (!glyph && node.type === 'span' && node.props && node.props.style && node.props.style.fontWeight === 600) glyph = node
  })
  assert.ok(glyph && texts(glyph).includes('Aura'), 'the Aura wordmark is missing')
  // The mark is inline SVG so it needs no asset and cannot 404.
  let mark = null
  walk(tree, node => {
    if (!mark && node.type === 'svg') mark = node
  })
  assert.ok(mark && mark.props.width === 13, 'the Aura mark (inline svg) is missing')
  const body = texts(tree)
  for (const label of ['Reacts to', 'Intensity', 'Visual strength', 'Style', 'Show', 'All Aura settings']) {
    assert.ok(body.includes(label), `quick menu is missing "${label}"`)
  }
  const motion = findByAria(tree, 'Reacts to')
  assert.ok(motion && motion.props.value === 'both', 'Reacts-to select missing or wrong')
  const motionOptions = []
  walk(motion, node => {
    if (node.type === 'option') motionOptions.push([node.props.value, texts(node)])
  })
  assert.deepEqual(
    motionOptions,
    [
      ['both', 'Music, or gentle designs'],
      ['music', 'Music only'],
      ['agent', 'Agent activity'],
      ['agent_music', 'Agent + music (default)']
    ],
    'Reacts-to options drifted from the settings page'
  )
  const style = findByAria(tree, 'Style')
  assert.ok(style && style.props.value === 'balanced', 'Style select missing or wrong')
  const show = findByAria(tree, 'Show')
  assert.ok(show && show.props.value === 'always', 'Show select missing or wrong')
  const showOptions = []
  walk(show, node => {
    if (node.type === 'option') showOptions.push([node.props.value, texts(node)])
  })
  assert.deepEqual(showOptions, [['always', 'Always'], ['active', 'Only while active']], 'Show options drifted')
  const intensity = findByAria(tree, 'Intensity')
  const transparency = findByAria(tree, 'Visual strength')
  assert.equal(intensity.props.value, 50, 'intensity slider mis-scaled')
  assert.equal(transparency.props.value, 75, 'transparency slider mis-scaled')
  const enabled = findByAria(tree, 'Aura enabled')
  const gentle = findByAria(tree, 'Gentle motion (motion-sensitive)')
  assert.ok(enabled && enabled.props.checked === true, 'on/off switch missing or unchecked')
  assert.ok(gentle && gentle.props.checked === false, 'gentle switch missing or wrong default')
})

record('quick menu trigger dims when Aura is off and lights up when on', () => {
  const on = quickTrigger(quickTree())
  assert.match(on.props.style.color, /--ui-accent/, 'enabled trigger is not accent-coloured')
})

await recordAsync('the quick menu on/off switch drives /control, storage and the dot', async () => {
  const off = findByAria(quickTree(), 'Aura enabled')
  off.props.onCheckedChange(false)
  await sleep(30)
  assert.deepEqual(fLastControl(), { enabled: false }, 'off did not push {enabled:false}')
  assert.equal(fSaved().enabled, false, 'off did not persist')
  await fTick()
  const dot = quickDot(quickTree())
  assert.equal(dot.props.style.opacity, 0, 'the dot keeps breathing while Aura is off')
  const dim = quickTrigger(quickTree())
  assert.match(dim.props.style.color, /--ui-text-tertiary/, 'trigger does not dim when off')
  const back = findByAria(quickTree(), 'Aura enabled')
  back.props.onCheckedChange(true)
  await sleep(30)
  assert.deepEqual(fLastControl(), { enabled: true }, 'on did not push {enabled:true}')
  await fTick()
  assert.match(quickTrigger(quickTree()).props.style.color, /--ui-accent/, 'trigger does not relight')
})

await recordAsync('changing "Reacts to" pushes and persists like the settings page', async () => {
  findByAria(quickTree(), 'Reacts to').props.onChange({ target: { value: 'music' } })
  await sleep(30)
  assert.deepEqual(fLastControl(), { motion: 'music' }, 'motion push missing or wrong')
  assert.equal(fSaved().motion, 'music', 'motion did not persist')
  assert.equal(findByAria(quickTree(), 'Reacts to').props.value, 'music', 'select did not round-trip')
})

await recordAsync('the intensity slider round-trips through 0-100 and pushes 0-1', async () => {
  findByAria(quickTree(), 'Intensity').props.onChange({ target: { value: '60' } })
  await sleep(30)
  assert.deepEqual(fLastControl(), { intensity: 0.6 }, 'intensity push missing or wrong')
  assert.equal(fSaved().intensity, 0.6, 'intensity did not persist')
  assert.equal(findByAria(quickTree(), 'Intensity').props.value, 60, 'slider did not round-trip')
  assert.ok(texts(quickTree()).includes('60%'), 'intensity readout missing')
})

await recordAsync('the transparency slider round-trips through the opacity setting', async () => {
  findByAria(quickTree(), 'Visual strength').props.onChange({ target: { value: '30' } })
  await sleep(30)
  assert.deepEqual(fLastControl(), { opacity: 0.3 }, 'opacity push missing or wrong')
  assert.equal(fSaved().opacity, 0.3, 'opacity did not persist')
  assert.equal(findByAria(quickTree(), 'Visual strength').props.value, 30, 'slider did not round-trip')
})

await recordAsync('the style select pushes behaviour changes', async () => {
  findByAria(quickTree(), 'Style').props.onChange({ target: { value: 'calm' } })
  await sleep(30)
  assert.deepEqual(fLastControl(), { behavior: 'calm' }, 'behaviour push missing or wrong')
  assert.equal(fSaved().behavior, 'calm', 'behaviour did not persist')
  assert.equal(findByAria(quickTree(), 'Style').props.value, 'calm', 'select did not round-trip')
})

await recordAsync('the Show control persists and pushes like every other quick-menu control', async () => {
  findByAria(quickTree(), 'Show').props.onChange({ target: { value: 'active' } })
  await sleep(30)
  assert.equal(fSaved().showWhen, 'active', 'showWhen did not persist')
  assert.deepEqual(fLastControl(), { show_when: 'active' }, 'showWhen push missing or wrong')
  assert.equal(findByAria(quickTree(), 'Show').props.value, 'active', 'Show select did not round-trip')
  // Back to Always so the later backdrop assertions are not timing-dependent.
  findByAria(quickTree(), 'Show').props.onChange({ target: { value: 'always' } })
  await sleep(30)
  assert.equal(fSaved().showWhen, 'always', 'showWhen did not return to always')
})

await recordAsync('the dot breathes while the visual moves', async () => {
  await fTick()
  const first = quickDot(quickTree()).props.style.opacity
  assert.ok(first > 0, 'the dot is frozen while music plays')
  await fTick()
  const second = quickDot(quickTree()).props.style.opacity
  assert.notEqual(second, first, 'the dot does not advance between ticks')
})

await recordAsync('gentle motion freezes the dot and pushes reduced_motion', async () => {
  findByAria(quickTree(), 'Gentle motion (motion-sensitive)').props.onCheckedChange(true)
  await sleep(30)
  assert.equal(fSaved().reducedMotion, true, 'gentle motion did not persist')
  assert.deepEqual(fLastControl(), { reduced_motion: true }, 'reduced_motion not forwarded')
  await fTick()
  assert.equal(quickDot(quickTree()).props.style.opacity, 0.55, 'reduced dot does not hold 0.55')
  await fTick()
  await fTick()
  assert.equal(quickDot(quickTree()).props.style.opacity, 0.55, 'the dot still cycles under reduced motion')
})

await recordAsync('gentle motion flips the web half through the visualiser URL', async () => {
  findByAria(quickTree(), 'Gentle motion (motion-sensitive)').props.onCheckedChange(false)
  await sleep(30)
  const panelFilm = () => filmNodes(renderContribution(f.contributions.find(c => c.id === 'panel')))
  assert.equal(panelFilm().length, 1, 'the panel did not render the visualiser')
  assert.match(panelFilm()[0].props.src, /overlay=1/, 'the visualiser URL lost the overlay flag')
  assert.doesNotMatch(panelFilm()[0].props.src, /reduced-motion/, 'reduced motion was on before the switch')
  findByAria(quickTree(), 'Gentle motion (motion-sensitive)').props.onCheckedChange(true)
  await sleep(30)
  assert.match(panelFilm()[0].props.src, /reduced-motion=1/, 'gentle motion lost its force-switch')
  assert.equal(hostIframes().length, 0, 'gentle motion mounted a body iframe')
  findByAria(quickTree(), 'Gentle motion (motion-sensitive)').props.onCheckedChange(false)
  await sleep(30)
  assert.doesNotMatch(panelFilm()[0].props.src, /reduced-motion/, 'the force-switch stayed after gentle off')
})

await recordAsync('"All Aura settings" navigates to the plugin settings page', async () => {
  const navsBefore = sdk.calls.navigations.length
  const button = (() => {
    let found = null
    walk(quickTree(), node => {
      if (!found && node.type === sdk.Button && node.props && node.props['aria-label'] === 'All Aura settings') found = node
    })
    return found
  })()
  assert.ok(button, 'All Aura settings button missing')
  button.props.onClick()
  assert.equal(sdk.calls.navigations.length, navsBefore + 1, 'navigation did not happen')
  assert.equal(sdk.calls.navigations.at(-1), '/settings?tab=plugins&agent=aura', 'wrong settings route')
})

await recordAsync('the quick menu shows the same version chip as the settings page', async () => {
  await sleep(30)
  let chip = null
  walk(quickTree(), node => {
    if (!chip && node.props && node.props.key === 'build' && typeof node.type === 'function') chip = node
  })
  assert.ok(chip, 'the quick menu has no version chip')
  const body = texts(chip.type(chip.props))
  assert.ok(body.includes('v1.2.3'), 'the quick menu chip does not show the shared build line')
  assert.ok(body.includes('abcdef12'), 'the quick menu chip is not the shared build line')
  // The suite's one chip line (as Omniscience shows it): version, commit date, commit.
  // The compact menu chip used to drop the date (owner, 11-14).
  assert.ok(body.includes('v1.2.3 · 2026-11-09 · abcdef12'), `the quick menu chip is not "v1.2.3 · 2026-11-09 · abcdef12" (got ${body})`)
})

await recordAsync('switching the Right panel off disposes the pane and on re-registers it', async () => {
  assert.ok(f.contributions.some(c => c.area === 'panes'), 'the pane was not registered at boot')
  const undismissedBefore = sdk.calls.undismissed.length
  const revealedBefore = sdk.calls.revealed.length
  const page = renderContribution(f.contributions.find(c => c.area === 'settings.plugins'))
  const off = findByAria(page, 'Right panel')
  assert.ok(off, 'the Right panel switch is missing')
  off.props.onCheckedChange(false)
  await sleep(30)
  assert.equal(f.contributions.some(c => c.area === 'panes'), false, 'the pane contribution survived switch-off')
  assert.equal(f.storage.get('settings').panelEnabled, false, 'switch-off was not persisted')
  const on = findByAria(renderContribution(f.contributions.find(c => c.area === 'settings.plugins')), 'Right panel')
  on.props.onCheckedChange(true)
  await sleep(30)
  assert.ok(f.contributions.some(c => c.area === 'panes'), 'the pane did not re-register when switched back on')
  assert.equal(f.storage.get('settings').panelEnabled, true, 'switch-on was not persisted')
  assert.equal(sdk.calls.undismissed.length, undismissedBefore + 1, 'undismissPane was not called')
  assert.equal(sdk.calls.undismissed.at(-1), 'aura:panel', 'undismissPane got the wrong contribution-scoped id')
  assert.equal(sdk.calls.revealed.length, revealedBefore + 1, 'revealPane was not called')
  assert.equal(sdk.calls.revealed.at(-1), 'aura:panel', 'revealPane got the wrong contribution-scoped id')
})

record('dispose from the quick-menu scenario is clean', () => {
  disposeF()
  assert.equal(f.contributions.length, 0, 'the quick-menu contribution survived dispose')
  assert.ok(f.timers.every(t => t.cleared))
  assert.ok(f.listeners.every(t => t.removed), 'the quick menu leaked a listener')
  assert.equal(hostIframes().length, 0)
  assert.equal(hostStyles().length, 0)
})

// ------------------------------------------------------------- scenario G
// "Show: Only while active": fake timers drive the fade state machine. The
// backdrop and #aura-glass must exist only while the visual is moving and
// must be removed again once the fade-out completes.

const fireTimer = async (bucket, ms) => {
  const record = bucket.timers.find(t => t.kind === 'timeout' && t.ms === ms && !t.cleared && !t.fired)
  assert.ok(record, `no pending ${ms} ms timeout`)
  record.fired = true
  record.fn()
  await sleep(10)
}
const firePoll = async bucket => {
  const record = bucket.timers.find(t => t.kind === 'interval' && !t.cleared)
  assert.ok(record, 'no polling interval')
  record.fn()
  await sleep(30)
}
const setMoving = (bucket, moving) => {
  bucket.serverFrame.mood = moving ? 'thinking' : 'idle'
  bucket.serverFrame.silence = !moving
  bucket.serverFrame.level = moving ? 0.55 : 0
}

sdk.themeState.name = 'nous'
const g = makeCtx({
  enabled: true,
  intensity: 0.5,
  opacity: 0.35,
  behavior: 'balanced',
  motion: 'agent_music',
  reducedMotion: false,
  windowVisual: true,
  showWhen: 'active'
})
const disposeG = pluginModule.default.register(g.ctx)
await sleep(40)

await recordAsync('Only while active fades the in-pane visualiser and never the host page', async () => {
  assert.equal(hostIframes().length, 0, 'Show active mounted a body iframe')
  assert.equal(glassStyles().length, 0, 'Show active mounted #aura-glass')
  const delay = g.timers.find(t => t.kind === 'timeout' && t.ms === 300 && !t.cleared)
  if (delay) {
    delay.fired = true
    delay.fn()
  }
  await sleep(20)
  assert.equal(hostIframes().length, 0, 'the in-pane fade mounted a body iframe')
  assert.equal(glassStyles().length, 0, 'the in-pane fade mounted #aura-glass')
  await firePoll(g)
  assert.equal(hostIframes().length, 0, 'a poll mounted a body iframe')
  assert.equal(glassStyles().length, 0, 'a poll mounted #aura-glass')
})

record('dispose from the active-fade scenario cancels timers and removes everything', () => {
  disposeG()
  assert.equal(g.contributions.length, 0, 'contributions survived dispose')
  assert.ok(
    g.timers.filter(t => t.kind === 'interval').every(t => t.cleared),
    'a polling interval survived dispose'
  )
  assert.ok(
    g.timers.filter(t => t.kind === 'timeout').every(t => t.cleared || t.fired),
    'a fade timer survived dispose'
  )
  assert.ok(g.listeners.every(t => t.removed), 'a listener survived dispose')
  assert.equal(hostIframes().length, 0)
  assert.equal(hostStyles().length, 0)
})

// ------------------------------------------------------------- scenario H
// The quick menu must read the server, not stale local storage. Simulate the
// owner's real case: the server holds motion 'agent' / behaviour 'calm' while
// the local saved settings disagree.

sdk.themeState.name = 'nous'
const h = makeCtx({
  enabled: true,
  intensity: 0.9,
  opacity: 0.8,
  behavior: 'intense',
  motion: 'both',
  reducedMotion: false,
  windowVisual: false,
  showWhen: 'always'
})
h.serverSettings.motion = 'agent'
h.serverSettings.behavior = 'calm'
h.serverSettings.intensity = 0.2
h.serverSettings.opacity = 0.4
h.serverSettings.reduced_motion = true
const disposeH = pluginModule.default.register(h.ctx)
await sleep(40)

const hMenu = () => {
  const menu = h.contributions.find(c => c.id === 'quick-menu')
  assert.ok(menu, 'quick menu contribution vanished')
  return renderContribution(menu)
}

await recordAsync('poll syncs stale local display settings from the server /state', async () => {
  const saved = h.storage.get('settings')
  assert.equal(saved.motion, 'agent', 'local motion was not synced from the server')
  assert.equal(saved.behavior, 'calm', 'local behaviour was not synced from the server')
  assert.equal(saved.intensity, 0.2, 'local intensity was not synced from the server')
  assert.equal(saved.opacity, 0.4, 'local opacity was not synced from the server')
  assert.equal(saved.reducedMotion, true, 'local reduced motion was not synced from the server')
  const tree = hMenu()
  assert.equal(findByAria(tree, 'Reacts to').props.value, 'agent', 'the menu still shows the stale motion')
  assert.equal(findByAria(tree, 'Style').props.value, 'calm', 'the menu still shows the stale behaviour')
  assert.equal(findByAria(tree, 'Intensity').props.value, 20, 'the menu still shows the stale intensity')
  assert.equal(findByAria(tree, 'Visual strength').props.value, 40, 'the menu still shows the stale opacity')
  assert.equal(findByAria(tree, 'Gentle motion (motion-sensitive)').props.checked, true, 'the menu still shows stale reduced motion')
})

await recordAsync('every quick-menu control reaches /control and updates the server value', async () => {
  findByAria(hMenu(), 'Reacts to').props.onChange({ target: { value: 'music' } })
  await sleep(30)
  assert.equal(h.serverSettings.motion, 'music', 'the server motion did not update')
  findByAria(hMenu(), 'Style').props.onChange({ target: { value: 'intense' } })
  await sleep(30)
  assert.equal(h.serverSettings.behavior, 'intense', 'the server behaviour did not update')
  findByAria(hMenu(), 'Intensity').props.onChange({ target: { value: '60' } })
  await sleep(30)
  assert.equal(h.serverSettings.intensity, 0.6, 'the server intensity did not update')
  findByAria(hMenu(), 'Visual strength').props.onChange({ target: { value: '30' } })
  await sleep(30)
  assert.equal(h.serverSettings.opacity, 0.3, 'the server opacity did not update')
  findByAria(hMenu(), 'Gentle motion (motion-sensitive)').props.onCheckedChange(false)
  await sleep(30)
  assert.equal(h.serverSettings.reduced_motion, false, 'the server reduced_motion did not update')
  findByAria(hMenu(), 'Show').props.onChange({ target: { value: 'active' } })
  await sleep(30)
  assert.deepEqual(h.controls.at(-1), { show_when: 'active' }, 'the Show control did not push')
  await firePoll(h)
  assert.equal(findByAria(hMenu(), 'Reacts to').props.value, 'music', 'a later poll reverted the server-synced motion')
  assert.equal(findByAria(hMenu(), 'Style').props.value, 'intense', 'a later poll reverted the server-synced behaviour')
})

record('dispose from the server-sync scenario is clean', () => {
  disposeH()
  assert.equal(h.contributions.length, 0)
  assert.ok(h.timers.filter(t => t.kind === 'interval').every(t => t.cleared))
  assert.ok(h.listeners.every(t => t.removed))
  assert.equal(hostIframes().length, 0)
  assert.equal(hostStyles().length, 0)
})

// ------------------------------------------------- video strip (regression)
// The owner once ended up with the video playing and NO controls at all, so
// this pins down that video mode actually draws the strip, with its grip,
// scrub bar and close button, and that closing removes it.

const v = makeCtx({
  enabled: true,
  backdropMode: 'video',
  windowVisual: true,
  // No panel, no page, no watch window, no desktop film: nothing for a strip to drive.
  panelEnabled: false,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
})
pluginModule.default.register(v.ctx)
v.timers.find(t => t.ms === 250).fn()
await sleep(80)

await recordAsync('video mode does not float a control strip when no film surface is open', async () => {
  const bar = [...bodyChildren, ...floatingNodes()].find(node => node.attributes && node.attributes.role === 'toolbar')
  assert.equal(bar, undefined, 'a control strip mounted with no film to control')
  assert.equal(v.contributions.find(c => c.id === 'strip' && c.removed !== true), undefined,
    'the strip pane was registered with nothing to control')
})

const stripFilm = makeCtx({
  enabled: true,
  backdropMode: 'video',
  windowVisual: true,
  videoWindow: true,
  panelEnabled: false,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
})
pluginModule.default.register(stripFilm.ctx)
stripFilm.timers.find(t => t.ms === 250).fn()
await sleep(40)

await recordAsync('the watch window still mounts the two-row control strip with grip, scrub and close', async () => {
  const bar = [...bodyChildren, ...floatingNodes()].find(node => node.attributes && node.attributes.role === 'toolbar')
  assert.ok(bar, 'the watch-window control strip never mounted')
  const nodes = []
  const collect = node => {
    for (const child of node.children || []) {
      nodes.push(child)
      collect(child)
    }
  }
  collect(bar)
  const barText = nodes.map(node => node.textContent || '').join('|')
  assert.ok(barText.includes('⠿'), 'drag grip missing from the strip')
  assert.ok(barText.includes('✕'), 'close button missing from the strip')
  assert.ok(barText.includes('Big Buck Bunny · Blender film'), 'the current film title is missing from the strip')
  assert.ok(
    nodes.some(node => node.attributes && node.attributes.role === 'slider'),
    'scrub bar missing from the strip'
  )
  const transport = bar.children.find(row => (row.children || []).some(child => child.textContent === '▶' || child.textContent === '⏸'))
  assert.ok(transport, 'the strip has no transport row')
  const transportText = (transport.children || []).map(child => child.textContent || '').join('')
  for (const glyph of ['⏮', '⏪', '⏩', '⏭']) {
    assert.ok(transportText.includes(glyph), `transport row is missing ${glyph}`)
  }
  assert.equal(transport.style.justifyContent, 'center', 'the transport row is not centred')
  assert.equal(bar.style.flexDirection, 'column', 'the strip is not stacked')
  assert.equal(bar.style.width, '100%', 'the strip does not fill its floating pane')
  const pane = stripFilm.contributions.find(c => c.id === 'watch' && c.removed !== true)
  assert.ok(pane, 'the watch window pane was not registered')
  const width = parseFloat(pane.data.width)
  const height = parseFloat(pane.data.height)
  assert.ok(width >= 480, `the watch pane is ${pane.data.width}, not a stage`)
  assert.equal(height - 30, Math.round(width * 9 / 16) + 96, 'the film stage is not 16:9 above its strip')
  assert.equal(bar.style.opacity, '1', 'the strip must start visible')
})

// ------------------------------------------ tray strip position and drag
// Owner bug: the strip has a drag grip but in strip-only mode it could not be
// moved — the grip always dragged the watch window (converting the film into
// one) instead of the strip. Review ask: the strip's position must not be read
// from the app's composer markup; a saved free position (with a bottom-centre
// default from the window size) is the source of truth.

const trayBar = () => [...bodyChildren, ...floatingNodes()].find(node => node.attributes && node.attributes.role === 'toolbar')
function trayNodes(bar) {
  const nodes = []
  const collect = node => {
    for (const child of node.children || []) {
      nodes.push(child)
      collect(child)
    }
  }
  collect(bar)
  return nodes
}

record('review 1: the watch-window strip lives in an SDK floating pane, never on document.body', () => {
  const bar = trayBar()
  assert.ok(bar, 'the watch-window control strip never mounted')
  assert.equal(bodyChildren.includes(bar), false, 'the strip was appended to document.body')
  const pane = stripFilm.contributions.find(c => c.id === 'watch' && c.removed !== true)
  assert.ok(pane, 'no floating pane was registered for the watch window')
  assert.equal(pane.area, 'panes', 'the watch pane is not a PANES_AREA contribution')
  assert.equal(pane.data.placement, 'floating', 'the watch pane is not floating')
  assert.equal(pane.data.anchor, 'top-right', 'the watch window should spawn top-right when the panel is closed')
  assert.ok(floatingNodes().includes(bar), 'the strip is not inside the floating pane')
})

record('review 1: the host drags the floating pane, so the old grip is hidden and drags nothing', () => {
  const bar = trayBar()
  const grip = trayNodes(bar).find(node => node.textContent === '⠿')
  assert.ok(grip, 'drag grip node missing')
  assert.equal(grip.style.display, 'none', 'the old grip still shows beside the host drag header')
  const down = (grip.__handlers.mousedown || [])[0]
  if (down) down({ clientX: 100, clientY: 100, preventDefault() {} })
  assert.equal(stripFilm.storage.get('settings').videoWindow, true, 'the grip closed the watch window')
  assert.equal(bodyChildren.includes(bar), false, 'a drag put the strip back on document.body')
})

// ---------------------------------------------------- watch window size row
// The window used to be resizable only from the status menu, and it opened too
// small. Its own strip now carries a Size row, and the default is Large.

const sizeCtx = makeCtx({
  enabled: true,
  backdropMode: 'video',
  windowVisual: true,
  videoWindow: true,
  panelEnabled: false,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
})
pluginModule.default.register(sizeCtx.ctx)
sizeCtx.timers.find(t => t.ms === 250).fn()
await sleep(40)

function watchBar() {
  const bars = [...bodyChildren, ...floatingNodes()].filter(node => node.attributes && node.attributes.role === 'toolbar')
  return bars[bars.length - 1]
}
function watchNodes(bar) {
  const nodes = []
  const collect = node => {
    for (const child of node.children || []) {
      nodes.push(child)
      collect(child)
    }
  }
  collect(bar)
  return nodes
}
function watchPill(nodes, label) {
  return nodes.find(node => node.attributes && node.attributes['aria-label'] === `Watch window size: ${label}`) || null
}

record('the watch window bar has a Size row with one pill per size', () => {
  const bar = watchBar()
  assert.ok(bar, 'the watch window strip never mounted')
  const nodes = watchNodes(bar)
  const sizeRow = bar.children.find(row =>
    (row.children || []).some(child => child.textContent === 'Size'))
  assert.ok(sizeRow, 'the strip has no Size row')
  for (const label of ['Small', 'Medium', 'Large', 'X-Large', 'Huge']) {
    assert.ok(watchPill(nodes, label), `no "${label}" size pill in the strip`)
  }
  assert.equal(
    nodes.filter(node => node.attributes && /^Watch window size: /.test(node.attributes['aria-label'] || '')).length,
    5,
    'the Size row does not have exactly five pills')
})

record('the watch window default size is Large and an active pill is highlighted', () => {
  const large = watchPill(watchNodes(watchBar()), 'Large')
  assert.ok(large, 'no Large size pill')
  assert.equal(large.style.color, '#ffd9a8', 'the default Large pill is not highlighted')
  assert.equal(large.style.border, '1px solid rgba(255,190,120,0.55)', 'the default pill lacks the amber border')
})

await recordAsync('clicking the Huge size pill stores videoWindowSize huge and highlights it', async () => {
  const nodes = watchNodes(watchBar())
  const huge = watchPill(nodes, 'Huge')
  assert.ok(huge, 'no Huge size pill')
  const clicks = huge.__handlers.click || []
  assert.ok(clicks.length > 0, 'the Huge pill has no click handler')
  clicks[0]({ preventDefault() {} })
  assert.equal(sizeCtx.storage.get('settings').videoWindowSize, 'huge',
    'clicking Huge did not persist videoWindowSize')
  assert.equal(huge.style.color, '#ffd9a8', 'the Huge pill was not highlighted after the click')
  assert.notEqual(watchPill(watchNodes(watchBar()), 'Large').style.color, '#ffd9a8',
    'the old size stayed highlighted')
})

record('VIDEO_WINDOW_DEFAULT_SIZE is large', () => {
  assert.match(source, /const VIDEO_WINDOW_DEFAULT_SIZE = 'large'/)
})

// ------------------------------------------------- pane-only film (regression)
// Grok's review caught the demo-killer: with the defaults (window visual off,
// not on the Aura theme) nothing mounted, so the docked pane showed a stage
// that played nothing. The pane itself must be a reason to mount the film, at
// full opacity — a 20% film inside its own box reads as a stain on camera.

const paneOnly = makeCtx({
  enabled: true,
  backdropMode: 'video',
  windowVisual: false,
  panelEnabled: true,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
})
pluginModule.default.register(paneOnly.ctx)
paneOnly.timers.find(t => t.ms === 250).fn()
await sleep(80)

await recordAsync('the docked pane alone mounts the film in Aura\'s own frame', () => {
  assert.equal(hostIframes().length, 0, 'the pane film was appended to document.body')
  const film = filmNodes(renderContribution(paneOnly.contributions.find(c => c.id === 'panel')))
  assert.equal(film.length, 1, 'nothing mounted with the default settings: the pane would be empty')
  assert.match(film[0].props.src, /\/player\.html/, 'the pane frame is not on the player page')
  const { frame } = mountFilm(film[0])
  assert.ok(frame, 'the pane film did not render a SandboxedFrame')
  // A film in the pane is a window, not a wash: full strength.
  assert.equal(String(frame.style.opacity ?? '1'), '1', 'the pane film follows the see-through setting')
})

// Regression (11-14): in the SDK SandboxedFrame (opaque origin) YouTube showed a
// black frame and sent zero player messages; only `allow-same-origin` makes it
// play. The film frame must keep it, and must refuse a src on the app's origin.
await recordAsync('the pane film keeps allow-same-origin, and only for a cross-origin src', () => {
  const film = filmNodes(renderContribution(paneOnly.contributions.find(c => c.id === 'panel')))
  const element = renderContribution({ render: () => film[0] })
  assert.equal(element && element.type, 'iframe', 'the pane film is not Aura\'s own iframe')
  const tokens = String(element.props.sandbox).split(/\s+/)
  for (const token of ['allow-scripts', 'allow-same-origin']) {
    assert.ok(tokens.includes(token), `film sandbox lacks ${token}: YouTube will not play`)
  }
  const saved = globalThis.location
  try {
    globalThis.location = { origin: new URL(film[0].props.src).origin }
    const sameOrigin = renderContribution({ render: () => film[0] })
    assert.equal(sameOrigin, null, 'a film on the app\'s own origin was framed with allow-same-origin')
  } finally {
    globalThis.location = saved
  }
})

// The panel film fills the stage it is rendered into. A fixed frame with a
// z-index above the pane used to cover the window; scroll no longer has to
// chase it, because the stage is the containing block.
await recordAsync('the panel film is absolute inside the stage, never fixed over the window', () => {
  const tree = renderContribution(paneOnly.contributions.find(c => c.id === 'panel'))
  const film = filmNodes(tree)
  assert.equal(film.length, 1, 'the pane did not render a film')
  assert.equal(film[0].props.key, 'film')
  const element = renderContribution({ render: () => film[0] })
  assert.notEqual(element.props.style.position, 'fixed', 'the panel film is position:fixed over the window')
  assert.equal(element.props.style.position, 'absolute')
  const z = element.props.style.zIndex
  assert.ok(z == null || z === '' || Number(z) <= 1, `panel film z-index ${z} sits above the pane`)
  const inside = (node, inStage) => {
    if (!node || typeof node !== 'object') return false
    if (Array.isArray(node)) return node.some(child => inside(child, inStage))
    if (!node.props) return false
    const here = inStage || String(node.props.className || '').split(/\s+/).includes('ap-stage')
    if (here && node.props.placement === 'panel' && node.props.key === 'film') return true
    return inside(node.props.children, here)
  }
  assert.equal(inside(tree, false), true, 'the panel film is not a descendant of the panel stage')
  assert.equal(tree.props.onScroll, undefined, 'the pane column still measures the film on scroll')
})

// ------------------------------------- surfaces without the Right panel
// The film and the visualiser live in the Right panel, the Aura page, or the
// watch window. With the panel closed they stay in whichever of those is open.
// The full-window visual returns on the SDK backdrop area (#155903).

const frameSrc = node => String(node.src || (node.attributes && node.attributes.src) || '')
const tick = scenario => scenario.timers.filter(t => t.ms === 250).forEach(t => t.fn())

// The plugin keeps ONE frame for the module and re-points it, and earlier
// scenarios may leave theirs mounted, so classify the frames by what they show
// instead of counting new elements.
async function surfaceScenario(settings) {
  const scenario = makeCtx({ windowVisual: false, ...settings })
  const dispose = pluginModule.default.register(scenario.ctx)
  tick(scenario)
  await sleep(80)
  tick(scenario)
  await sleep(40)
  const all = hostIframes()
  const films = all.filter(node => frameSrc(node).includes('/player.html'))
  const visuals = all.filter(node => frameSrc(node) && !frameSrc(node).includes('/player.html'))
  return { scenario, films, visuals, all, dispose }
}

await recordAsync('with the Right panel closed, the visualiser is not painted on the host page', async () => {
  const { visuals, films, all, dispose } = await surfaceScenario({
    enabled: true, backdropMode: 'aura', panelEnabled: false, windowVisual: true
  })
  try {
    assert.equal(all.length, 0, 'a closed panel still painted the host page')
    assert.equal(visuals.length, 0, 'a visualiser iframe was appended to document.body')
    assert.equal(films.length, 0, 'a film player was appended to document.body')
  } finally {
    dispose()
  }
})

await recordAsync('the Right panel alone does not draw the visualiser behind the app', async () => {
  // A film box is no consent to paint the whole window: the visualiser waits for
  // its own opt-in, so it behaves the same with the panel open or closed.
  const { all, dispose } = await surfaceScenario({
    enabled: true, backdropMode: 'aura', panelEnabled: true, windowVisual: false,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
  })
  try {
    assert.equal(all.length, 0, 'the Right panel let the visualiser paint without the opt-in')
  } finally {
    dispose()
  }
})

await recordAsync('with the Right panel closed, a film is not painted behind the app', async () => {
  const { films, visuals, all, dispose } = await surfaceScenario({
    enabled: true, backdropMode: 'video', panelEnabled: false, windowVisual: true,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', videoOpacity: 0.75, videoOpacityAuto: false
  })
  try {
    assert.equal(all.length, 0, 'a closed panel still painted the host page')
    assert.equal(films.length, 0, 'a film iframe was appended to document.body')
    assert.equal(visuals.length, 0, 'a visualiser was appended to document.body')
  } finally {
    dispose()
  }
})

await recordAsync('Aura off draws nothing behind the window, panel or not', async () => {
  const { all, dispose } = await surfaceScenario({ enabled: false, backdropMode: 'aura', panelEnabled: false })
  try {
    assert.equal(all.length, 0, 'an off Aura still painted behind the app')
  } finally {
    dispose()
  }
})

await recordAsync('the host-page visual switch is not on the settings page', async () => {
  const scenario = makeCtx({ enabled: true, backdropMode: 'video', panelEnabled: false,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' })
  const dispose = pluginModule.default.register(scenario.ctx)
  try {
    await sleep(40)
    const page = scenario.contributions.find(c => c.area === 'settings.plugins')
    assert.ok(page, 'no settings page')
    assert.equal(findSwitch(renderContribution(page), 'Visual behind the app'), null,
      'video mode still offers the host-page visual')
  } finally {
    dispose()
  }
})

await recordAsync('Aura adds no blur of its own over the host page', async () => {
  const { films, all, dispose } = await surfaceScenario({
    enabled: true, backdropMode: 'video', panelEnabled: false, windowVisual: true,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
  })
  try {
    assert.equal(all.length, 0, 'a film was painted on the host page')
    assert.equal(films.length, 0, 'a film iframe was appended to document.body')
    const glass = glassStyles()
    assert.equal(glass.length, 0, 'Aura injected a glass stylesheet')
  } finally {
    dispose()
  }
})

await recordAsync('the Aura menu opens clear of the Right panel so both can be used at once', async () => {
  // The menu pops up from the right end of the status bar, where the Right panel
  // is docked: with the panel open it keeps the panel's width clear on the right.
  const paddingFor = async panelEnabled => {
    const scenario = makeCtx({ enabled: true, backdropMode: 'video', panelEnabled,
      videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' })
    const dispose = pluginModule.default.register(scenario.ctx)
    try {
      await sleep(20)
      const tree = renderContribution(scenario.contributions.find(c => c.id === 'quick-menu'))
      let content = null
      walk(tree, node => {
        if (!content && node.props && node.props['aria-label'] === 'Aura quick settings' && node.type === sdk.PopoverContent) content = node
      })
      assert.ok(content, 'no menu content')
      return content.props.collisionPadding
    } finally {
      dispose()
    }
  }
  const withPanel = await paddingFor(true)
  assert.ok(withPanel && Number(withPanel.right) >= 300,
    `with the Right panel open the menu does not keep clear of it (collisionPadding ${JSON.stringify(withPanel)})`)
  const withoutPanel = await paddingFor(false)
  assert.ok(!withoutPanel || !(Number(withoutPanel.right) >= 300),
    'with the Right panel closed the menu still keeps a panel-wide gap')
})

await recordAsync('the quick menu offers Watch in, and no host-page strength control', async () => {
  const menuFor = async filmBehind => {
    const scenario = makeCtx({ enabled: true, backdropMode: 'video', panelEnabled: true, filmBehind,
      videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' })
    const dispose = pluginModule.default.register(scenario.ctx)
    await sleep(20)
    const tree = renderContribution(scenario.contributions.find(c => c.id === 'quick-menu'))
    return { tree, dispose }
  }
  const inPanel = await menuFor(false)
  try {
    assert.equal(findByAria(inPanel.tree, 'Watch the film behind the chat (quick menu)'), null, 'Behind chat is still a choice')
    assert.ok(findByAria(inPanel.tree, 'Watch the film in the Right panel (quick menu)'), 'the quick menu has no Panel choice')
    assert.equal(findByAria(inPanel.tree, '50% video strength'), null, 'Film strength is still in the quick menu')
  } finally {
    inPanel.dispose()
  }
  const behind = await menuFor(true)
  try {
    assert.equal(findByAria(behind.tree, '50% video strength'), null, 'Film strength came back for an old Behind chat setting')
    assert.ok(findByAria(behind.tree, 'Watch the film in the Right panel (quick menu)'), 'the panel choice disappeared')
  } finally {
    behind.dispose()
  }
})

await recordAsync('Panel fronts the Right panel even when it is already on (a Hermes layout pick hides it)', async () => {
  // Picking any Hermes layout leaves a plugin pane the preset does not name as
  // a tab behind the sessions list. Choosing Panel must bring it back.
  const scenario = makeCtx({ enabled: true, backdropMode: 'video', panelEnabled: true, filmBehind: true,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' })
  const dispose = pluginModule.default.register(scenario.ctx)
  try {
    await sleep(20)
    const before = sdk.calls.revealed.length
    const tree = renderContribution(scenario.contributions.find(c => c.id === 'quick-menu'))
    findByAria(tree, 'Watch the film in the Right panel (quick menu)').props.onClick()
    await sleep(20)
    assert.equal(sdk.calls.revealed.length, before + 1, 'Panel did not reveal the already-registered Right panel')
    assert.equal(sdk.calls.revealed.at(-1), 'aura:panel', 'Panel revealed the wrong pane id')
    assert.equal(scenario.contributions.filter(c => c.area === 'panes').length, 1, 'Panel registered a second pane')
  } finally {
    dispose()
  }
})

await recordAsync('the quick menu: Window carries its sizes; no duplicate frame or pop-out controls', async () => {
  // "Small frame in Hermes" was the Window choice of Watch in under another
  // name, and "Open on a screen" was Desktop: one control each, sizes beside Window.
  const scenario = makeCtx({ enabled: true, backdropMode: 'video', videoWindow: true,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' })
  const dispose = pluginModule.default.register(scenario.ctx)
  try {
    await sleep(20)
    const tree = renderContribution(scenario.contributions.find(c => c.id === 'quick-menu'))
    assert.equal(findByAria(tree, 'Small frame in Hermes'), null, 'the menu still has the duplicate "Small frame in Hermes" switch')
    for (const label of ['Small', 'Medium', 'Large', 'X-Large', 'Huge']) {
      assert.ok(findByAria(tree, `Watch window size: ${label}`), `no "${label}" watch window size in the menu`)
    }
    assert.equal(findByText(tree, 'Open on a screen'), null, 'the menu still has the duplicate desktop pop-out button')
    assert.equal(findByText(tree, 'Hidden episodes'), null, 'Hidden episodes shows for a single film')
  } finally {
    dispose()
  }
})

await recordAsync('the film controls in the quick menu are named for what they do', async () => {
  const scenario = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' })
  const dispose = pluginModule.default.register(scenario.ctx)
  try {
    await sleep(20)
    const tree = renderContribution(scenario.contributions.find(c => c.id === 'quick-menu'))
    assert.equal(findByAria(tree, '25% video strength'), null, 'film strength presets are still in the menu')
    assert.equal(findByAria(tree, '25% video transparency'), null, 'a film preset is still labelled as transparency')
    assert.equal(findByAria(tree, 'Controls under the watch window'), null,
      'the quick menu still offers to hide the watch window strip')
  } finally {
    dispose()
  }
})

await recordAsync('no glass while the film is framed in the Right panel, even with Visual behind the app on', async () => {
  // Glass clears the app's own surfaces so a full-window picture shows through.
  // With the film in the panel nothing is behind the app, so cleared surfaces
  // only exposed the window's backing: on Windows the whole app washed out.
  const { films, dispose } = await surfaceScenario({
    enabled: true, backdropMode: 'video', panelEnabled: true, windowVisual: true,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
  })
  try {
    assert.equal(films.length, 0, 'the pane film was appended to document.body')
    assert.equal(glassStyles().length, 0, 'the app surfaces were cleared with nothing behind them')
  } finally {
    dispose()
  }
})

await recordAsync('a film in the Right panel is always full strength', async () => {
  // See-through is for the film behind the app. Inside its own box a 75% film is
  // a dim player, and the 250 ms tick used to pull it back to 75% after mount set
  // it to 100%, so the picture visibly pulsed.
  const { scenario, films, dispose } = await surfaceScenario({
    enabled: true, backdropMode: 'video', panelEnabled: true,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', videoOpacity: 0.75, videoOpacityAuto: false
  })
  try {
    assert.equal(films.length, 0, 'the pane film was appended to document.body')
    const film = filmNodes(renderContribution(scenario.contributions.find(c => c.id === 'panel')))
    assert.equal(film.length, 1, 'the pane film did not mount')
    const { frame } = mountFilm(film[0])
    assert.equal(String(frame.style.opacity ?? '1'), '1', 'the pane film follows the see-through setting')
  } finally {
    dispose()
  }
})

// ------------------------------------------------------------ left panel
const panelCtx = makeCtx({
  enabled: true,
  backdropMode: 'video',
  windowVisual: true,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
})
pluginModule.default.register(panelCtx.ctx)
panelCtx.timers.find(t => t.ms === 250).fn()
await sleep(80)

const findById = id => bodyChildren.find(node => node.attributes && node.attributes.id === id)
const findByLabel = (root, label) => {
  let found = null
  const walkNodes = node => {
    if (!node || found) return
    if (node.attributes && node.attributes['aria-label'] === label) { found = node; return }
    for (const child of node.children || []) walkNodes(child)
  }
  walkNodes(root)
  return found
}

await recordAsync('the floating panel stays off while it awaits its docked replacement', async () => {
  // It covered the composer and swallowed clicks in the app; until the docked
  // pane lands it must not mount at all, whatever the stored settings say.
  assert.ok(!findById('aura-panel'), 'the floating panel mounted again')
  assert.equal(panelStyles().length, 0, 'panel stylesheet mounted with no panel')
  assert.equal(document.body.classList.contains('aura-panel-open'), false, 'body padding came back')
  assert.equal(hostIframes().length >= 0, true)
})

record('the video-mode quick menu labels the pane the Right panel', () => {
  const menu = panelCtx.contributions.find(c => c.id === 'quick-menu')
  assert.ok(menu, 'the panel scenario has no quick menu')
  const tree = renderContribution(menu)
  assert.ok(texts(tree).includes('Right panel'), 'the quick menu does not say "Right panel"')
  assert.equal(texts(tree).includes('Left panel'), false, 'the quick menu still says "Left panel"')
  assert.ok(findByAria(tree, 'Right panel (quick menu)'), 'the quick menu has no Right panel switch')
})

await recordAsync('the quick menu offers the Right panel in both modes, and no host-page visual', async () => {
  for (const backdropMode of ['aura', 'video']) {
    const scenario = makeCtx({ enabled: true, backdropMode, panelEnabled: true,
      videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' })
    const dispose = pluginModule.default.register(scenario.ctx)
    try {
      await sleep(20)
      const menu = scenario.contributions.find(c => c.id === 'quick-menu')
      assert.ok(menu, `no quick menu in ${backdropMode} mode`)
      const tree = renderContribution(menu)
      assert.ok(findByAria(tree, 'Right panel (quick menu)'), `${backdropMode} mode: the quick menu has no Right panel switch`)
      assert.equal(findByAria(tree, 'Visual behind the app (quick menu)'), null,
        `${backdropMode} mode: the host-page visual switch is still in the menu`)
    } finally {
      dispose()
    }
  }
})

// Every row in the quick menu carries a short plain-English hint in its title,
// so hovering anywhere on the row explains what the option does.
const titledRow = (tree, label) => {
  let found = null
  walk(tree, node => {
    if (found || !node.props) return
    if (typeof node.props.title !== 'string' || !node.props.title) return
    if (texts(node).includes(label)) found = node
  })
  return found
}

record('the quick menu rows carry short plain-English hints', () => {
  const scenario = makeCtx({ enabled: true, backdropMode: 'aura', panelEnabled: false })
  const dispose = pluginModule.default.register(scenario.ctx)
  try {
    const tree = renderContribution(scenario.contributions.find(c => c.id === 'quick-menu'))
    for (const label of ['Right panel', 'Reacts to', 'Intensity',
      'Visual strength', 'Style', 'Gentle motion', 'Show']) {
      const rowNode = titledRow(tree, label)
      assert.ok(rowNode, `the ${label} row has no hint`)
      assert.ok(rowNode.props.title.length <= 110,
        `the ${label} hint is longer than 110 characters (${rowNode.props.title.length})`)
    }
    assert.equal(titledRow(tree, 'Frosted glass'), null, 'Frosted glass is still a quick-menu row')
    assert.equal(titledRow(tree, 'Visual behind the app'), null, 'Visual behind the app is still a quick-menu row')
  } finally {
    dispose()
  }
})

// ------------------------------------------------------------- scenario P
// The Aura page (owner ask: an "Aura" row in the left sidebar opening a full
// page). The page must show the film in a big frame, the whole setup and the
// REVamp hand-off — and it must NOT create a second player: the one backdrop
// iframe is re-laid-out over the page's stage instead.

sdk.themeState.name = 'nous'
const p = makeCtx({
  enabled: true,
  backdropMode: 'video',
  windowVisual: false,
  panelEnabled: false,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
})
const disposeP = pluginModule.default.register(p.ctx)
await sleep(60)

// The page nests components (AuraSettings, VersionChip, RevampCard); the SDK
// stubs must stay as descriptors so their aria-labels can still be found.
const SDK_COMPONENTS = new Set([
  sdk.Button, sdk.Switch, sdk.StatusDot, sdk.Popover, sdk.PopoverTrigger, sdk.PopoverContent
])
const renderDeep = node => {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(renderDeep)
  if (typeof node !== 'object' || !('type' in node) || !('props' in node)) return node
  // AuraFilm carries the surface placement the tests need to see; leave it as a
  // descriptor and render it explicitly with mountFilm().
  if (typeof node.type === 'function' && node.type.name !== 'AuraFilm' && !SDK_COMPONENTS.has(node.type)) {
    return renderDeep(node.type(node.props))
  }
  return { ...node, props: { ...node.props, children: renderDeep(node.props.children) } }
}
const pageTree = () => {
  const route = p.contributions.find(c => c.area === 'routes')
  assert.ok(route, 'the Aura page route vanished')
  return renderDeep(renderContribution(route))
}
const pageAria = (tree, label) => {
  let found = null
  walk(tree, node => {
    if (!found && node.props && node.props['aria-label'] === label) found = node
  })
  return found
}

record('the page renders the player, the setup and the REVamp card', () => {
  const tree = pageTree()
  const body = texts(tree)
  for (const label of [
    'Play',
    'Back 10 seconds',
    'Forward 10 seconds',
    'Previous (episode in a playlist, else previous source)',
    'Next (episode in a playlist, else next source)',
    'Seek',
    'Film volume',
    'Film URL',
    'Pop out'
  ]) {
    assert.ok(pageAria(tree, label), `the page is missing "${label}"`)
  }
  assert.ok(pageAria(tree, 'Aura enabled'), 'the page does not render AuraSettings')
  // This page is Video mode: the visualiser-only rows are hidden by the owner's
  // rule. "Visual behind the app" is not one of them: it is what lets the film
  // fill the window with the Right panel closed, so video mode shows it too.
  assert.equal(pageAria(tree, 'Behaviour profile'), null,
    'a visualiser-only row leaked onto the film page')
  assert.equal(pageAria(tree, 'Visual behind the app'), null,
    'the film page still offers the host-page visual')
  assert.match(body, /Aura setup/, 'the page has no setup section')
  assert.match(body, /Big Buck Bunny/, 'the page does not offer the starter sources')
  assert.match(body, /listed in the Hermes plugin catalog/, 'the REVamp card does not name the plugin catalog')
  assert.match(body, /Hermes Radio/, 'the REVamp card does not mention Hermes Radio')
  const link = pageAria(tree, 'REVamp marketplace page')
  assert.ok(link, 'the REVamp marketplace link is missing')
  assert.equal(link.type, 'a', 'the marketplace page must be a link')
  assert.equal(link.props.href, 'https://hermes-agent.nousresearch.com/marketplace')
  // The settings page carries the one-line version too.
  const settingsTree = renderDeep(renderContribution(p.contributions.find(c => c.area === 'settings.plugins')))
  assert.match(texts(settingsTree), /Winamp-style player for Hermes/, 'AuraSettings has no REVamp line')
  const line = pageAria(settingsTree, 'Find REVamp in Plugins (settings)')
  assert.ok(line, 'the settings REVamp line has no Find in Plugins action')
  assert.equal(pageAria(settingsTree, 'Open REVamp'), null, 'Open REVamp leads to a dead page when REVamp is not installed')
})

record('the REVamp card names the catalog and Hermes Radio, and finds REVamp in Plugins', () => {
  const tree = pageTree()
  const body = texts(tree)
  assert.match(body, /listed in the Hermes plugin catalog/, 'the card does not say REVamp is in the plugin catalog')
  assert.match(body, /Hermes Radio/, 'the card does not mention Hermes Radio')
  const button = pageAria(tree, 'Find REVamp in Plugins')
  assert.ok(button, 'no Find in Plugins button on the card')
  const before = sdk.calls.navigations.length
  button.props.onClick()
  assert.equal(sdk.calls.navigations.at(-1), '/capabilities?tab=plugins&plugin=revamp')
  assert.ok(sdk.calls.navigations.length > before, 'Find in Plugins did not call host.navigate')
})

record('REVAMP_URL is the marketplace root', () => {
  assert.match(source, /const REVAMP_URL = 'https:\/\/hermes-agent\.nousresearch\.com\/marketplace'/)
  const link = pageAria(pageTree(), 'REVamp marketplace page')
  assert.ok(link, 'the REVamp marketplace link is missing')
  assert.equal(link.props.href, 'https://hermes-agent.nousresearch.com/marketplace')
})

record('Find in Plugins opens Plugins via findRevampInPlugins', () => {
  assert.match(source, /function findRevampInPlugins\s*\(/, 'findRevampInPlugins is missing')
  assert.match(source, /onClick:\s*findRevampInPlugins\b/, 'the button does not call findRevampInPlugins')
})

// Regression (owner, 11-15): in the narrow Right panel the settings squeezed each
// hint into a one-word column beside a wide control. Rows now wrap the control
// below a readable label, and the list is grouped under headings.
record('settings rows wrap their control instead of squeezing the text, and are grouped', () => {
  const settings = paneOnly.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  const rendered = typeof tree.type === 'function' ? tree.type(tree.props) : tree
  let wrapRows = 0
  let squeezed = 0
  walk(rendered, node => {
    const st = node && node.props && node.props.style
    if (!st || st.display !== 'flex' || !Array.isArray(node.props.children)) return
    const [label, control] = node.props.children
    if (!label || !control || !label.props || !control.props || label.props.key !== 'label' || control.props.key !== 'control') return
    if (st.flexWrap === 'wrap' && /200px/.test(String(label.props.style.flex))) wrapRows += 1
    else squeezed += 1
  })
  assert.ok(wrapRows >= 5, `only ${wrapRows} settings rows wrap`)
  assert.equal(squeezed, 0, `${squeezed} settings rows still squeeze their text beside the control`)
  const text = texts(rendered)
  for (const group of ['General', 'Window']) assert.ok(text.includes(group), `no ${group} heading in the settings`)
})

// Regression (pre-pin review 11-15): Aura stays out of the host's markup. The only
// document-level DOM work left is the disclosed full-window backdrop iframe.
record('no document-wide DOM lookups, and only the backdrop is appended to body', () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\b(doc|document)\.querySelector(All)?\(/, 'a document-wide querySelector came back')
  assert.doesNotMatch(code, /data-catalog-actions|main input/, 'Aura reaches into the host catalog markup again')
  const appends = code.match(/\b(doc|document)\.body\.(append|appendChild|prepend|insertBefore)\([^)]*\)/g) || []
  assert.deepEqual(appends, [], `unexpected body appends: ${appends}`)
  assert.doesNotMatch(code, /createElement\('textarea'\)/, 'a hidden textarea copy came back')
})

record('REVAMP_ICON is an inline SVG data URL', () => {
  assert.match(source, /const REVAMP_ICON = 'data:image\/svg\+xml;base64,/)
})

record('the REVamp card renders the icon and its chips', () => {
  const tree = pageTree()
  let logo = null
  walk(tree, node => {
    if (!logo && node.type === 'img' && node.props && node.props.alt === 'REVamp') logo = node
  })
  assert.ok(logo, 'the REVamp card has no img alt="REVamp"')
  assert.match(String(logo.props.src), /^data:image\/svg\+xml;base64,/)
  const body = texts(tree)
  for (const chip of ['Windows · macOS · Linux', 'Classic skins', 'Agent DJ']) {
    assert.ok(body.includes(chip), `the REVamp card is missing the chip "${chip}"`)
  }
})

// Owner (11-15): no "Open REVamp" (a dead /revamp page when it is not installed;
// Hermes gives plugins no way to check). Find in Plugins lets Hermes show
// Install or Open.
record('the REVamp card offers Find in Plugins, never a blind Open REVamp', () => {
  assert.equal(pageAria(pageTree(), 'Open REVamp'), null, 'Open REVamp is back')
  const button = pageAria(pageTree(), 'Find REVamp in Plugins')
  assert.ok(button, 'no Find in Plugins button on the page')
  const before = sdk.calls.navigations.length
  button.props.onClick()
  assert.equal(sdk.calls.navigations.at(-1), '/capabilities?tab=plugins&plugin=revamp', 'Find in Plugins did not open Plugins at REVamp')
  assert.ok(sdk.calls.navigations.length > before)
})

const versionChipNodes = tree => {
  const found = []
  walk(tree, node => {
    if (
      node.type === 'button' &&
      node.props &&
      typeof node.props.title === 'string' &&
      node.props.title.includes('click to copy this line')
    ) found.push(node)
  })
  return found
}

record('the page hero carries Aura on/Aura off, not the pressPower chip', () => {
  const tree = pageTree()
  const group = pageAria(tree, 'Aura power')
  assert.ok(group, 'the page hero has no Aura power group')
  assert.equal(group.props.role, 'group', 'the power switch is not a group')
  const buttons = []
  walk(group, node => {
    if (
      node.type === 'button' &&
      node.props &&
      (node.props.children === 'Aura on' || node.props.children === 'Aura off')
    ) buttons.push(node)
  })
  assert.equal(buttons.length, 2, 'the page hero does not have both Aura on and Aura off')
  const on = buttons.find(button => button.props.children === 'Aura on')
  const off = buttons.find(button => button.props.children === 'Aura off')
  assert.equal(on.props.title, 'Turn Aura on')
  assert.equal(off.props.title, 'Turn Aura off: the film and visual stop')
  // This page starts on, so the on button is highlighted and pressed.
  assert.equal(on.props.className, 'aura-pill is-on')
  assert.equal(on.props['aria-pressed'], true)
  assert.equal(off.props.className, 'aura-pill')
  assert.equal(off.props['aria-pressed'], false)
  assert.doesNotMatch(texts(tree), /Turn off\?/, 'the page still shows the old pressPower label')
})

record('AuraSettings drops the duplicate version chip on the page, keeps it in Settings', () => {
  const tree = pageTree()
  let setup = null
  walk(tree, node => {
    if (!setup && node.props && node.props['aria-label'] === 'Aura setup') setup = node
  })
  assert.ok(setup, 'the page has no setup section')
  assert.equal(versionChipNodes(setup).length, 0, 'the setup section repeats the hero version chip')
  assert.equal(versionChipNodes(tree).length, 1, 'the page should show exactly one version chip (the hero)')
  const settingsTree = renderDeep(renderContribution(p.contributions.find(c => c.area === 'settings.plugins')))
  assert.ok(versionChipNodes(settingsTree).length >= 1, 'Settings lost its version chip')
})

await recordAsync('the page stage takes the one player as a SandboxedFrame, and gives it back on leave', async () => {
  const before = hostIframes().length
  let tree = pageTree()
  let stageRef = null
  walk(tree, node => {
    if (!stageRef && node.props && typeof node.props.ref === 'function') stageRef = node.props.ref
  })
  assert.equal(typeof stageRef, 'function', 'the page has no stage ref')
  const stageNode = { getBoundingClientRect: () => ({ left: 40, top: 60, width: 800, height: 450 }) }
  stageRef(stageNode)
  tree = pageTree()
  let film = filmNodes(tree)
  assert.equal(film.length, 1, 'the film did not move into the page stage')
  assert.equal(film[0].props.placement, 'page', 'the film is not framed by the page')
  assert.match(film[0].props.src, /\/player\.html/, 'the page frame is not on the player page')
  const { frame } = mountFilm(film[0])
  assert.ok(frame, 'the page film did not render a SandboxedFrame')
  assert.equal(frame.style.width, '100%', 'the page frame does not fill its stage')
  assert.equal(hostIframes().length, 0, 'the page put a second raw iframe on document.body')
  assert.ok(hostIframes().length <= before, 'the page created a body player')
  // Pop out on the page pops the film out now (owner ask), Bring back returns it.
  const pop = pageAria(pageTree(), 'Pop out')
  assert.ok(pop, 'the page has no Pop out button')
  pop.props.onClick()
  assert.equal(filmNodes(pageTree()).length, 0, 'Pop out left the film on the page')
  const back = pageAria(pageTree(), 'Bring back')
  assert.ok(back, 'a popped-out film offers no Bring back')
  back.props.onClick()
  assert.equal(filmNodes(pageTree()).length, 1, 'Bring back did not return the film to the page')
  stageRef(null)
  assert.equal(filmNodes(pageTree()).length, 0, 'the film stayed glued to a page that is no longer open')
})

record('the page transport is centred with a large primary control', () => {
  const tree = pageTree()
  let row = null
  walk(tree, node => {
    if (!row && node.props && node.props.className === 'aura-transport') row = node
  })
  assert.ok(row, 'the page has no transport row')
  assert.equal(row.props.style.justifyContent, 'center', 'the transport row is not centred')
  const primary = pageAria(tree, 'Play') || pageAria(tree, 'Pause')
  assert.ok(primary, 'the page has no play/pause button')
  const size = parseInt(primary.props.style.width ?? primary.props.style.minWidth, 10)
  assert.ok(size >= 56, `the primary transport button is too small (${size}px)`)
})

record('dispose removes the page contributions and leaves no player behind', () => {
  disposeP()
  assert.equal(p.contributions.length, 0, 'the page route or sidebar row survived dispose')
  assert.ok(p.timers.filter(t => t.kind === 'interval').every(t => t.cleared), 'a timer survived dispose')
  assert.ok(p.listeners.every(t => t.removed), 'a listener survived dispose')
  assert.equal(
    hostIframes().some(frame => frame.style.width === '800px'),
    false,
    'the film pointed at a disposed page'
  )
})

// ------------------------------------------------------------- scenario Q
// Aura off must mean nothing draws, page open or not.

const q = makeCtx({
  enabled: false,
  backdropMode: 'video',
  windowVisual: true,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
})
const disposeQ = pluginModule.default.register(q.ctx)
await sleep(60)

record('an open page with Aura off plays nothing and draws no glass', () => {
  // Owner's rule (2026-11-13): off is off — no video and no visual on any
  // surface, the page included. (It used to keep playing, so "off" looked dead.)
  const tree = renderDeep(renderContribution(q.contributions.find(c => c.area === 'routes')))
  let stageRef = null
  walk(tree, node => {
    if (!stageRef && node.props && typeof node.props.ref === 'function') stageRef = node.props.ref
  })
  assert.equal(typeof stageRef, 'function', 'the page has no stage ref')
  const before = hostIframes().length
  stageRef({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 450 }) })
  assert.equal(hostIframes().length, before, 'Aura is off but the page still mounted a film')
  const glass = headChildren.find(node => node.attributes && node.attributes.id === 'aura-glass')
  assert.equal(glass, undefined, 'the overlay glass was applied while Aura is off')
  stageRef(null)
  disposeQ()
  assert.equal(q.contributions.length, 0)
})

// ------------------------------------------------------------- scenario R
// Picking a source on the page is a play: it turns the video mode on instead of
// making the user hunt for the switch.

const r = makeCtx({ enabled: true, backdropMode: 'aura', videoUrl: '' })
const disposeR = pluginModule.default.register(r.ctx)
await sleep(60)

await recordAsync('a source picked on the page switches to video mode and plays', async () => {
  const tree = renderDeep(renderContribution(r.contributions.find(c => c.area === 'routes')))
  const card = pageAria(tree, 'Play Sintel · Blender film')
  assert.ok(card, 'the page does not offer the starter sources')
  card.props.onClick()
  await sleep(60)
  const saved = r.storage.get('settings')
  assert.equal(saved.backdropMode, 'video', 'the page did not turn the video mode on')
  assert.equal(saved.videoUrl, 'https://www.youtube.com/watch?v=eRsGyueVLvQ', 'the chosen source was not applied')
  assert.ok(
    r.controls.some(patch => patch && patch.backdrop_mode === 'video'),
    'the mode change never reached /control'
  )
  disposeR()
  assert.equal(r.contributions.length, 0)
})

// ------------------------------------------------------------- scenario S
// Video mode locks the Aura-visual controls (owner ask 1 and 3) and greys Show
// out (ask 2), in the quick menu and in Settings. Stored values are untouched.

const s = makeCtx({
  enabled: true,
  backdropMode: 'video',
  showWhen: 'active',
  behavior: 'balanced',
  intensity: 0.5,
  opacity: 0.4,
  reducedMotion: false,
  panelEnabled: true,
  windowVisual: true,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
})
const disposeS = pluginModule.default.register(s.ctx)
await sleep(60)

const sMenu = () => renderContribution(s.contributions.find(c => c.id === 'quick-menu'))
const sSettings = () => renderDeep(renderContribution(s.contributions.find(c => c.area === 'settings.plugins')))

record('video mode hides the Aura-visual rows instead of greying them (quick menu)', () => {
  const tree = sMenu()
  // Owner's rule: with Video on, everything that only affects the visualiser is
  // gone; with Visualizer on, everything that only affects the film is gone.
  for (const label of ['Reacts to', 'Style', 'Intensity', 'Visual strength', 'Gentle motion (motion-sensitive)', 'Show']) {
    assert.equal(findByAria(tree, label), null, `${label} is still rendered in video mode`)
  }
  assert.equal(findByAria(tree, '50% video strength'), null, 'film strength presets are still in the video menu')
  assert.ok(findByAria(tree, 'Video volume'), 'the volume slider vanished')
  assert.equal(s.storage.get('settings').showWhen, 'active', 'showWhen was rewritten by hiding')
})

record('Settings hides the Aura-visual rows in video mode and offers the same switch', () => {
  const tree = sSettings()
  for (const label of ['Behaviour profile', 'Reaction strength', 'Visual opacity', 'Gentle motion (motion-sensitive)', 'Show']) {
    assert.equal(findByAria(tree, label), null, `Settings still renders ${label} in video mode`)
  }
  assert.ok(findByAria(tree, 'Aura mode'), 'Settings has no mode switch')
  assert.equal(findByAria(tree, '25% video strength'), null, 'film strength is still in Settings')
  assert.equal(s.storage.get('settings').showWhen, 'active', 'Settings rewrote showWhen')
})

await recordAsync('a playing film is never faded out by "Only while active"', async () => {
  s.serverFrame.mood = 'idle'
  s.serverFrame.silence = true
  s.serverFrame.level = 0
  s.timers.find(t => t.ms === 250).fn()
  await sleep(40)
  const film = filmNodes(renderContribution(s.contributions.find(c => c.id === 'panel')))
  assert.equal(film.length, 1, 'the playing film was not mounted, so the fade could not be observed')
  const { frame } = mountFilm(film[0])
  assert.ok(frame, 'the film frame did not mount')
  s.timers.find(t => t.ms === 250).fn()
  await sleep(20)
  assert.equal(String(frame.style.opacity ?? '1'), '1', 'Only while active faded a playing film')
  assert.equal(
    s.timers.some(t => t.kind === 'timeout' && t.ms === 2500 && !t.cleared),
    false,
    'a fade-out timer was scheduled for a playing film'
  )
  assert.equal(hostIframes().length, 0, 'the film was appended to the host page')
  assert.equal(s.storage.get('settings').showWhen, 'active', 'the stored Show value changed')
})

record('dispose from the video-lock scenario is clean', () => {
  disposeS()
  assert.equal(s.contributions.length, 0)
  assert.equal(hostIframes().length, 0)
})

// ------------------------------------------------------------- scenario T
// The source picker lists every group behind <optgroup>, and "Edit sources…"
// goes to the page.

const t = makeCtx({
  enabled: true,
  backdropMode: 'video',
  panelEnabled: false,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  videoPlaylists: [{ label: 'Lectures', url: 'https://www.youtube.com/playlist?list=PLabcdefghij' }],
  videoSources: [{ label: 'My own film', url: 'https://example.com/film.mp4' }],
  videoRecent: [{ label: 'Last night', url: 'https://example.com/recent.mp4' }]
})
const disposeT = pluginModule.default.register(t.ctx)
await sleep(60)

const optgroupsOf = select => {
  const groups = []
  walk(select, node => {
    if (node.type === 'optgroup') {
      const options = []
      walk(node, child => {
        if (child.type === 'option') options.push(child.props.value)
      })
      groups.push({ label: node.props.label, options })
    }
  })
  return groups
}

record('the quick-menu source picker groups every source', () => {
  const select = findByAria(renderContribution(t.contributions.find(c => c.id === 'quick-menu')), 'Video source')
  assert.ok(select, 'the quick menu has no video source picker')
  const groups = optgroupsOf(select)
  assert.deepEqual(groups.map(group => group.label), ['Playlists', 'Your films', 'Picks', 'Recent'],
    'the source groups drifted or lost their order')
  assert.ok(groups[0].options.includes('https://www.youtube.com/playlist?list=PLabcdefghij'), 'the saved playlist is missing')
  assert.ok(groups[1].options.includes('https://example.com/film.mp4'), 'the saved film is missing')
  assert.ok(groups[2].options.includes('https://www.youtube.com/watch?v=Qdo3pGnNZl4'), 'the starters are missing')
  assert.ok(groups[3].options.includes('https://example.com/recent.mp4'), 'recents are missing')
})

record('the Settings source picker groups the same sources', () => {
  const select = findByAria(
    renderDeep(renderContribution(t.contributions.find(c => c.area === 'settings.plugins'))),
    'Video source'
  )
  assert.ok(select, 'Settings has no video source picker')
  assert.deepEqual(optgroupsOf(select).map(group => group.label), ['Playlists', 'Your films', 'Picks', 'Recent'])
})

record('"Edit sources…" opens the Aura page from both menus', () => {
  const before = sdk.calls.navigations.length
  const menuLink = (() => {
    let found = null
    walk(renderContribution(t.contributions.find(c => c.id === 'quick-menu')), node => {
      if (!found && node.props && node.props['aria-label'] === 'Edit sources') found = node
    })
    return found
  })()
  assert.ok(menuLink, 'the quick menu has no Edit sources link')
  menuLink.props.onClick()
  assert.equal(sdk.calls.navigations.at(-1), '/aura', 'the quick-menu link did not open /aura')
  const settingsLink = findByAria(
    renderDeep(renderContribution(t.contributions.find(c => c.area === 'settings.plugins'))),
    'Edit sources (settings)'
  )
  assert.ok(settingsLink, 'Settings has no Edit sources link')
  settingsLink.props.onClick()
  assert.equal(sdk.calls.navigations.at(-1), '/aura', 'the Settings link did not open /aura')
  assert.equal(sdk.calls.navigations.length, before + 2)
  disposeT()
})

// ------------------------------------------------------------- scenario U
// The Aura page's Library: add, rename, remove, hide starters, clear recents.

const u = makeCtx({
  enabled: true,
  backdropMode: 'aura',
  videoUrl: '',
  videoRecent: [{ label: 'Newsreel', url: 'https://example.com/news.mp4' }]
})
const disposeU = pluginModule.default.register(u.ctx)
await sleep(60)

const uPage = () => renderDeep(renderContribution(u.contributions.find(c => c.area === 'routes')))
const uAria = label => findByAria(uPage(), label)
const uSaved = () => u.storage.get('settings', {})

record('the Aura page is the styled library, with the playlist help', () => {
  const tree = uPage()
  let root = null
  walk(tree, node => {
    if (!root && node.props && node.props.id === 'aura-page') root = node
  })
  assert.ok(root, 'the page root is not #aura-page')
  const body = texts(tree)
  assert.match(body, /How to add a YouTube playlist/, 'the playlist help is missing')
  assert.match(body, /youtube\.com\/playlist\?list=PL/, 'the help does not show the link shape')
  assert.match(body, /Public and unlisted playlists play here/, 'the help does not say private ones fail')
  assert.ok(uAria('Add a source'), 'the add-source form is missing')
  assert.ok(uAria('Hide starter films'), 'the hide-starters control is missing')
  // Poster cards use YouTube artwork.
  let thumb = null
  walk(tree, node => {
    if (!thumb && node.props && node.props.style && typeof node.props.style.backgroundImage === 'string' &&
      node.props.style.backgroundImage.includes('i.ytimg.com/vi/')) thumb = node
  })
  assert.ok(thumb, 'no poster card carries a YouTube thumbnail')
})

await recordAsync('a playlist added on the page lands in videoPlaylists', async () => {
  const url = 'https://www.youtube.com/playlist?list=PLnewplaylist123'
  uAria('New source URL').props.onChange({ target: { value: url } })
  uAria('New source name').props.onChange({ target: { value: 'Lectures' } })
  uAria('Add source').props.onClick()
  await sleep(30)
  const saved = uSaved()
  assert.equal(saved.videoPlaylists[0].url, url, 'the playlist was not saved')
  assert.equal(saved.videoPlaylists[0].label, 'Lectures', 'the playlist name was not kept')
  assert.ok(saved.videoRecent.some(item => item.url === url), 'the new playlist is missing from recents')
  assert.equal((saved.videoSources || []).some(item => item.url === url), false,
    'a playlist was saved as a film')
})

await recordAsync('a direct film added on the page lands in videoSources', async () => {
  const url = 'https://example.com/movie.mp4'
  uAria('New source URL').props.onChange({ target: { value: url } })
  uAria('New source name').props.onChange({ target: { value: 'Own cut' } })
  uAria('Add source').props.onClick()
  await sleep(30)
  const saved = uSaved()
  assert.equal(saved.videoSources[0].url, url, 'the film was not saved')
  assert.equal(saved.videoSources[0].label, 'Own cut', 'the film name was not kept')
  assert.equal(saved.videoPlaylists.some(item => item.url === url), false, 'a film was saved as a playlist')
})

await recordAsync('a saved source can be renamed and removed', async () => {
  const rename = uAria('Rename Lectures')
  assert.ok(rename, 'the playlist card has no rename field')
  rename.props.onBlur({ target: { value: 'Course' } })
  await sleep(30)
  assert.equal(uSaved().videoPlaylists[0].label, 'Course', 'rename did not persist')
  assert.ok(uSaved().videoRecent.some(item => item.label === 'Course'),
    'rename did not reach recents')
  const remove = uAria('Remove Course')
  assert.ok(remove, 'the renamed playlist card has no remove action')
  remove.props.onClick()
  await sleep(30)
  assert.equal(uSaved().videoPlaylists.length, 0, 'remove did not persist')
})

await recordAsync('starter films can be hidden and shown, recents cleared', async () => {
  uAria('Hide starter films').props.onClick()
  await sleep(30)
  assert.equal(uSaved().videoHiddenStarters.length, 8, 'hide starters did not persist')
  assert.ok(uAria('Show starter films'), 'the page does not offer Show starters after hiding')
  uAria('Clear recents').props.onClick()
  await sleep(30)
  assert.equal(uSaved().videoRecent.length, 0, 'clear recents did not persist')
  uAria('Show starter films').props.onClick()
  await sleep(30)
  assert.equal(uSaved().videoHiddenStarters.length, 0, 'show starters did not persist')
  disposeU()
  assert.equal(u.contributions.length, 0)
})

// ------------------------------------------- regression fixes (lane fixes1)
// Each of these pins one review finding and failed on the pre-fix plugin.

const tx = pluginModule.__test
const findRowByTitle = (tree, title) => {
  let found = null
  walk(tree, node => {
    if (found || !node.props || !Array.isArray(node.props.children) || node.props.children.length !== 2) return
    const labelCell = node.props.children[0]
    // A settings row's first cell is the label <div> (not, say, an <optgroup>
    // in the grouped source picker that happens to list the same title).
    if (!labelCell || labelCell.type !== 'div' || !labelCell.props || !Array.isArray(labelCell.props.children)) return
    const titleNode = labelCell.props.children[0]
    if (titleNode && texts(titleNode) === title) found = node
  })
  return found
}

record('readPositions preserves a playlist episode videoId for resume', () => {
  const listUrl = 'https://www.youtube.com/watch?v=ep4abcdefgh&list=PL0123456789'
  const out = tx.readPositions({
    [listUrl]: { position: 123, duration: 600, at: 50, videoId: 'ep4abcdefgh' },
    'https://example.com/film.mp4': { position: 10, duration: 100, at: 10, videoId: 42 }
  })
  assert.equal(out[listUrl].videoId, 'ep4abcdefgh', 'the playlist episode id was dropped')
  assert.equal(out['https://example.com/film.mp4'].videoId, '', 'a non-string videoId was not discarded')
})

record('hidden episodes survive a reload and drop junk ids', () => {
  // A YouTube playlist cannot be edited from Aura (read-only scrape), so
  // "remove" is a local hide. It must persist, and a corrupt entry must not
  // become a hidden film.
  const ctx = makeCtx({
    enabled: true, backdropMode: 'video', videoUrl: 'https://www.youtube.com/watch?v=abc123def45&list=PL0123456789',
    videoHiddenIds: ['abc123def45', 42, null, 'zzz999yyy88']
  })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const hidden = tx.hiddenVideoIds()
    assert.equal(hidden.size, 2, 'junk entries were kept')
    assert.ok(hidden.has('abc123def45'), 'a hidden id was dropped')
    assert.ok(!hidden.has('42'), 'a numeric entry became an id')
  } finally {
    dispose()
  }
})

await recordAsync('Stop keeps desktop ownership when closing the desktop window fails', async () => {
  const scenario = makeCtx({
    enabled: true,
    backdropMode: 'video',
    panelEnabled: true,
    videoWindow: false,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    videoClosed: false
  })
  const original = scenario.ctx.rest.bind(scenario.ctx)
  scenario.ctx.rest = async (route, options) => {
    if (route === '/window/close') throw new Error('close failed')
    return original(route, options)
  }
  const dispose = pluginModule.default.register(scenario.ctx)
  try {
    scenario.timers.find(timer => timer.ms === 250).fn()
    await sleep(40)
    await pluginModule.wiringTest.setWindow(true)
    assert.equal(pluginModule.wiringTest.owned(), true, 'precondition: the desktop window does not own the film')
    pluginModule.wiringTest.command('stop')
    await sleep(40)
    assert.equal(pluginModule.wiringTest.owned(), true, 'a failed close cleared desktop ownership')
    assert.equal(pluginModule.wiringTest.filmSurface.get().placement, '', 'Stop started an in-app film after the close failed')
  } finally {
    dispose()
  }
})

record('a pop-out resolves to ONE surface, never both at once', () => {
  // Owner: "popping out does both a pop out in hermes while trying to pop out
  // outside of hermes." The in-app frame and the OS window are alternatives:
  // the OS window wins only when the host offers one AND it actually opened.
  assert.equal(tx.popoutSurface(true, true), 'desktop', 'an opened OS window lost to the in-app frame')
  assert.equal(tx.popoutSurface(true, false), 'inline', 'a failed OS window left no surface')
  assert.equal(tx.popoutSurface(false, false), 'inline', 'unavailable host did not fall back')
  // And the in-app frame is never switched on before the OS window is tried.
  const fn = source.slice(source.indexOf('async function setDesktopWindow'), source.indexOf('async function toggleDesktopWindow'))
  assert.ok(!/^\s{4}setVideoWindow\(true\)/m.test(fn.split('let available')[0]),
    'setDesktopWindow still turns the in-app frame on before asking for a window')
  assert.match(fn, /popoutSurface\(true, result\.open === true\) === 'desktop'/, 'the decision helper is not used')
})

await recordAsync('no document-level focus/key capture listeners are registered', async () => {
  // Teknium review ask 2: Aura must not capture focusin/keydown on the host
  // document. It did, with capture=true, and restored a saved DOM caret.
  const start = documentListeners.length
  const scenario = makeCtx({ enabled: true, backdropMode: 'aura', panelEnabled: true })
  const dispose = pluginModule.default.register(scenario.ctx)
  try {
    await sleep(20)
    const added = documentListeners.slice(start)
    assert.equal(
      added.filter(entry => isCapture(entry.options)).length,
      0,
      'Aura registered a document-level capture listener')
    assert.equal(
      added.filter(entry => entry.type === 'focusin').length,
      0,
      'Aura still listens for focusin on the host document')
  } finally {
    dispose()
  }
})

await recordAsync('typing is never swallowed by a document keydown handler', async () => {
  // No Aura key handler may sit on the host document: a keystroke in the chat
  // belongs to the chat. Aura's own Ctrl+Shift+H/A are bound to its elements.
  const start = documentListeners.length
  const scenario = makeCtx({ enabled: true, backdropMode: 'video', panelEnabled: true,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' })
  const dispose = pluginModule.default.register(scenario.ctx)
  try {
    scenario.timers.find(timer => timer.ms === 250).fn()
    await sleep(30)
    const keydownListeners = documentListeners.slice(start).filter(entry => entry.type === 'keydown')
    assert.equal(keydownListeners.length, 0, 'Aura put a keydown handler on the host document')
    let prevented = false
    for (const entry of keydownListeners) {
      entry.fn({ code: 'KeyA', key: 'a', preventDefault() { prevented = true } })
    }
    assert.equal(prevented, false, 'a keystroke was swallowed by Aura')
  } finally {
    dispose()
  }
})

await recordAsync('mounting the video bar adds no raw document listeners', async () => {
  const start = documentListeners.length
  const scenario = makeCtx({
    enabled: true, backdropMode: 'video', windowVisual: true,
    panelEnabled: false, videoWindow: true, videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
  })
  const dispose = pluginModule.default.register(scenario.ctx)
  try {
    scenario.timers.find(timer => timer.ms === 250).fn()
    await sleep(40)
    const bars = [...bodyChildren, ...floatingNodes()].filter(node => node.attributes && node.attributes.role === 'toolbar')
    assert.ok(bars.length > 0, 'precondition: the video bar never mounted')
    const raw = documentListeners.slice(start).filter(entry =>
      (entry.type === 'mousemove' || entry.type === 'mousedown') && entry.removed !== true)
    assert.equal(raw.length, 0, `mountVideoBar added ${raw.length} raw document listeners`)
    const tracked = scenario.listeners.filter(entry => entry.type === 'mousemove' && entry.removed !== true)
    assert.equal(tracked.length, 1, 'the reveal is not exactly one tracked document listener')
  } finally {
    dispose()
  }
})

await recordAsync('a click on Aura\'s video strip hands focus back with host.composer.focus', async () => {
  // The old code remembered a caret and synthetically focused a Hermes input.
  // The SDK's own verb addresses the current surface, so the chat gets its
  // keyboard back without Aura touching app markup.
  const scenario = makeCtx({ enabled: true, backdropMode: 'video', windowVisual: true,
    panelEnabled: false, videoWindow: true, videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' })
  const dispose = pluginModule.default.register(scenario.ctx)
  try {
    scenario.timers.find(timer => timer.ms === 250).fn()
    await sleep(40)
    const bars = [...bodyChildren, ...floatingNodes()].filter(node => node.attributes && node.attributes.role === 'toolbar')
    const bar = bars[bars.length - 1]
    assert.ok(bar, 'the video strip never mounted')
    assert.ok(Array.isArray(bar.__handlers.click) && bar.__handlers.click.length > 0,
      'the strip has no click handler to hand focus back')
    const before = sdk.calls.composer.length
    const button = { tagName: 'BUTTON', getAttribute: () => null }
    for (const handler of bar.__handlers.click) handler({ target: button, preventDefault() {} })
    await sleep(10)
    assert.ok(sdk.calls.composer.length > before,
      'host.composer.focus was not called after a strip click')
    assert.equal(sdk.calls.composer[sdk.calls.composer.length - 1], null,
      'focus must address the current surface, not a guessed session id')
  } finally {
    dispose()
  }
})

record('shortLabel survives a malformed percent escape', () => {
  const label = tx.shortLabel('https://example.com/%ZZ.mp4')
  assert.match(label, /%ZZ\.mp4/, 'the undecoded filename should still label the source')
})

record('a persisted malformed URL does not break the source queue', () => {
  const malformed = 'https://example.com/%ZZ.mp4'
  const ctx = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: malformed })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    assert.doesNotThrow(() => renderContribution(ctx.contributions.find(c => c.area === 'settings.plugins')))
    assert.doesNotThrow(() => tx.videoQueue())
    assert.ok(tx.videoQueue().some(item => item.url === malformed), 'the malformed source vanished from the queue')
  } finally {
    dispose()
  }
})

record('saved playlist Remove sits in the control column, not the hint', () => {
  const listUrl = 'https://www.youtube.com/watch?v=ep1&list=PL0123456789'
  const ctx = makeCtx({
    enabled: true,
    backdropMode: 'video',
    videoPlaylists: [{ label: 'Watch list', url: listUrl }]
  })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const tree = renderContribution(ctx.contributions.find(c => c.area === 'settings.plugins'))
    const row = findRowByTitle(tree, 'Watch list')
    assert.ok(row, 'the saved playlist row did not render')
    const hint = row.props.children[0].props.children[1]
    const control = row.props.children[1]
    assert.equal(texts(hint), '', 'the button was nested in the hint')
    assert.ok(control && control.props.children, 'the control column is empty')
    assert.equal(
      control.props.children.props['aria-label'],
      'Remove Watch list',
      'the Remove button is not the control'
    )
  } finally {
    dispose()
  }
})

await recordAsync('applyVideoSource turns video mode on and reopens a closed film', async () => {
  const ctx = makeCtx({ enabled: true, backdropMode: 'aura', videoUrl: '', videoClosed: true })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    await sleep(20)
    await tx.applyVideoSource('https://example.com/film.mp4', 'Film')
    const saved = ctx.storage.get('settings')
    assert.equal(saved.backdropMode, 'video', 'an explicit play did not switch to video mode')
    assert.equal(saved.videoClosed, false, 'an explicit play did not reopen the film')
    assert.equal(saved.videoUrl, 'https://example.com/film.mp4')
    assert.ok(
      ctx.controls.some(patch => patch && patch.backdrop_mode === 'video'),
      'the mode change never reached /control'
    )
  } finally {
    dispose()
  }
})

await recordAsync('the Settings URL box saves a playlist through applyVideoSource', async () => {
  const listUrl = 'https://www.youtube.com/watch?v=ep1&list=PL0123456789'
  const ctx = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: '', videoClosed: true })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const tree = renderContribution(ctx.contributions.find(c => c.area === 'settings.plugins'))
    const input = findByAria(tree, 'Video URL')
    assert.ok(input, 'the Settings Video URL box is missing')
    input.props.onBlur({ target: { value: listUrl } })
    await sleep(40)
    const saved = ctx.storage.get('settings')
    assert.equal(saved.videoUrl, listUrl)
    assert.equal(saved.videoClosed, false, 'a URL entered in Settings did not reopen the film')
    assert.ok(
      saved.videoPlaylists.some(item => item.url === listUrl),
      'the playlist pasted in Settings was not saved as a playlist'
    )
  } finally {
    dispose()
  }
})

await recordAsync('the quick-menu URL box reopens a closed film', async () => {
  const source = 'https://example.com/film.mp4'
  const ctx = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: '', videoClosed: true })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const menu = ctx.contributions.find(c => c.id === 'quick-menu')
    const input = findByAria(renderContribution(menu), 'Video URL')
    assert.ok(input, 'the quick-menu Video URL box is missing')
    input.props.onBlur({ target: { value: source } })
    await sleep(40)
    const saved = ctx.storage.get('settings')
    assert.equal(saved.backdropMode, 'video')
    assert.equal(saved.videoClosed, false, 'the quick-menu URL box did not reopen the film')
    assert.equal(saved.videoUrl, source)
  } finally {
    dispose()
  }
})

await recordAsync('a pending blocked-playlist lookup does not override a new selection', async () => {
  const playlist = 'https://www.youtube.com/watch?v=firstaaaaaa&list=PL0123456789'
  const other = 'https://example.com/other.mp4'
  const ctx = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: playlist })
  let release
  const gate = new Promise(resolve => { release = resolve })
  const originalRest = ctx.ctx.rest
  ctx.ctx.rest = async (route, options = {}) => {
    if (String(route).startsWith('/playlist')) {
      await gate
      return { items: [{ videoId: 'firstaaaaaa', title: 'One' }, { videoId: 'secondbbbbb', title: 'Two' }] }
    }
    return originalRest(route, options)
  }
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const pending = tx.skipBlockedEpisode()
    await sleep(10)
    await tx.applyVideoSource(other)
    release()
    await pending
    await sleep(20)
    assert.equal(ctx.storage.get('settings').videoUrl, other, 'the stale lookup stole playback back to the playlist')
  } finally {
    ctx.ctx.rest = originalRest
    dispose()
  }
})

record('the pane ref is stable and does not accumulate duplicate theatre DOM', () => {
  const ctx = makeCtx({ enabled: true })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const pane = ctx.contributions.find(c => c.area === 'panes')
    const refOf = tree => {
      let ref = null
      walk(tree, node => {
        if (!ref && node.props && node.props.key === 'theatre') ref = node.props.ref
      })
      return ref
    }
    const hostNode = document.createElement('div')
    const ref1 = refOf(renderContribution(pane))
    assert.equal(typeof ref1, 'function', 'the pane has no theatre ref')
    ref1(hostNode)
    const ref2 = refOf(renderContribution(pane))
    assert.equal(ref1, ref2, 'a fresh ref callback is created on every render')
    // React detaches the old ref with null, then attaches the new one to the
    // same node. The panel must not accumulate a second copy.
    ref1(null)
    ref2(hostNode)
    const panels = hostNode.children.filter(node => node.attributes && node.attributes.id === 'aura-panel')
    assert.equal(panels.length, 1, 'duplicate #aura-panel nodes accumulated in the host node')
  } finally {
    dispose()
  }
})

record('the pane header carries the mode switch and the power control', () => {
  const ctx = makeCtx({ enabled: true })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const pane = ctx.contributions.find(c => c.area === 'panes')
    let ref = null
    walk(renderContribution(pane), node => {
      if (!ref && node.props && node.props.key === 'theatre') ref = node.props.ref
    })
    const hostNode = document.createElement('div')
    ref(hostNode)
    const panel = hostNode.children.find(node => node.attributes && node.attributes.id === 'aura-panel')
    assert.ok(panel, 'the panel did not mount')
    const findAll = (node, predicate, out = []) => {
      if (!node) return out
      if (predicate(node)) out.push(node)
      if (node.children) node.children.forEach(child => findAll(child, predicate, out))
      return out
    }
    const head = findAll(panel, node => node.className === 'ap-head')[0]
    assert.ok(head, 'the pane has no header')
    const modes = findAll(head, node => node.getAttribute && node.getAttribute('data-mode'))
    assert.equal(modes.length, 2, 'the header needs both mode buttons')
    // Same word as the status bar, page header and settings: Video, not Movie.
    assert.deepEqual(modes.map(node => node.textContent), ['Visualizer', 'Video'])
    const power = findAll(head, node => node.className === 'ap-power')[0]
    assert.ok(power, 'the header has no on/off control')
  } finally {
    dispose()
  }
})
record('panelVisible respects the host pane visibility atom', () => {
  const previous = sdk.host.paneVisibility
  const ctx = makeCtx({ enabled: true })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    sdk.host.paneVisibility = () => ({ get: () => false })
    assert.equal(tx.panelVisible(), false, 'a hidden host pane is still treated as visible')
    sdk.host.paneVisibility = () => ({ get: () => true })
    assert.equal(tx.panelVisible(), true, 'a visible host pane was hidden')
  } finally {
    if (previous === undefined) delete sdk.host.paneVisibility
    else sdk.host.paneVisibility = previous
    dispose()
  }
})

await recordAsync('player coordinator reports, consumes commands, and restores a desktop handoff', async () => {
  const x = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: 'https://example.test/one.mp4' })
  let open = false
  let player = { desktop: false }
  let commands = []
  const calls = []
  const original = x.ctx.rest
  x.ctx.rest = async (route, options = {}) => {
    calls.push({ route, options })
    if (route === '/player') return { ok: true, window: { open }, player }
    if (route.startsWith('/player/commands?')) return { ok: true, head_seq: 2, commands }
    if (route === '/player/report') return { ok: true }
    if (route === '/window/open') { open = true; return { ok: true, window: {open: true} } }
    if (route === '/window/close') { open = false; return { ok: true, closed: true, window: {open: false} } }
    return original(route, options)
  }
  const dispose = pluginModule.default.register(x.ctx)
  await sleep(80)
  pluginModule.wiringTest.video.set({ playing: true, position: 12, duration: 90, videoId: 'abcdefghijk', title: 'one' })
  await pluginModule.wiringTest.sync()
  assert.ok(calls.some(c => c.route === '/player/report' && c.options.body.videoId === 'abcdefghijk'))
  commands = [{ seq: 3, cmd: 'pause' }]
  await pluginModule.wiringTest.sync()
  assert.equal(pluginModule.wiringTest.video.get().playing, false)
  pluginModule.wiringTest.video.set({ ...pluginModule.wiringTest.video.get(), playing: true })
  await pluginModule.wiringTest.setWindow(true)
  const sent = calls.find(c => c.route === '/window/open').options.body
  assert.equal(sent.videoId, 'abcdefghijk')
  assert.equal(sent.position, 12)
  assert.equal(pluginModule.wiringTest.video.get().playing, false)
  player = { desktop: true, url: 'https://youtube.com/playlist?list=abcdefghij', videoId: 'zyxwvutsrqp', position: 35, duration: 300, playing: true }
  await pluginModule.wiringTest.sync()
  open = false
  await pluginModule.wiringTest.sync()
  assert.equal(pluginModule.wiringTest.settings.get().videoUrl, player.url)
  assert.equal(pluginModule.wiringTest.settings.get().videoPositions[player.url].videoId, player.videoId)
  assert.equal(pluginModule.wiringTest.settings.get().videoPositions[player.url].position, 35)
  pluginModule.wiringTest.video.set({ ...pluginModule.wiringTest.video.get(), playing: true })
  player = { desktop: false }
  open = true // An agent, rather than the page button, opened the window.
  await pluginModule.wiringTest.sync()
  assert.equal(pluginModule.wiringTest.video.get().playing, false)
  // One or the other: the desktop window owns the picture, no in-app watch window too.
  assert.notEqual(pluginModule.wiringTest.settings.get().videoWindow, true)
  dispose()
})

await recordAsync('the playing film keeps its address when Aura saves its position (no reload every 5 s)', async () => {
  // Owner, 11-15: the film stuttered (play/pause flipping) and Stop did not
  // stop. The film's address carried &resume=<saved position>; Aura saves the
  // position every 5 s, so the address changed, the player reloaded and
  // resumed playing, again and again.
  const film = 'https://example.test/stutter.mp4'
  const x = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: film, panelEnabled: true, videoPositions: { [film]: { position: 40, duration: 600, at: 1 } } })
  const dispose = pluginModule.default.register(x.ctx)
  tick(x)
  await sleep(80)
  const w = pluginModule.wiringTest
  assert.ok(w.remember && w.refreshFilm && w.filmSurface, 'precondition: test hooks missing')
  w.refreshFilm()
  const before = w.filmSurface.get().src
  assert.ok(before && before.includes('resume=40'), `precondition: no film address with its resume point (${before})`)
  // Playback goes on; the 5-second bookmark lands, then the next poll runs.
  w.remember(film, 125, 600, false, '', true)
  tick(x)
  await sleep(40)
  w.refreshFilm()
  assert.equal(w.filmSurface.get().src, before, 'saving the position changed the film address, so the player reloads (stutter, Stop undone)')
  // A different film still gets a new address.
  w.settings.set({ ...w.settings.get(), videoUrl: 'https://example.test/other.mp4' })
  w.refreshFilm()
  assert.notEqual(w.filmSurface.get().src, before, 'switching films kept the old film address')
  dispose()
})

await recordAsync('Watch in > Desktop opens the OS window and unavailable browsers use the in-app window', async () => {
  // "Pop out" on the page is the in-Hermes watch window (owner's words); the OS
  // window is Watch in > Desktop.
  const x = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: 'https://example.test/one.mp4' })
  const calls = []
  let available = true
  const original = x.ctx.rest
  x.ctx.rest = async (route, options = {}) => {
    calls.push(route)
    if (route === '/window') return { ok: true, available, open: false }
    if (route === '/window/open') return { ok: true, window: { open: true } }
    if (route === '/window/close') return { ok: true, closed: true, window: { open: false } }
    if (route === '/player') return { ok: true, player: {}, window: { open: false } }
    if (route === '/player/report') return { ok: true }
    if (route.startsWith('/player/commands?')) return { ok: true, head_seq: 0, commands: [] }
    return original(route, options)
  }
  const dispose = pluginModule.default.register(x.ctx)
  await sleep(40)
  const menu = renderContribution(x.contributions.find(c => c.id === 'quick-menu'))
  findByAria(menu, 'Watch the film in a desktop window (quick menu)').props.onClick()
  await sleep(40)
  assert.ok(calls.includes('/window/open'))
  dispose()
  const y = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: 'https://example.test/one.mp4' })
  const originalY = y.ctx.rest
  y.ctx.rest = async (route, options = {}) => {
    if (route === '/window') return { ok: true, available: false, open: false }
    if (route === '/window/open') throw Error('should not launch')
    return originalY(route, options)
  }
  const disposeY = pluginModule.default.register(y.ctx)
  await pluginModule.wiringTest.setWindow(true)
  assert.equal(pluginModule.wiringTest.settings.get().videoWindow, true)
  disposeY()
})

record('URL field keeps edits but ignores an unchanged stale draft', () => {
  const x = makeCtx({ enabled: true, videoUrl: 'https://example.test/a' })
  const dispose = pluginModule.default.register(x.ctx)
  const a = pluginModule.wiringTest.urlBinding('https://example.test/a')
  const node = { value: 'https://example.test/a' }
  a.onFocus({ currentTarget: node })
  const b = pluginModule.wiringTest.urlBinding('https://example.test/b')
  b.ref(node)
  assert.equal(node.value, 'https://example.test/a')
  pluginModule.wiringTest.settings.set({ ...pluginModule.wiringTest.settings.get(), videoUrl: 'https://example.test/b' })
  b.onBlur({ currentTarget: node })
  assert.equal(node.value, 'https://example.test/b')
  b.ref(node)
  assert.equal(node.value, 'https://example.test/b')
  dispose()
})

await recordAsync('the settings page says when a motion that needs audio has none', async () => {
  sdk.themeState.name = 'nous'
  const noCap = makeCtx({ enabled: true, motion: 'both', capture: 'none' })
  const disposeNoCap = pluginModule.default.register(noCap.ctx)
  const pollNoCap = noCap.timers.find(t => t.ms === 250)
  if (pollNoCap) pollNoCap.fn()
  await sleep(40)
  const hinted = texts(renderContribution(noCap.contributions.find(c => c.area === 'settings.plugins')))
  assert.ok(/No system audio found/.test(hinted),
    'no hint with a motion that needs audio and capture:none')
  assert.ok(/nothing is listening/.test(hinted), 'the hint does not say nothing listens')
  disposeNoCap()

  const agentOnly = makeCtx({ enabled: true, motion: 'agent', capture: 'none' })
  const disposeAgent = pluginModule.default.register(agentOnly.ctx)
  const pollAgent = agentOnly.timers.find(t => t.ms === 250)
  if (pollAgent) pollAgent.fn()
  await sleep(40)
  const quiet = texts(renderContribution(agentOnly.contributions.find(c => c.area === 'settings.plugins')))
  assert.equal(/No system audio found/.test(quiet), false,
    'hint shown for a motion that never uses audio')
  disposeAgent()
})

await recordAsync('While idle offers Stop/Ember/Keep moving and pushes idle_motion', async () => {
  sdk.themeState.name = 'nous'
  const inst = makeCtx({ enabled: true })
  const disposeInst = pluginModule.default.register(inst.ctx)
  const findSelect = () => {
    let sel = null
    walk(renderContribution(inst.contributions.find(c => c.area === 'settings.plugins')), node => {
      if (!sel && node.props && node.props['aria-label'] === 'While idle') sel = node
    })
    return sel
  }

  let sel = findSelect()
  assert.ok(sel, 'no "While idle" select rendered')
  const options = (sel.props.children || []).filter(Boolean).map(option => option.props)
  assert.deepEqual(options.map(option => option.value), ['stop', 'ember', 'always'])
  assert.equal(sel.props.value, 'always', 'idle motion should default to keep moving')

  sel.props.onChange({ target: { value: 'stop' } })
  await sleep(30)
  assert.deepEqual(inst.controls.at(-1), { idle_motion: 'stop' })

  sel = findSelect()
  assert.equal(sel.props.value, 'stop', 'the select did not follow the saved value')

  sel.props.onChange({ target: { value: 'ember' } })
  await sleep(30)
  assert.deepEqual(inst.controls.at(-1), { idle_motion: 'ember' })
  disposeInst()
})

// ---------------------------------------------------- visualiser mode (last)
// Registering a fresh context replaces the module's global settings, so this
// block sits just before the report and after everything that expects video.
const auraMode = makeCtx({
  enabled: true,
  backdropMode: 'aura',
  showWhen: 'always',
  intensity: 0.5,
  panelEnabled: false,
  windowVisual: true,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
})
pluginModule.default.register(auraMode.ctx)
const auraMenuTree = renderContribution(auraMode.contributions.find(c => c.id === 'quick-menu'))

record('visualiser mode keeps the visual rows and drops the film rows', () => {
  for (const label of ['Reacts to', 'Intensity', 'Gentle motion (motion-sensitive)', 'Show']) {
    assert.ok(findByAria(auraMenuTree, label), `${label} is missing in visualiser mode`)
  }
  for (const label of ['Video volume', 'Watch window']) {
    assert.equal(findByAria(auraMenuTree, label), null, `film-only row ${label} leaked into visualiser mode`)
  }
})

record('the mode switch offers exactly Visualizer and Video', () => {
  const group = findByAria(auraMenuTree, 'Aura mode')
  assert.ok(group, 'no mode switch in the quick menu')
  const body = texts(group)
  assert.match(body, /Visualizer/, 'the switch has no Visualizer option')
  assert.match(body, /Video/, 'the switch has no Video option')
})

await recordAsync('manage playlist refuses a film that is not a playlist', async () => {
  // "Manage" opens YouTube's own playlist page in the pop-out. A single film
  // has no list, so the button must say so instead of asking the server to
  // open a page that cannot be curated.
  const ctx = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: 'https://example.test/film.mp4' })
  const dispose = pluginModule.default.register(ctx.ctx)
  const routes = []
  const oldRest = ctx.ctx.rest
  ctx.ctx.rest = async (route, options) => { routes.push(String(route)); return oldRest(route, options) }
  try {
    await tx.managePlaylist()
    assert.equal(routes.filter(r => r.includes('/window/manage')).length, 0,
      'a film with no list still asked for a playlist window')
  } finally {
    ctx.ctx.rest = oldRest
    dispose()
  }
})

await recordAsync('manage playlist opens the real list page in the window', async () => {
  const ctx = makeCtx({
    enabled: true, backdropMode: 'video',
    videoUrl: 'https://www.youtube.com/watch?v=abc123def45&list=PL0123456789'
  })
  const dispose = pluginModule.default.register(ctx.ctx)
  const calls = []
  const oldRest = ctx.ctx.rest
  ctx.ctx.rest = async (route, options) => { calls.push([String(route), options]); return { ok: true, already: false } }
  try {
    await tx.managePlaylist()
    const hit = calls.find(([route]) => route.includes('/window/manage'))
    assert.ok(hit, 'no manage request reached the server')
    assert.equal(hit[1].method, 'POST')
    assert.equal(hit[1].body.url, 'https://www.youtube.com/playlist?list=PL0123456789',
      'the window was pointed somewhere other than the playlist page')
  } finally {
    ctx.ctx.rest = oldRest
    dispose()
  }
})

// Scenario U: the dev-stats readout is explicit (Ctrl+Shift+A only), appends
// exactly one node when asked, and is removed on dispose even when a later
// host call throws before teardown reaches its end.
{
  const seenBefore = (globalThis.document.__handlers.keydown || []).length
  const bucket = makeCtx({ enabled: false })
  const dispose = pluginModule.default.register(bucket.ctx)
  const added = (globalThis.document.__handlers.keydown || []).slice(seenBefore)
  // Dev stats mount inside Aura's own Right pane, never document.body (review 3).
  const paneHost = globalThis.document.createElement('div')
  pluginModule.wiringTest.panelHost(paneHost)
  const inPane = () => {
    const out = []
    const walk = node => { for (const child of (node && node.children) || []) { out.push(child); walk(child) } }
    walk(paneHost)
    return out
  }
  const devStats = () => inPane().find(node => node.attributes && node.attributes.id === 'aura-dev-stats') ||
    bodyChildren.find(node => node.attributes && node.attributes.id === 'aura-dev-stats')
  // The shortcut lives on Aura's own panel and strip, never the host document (review ask 2).
  const hotkey = pluginModule.wiringTest.devStatsKey

  record('D11. the dev-stats panel is not mounted unless explicitly asked for', () => {
    assert.equal(typeof hotkey, 'function', 'no Ctrl+Shift+A handler exists')
    assert.equal(added.length, 0, 'register() added a keydown listener to the host document')
    assert.equal(devStats(), undefined, 'the dev-stats panel mounted on its own')
  })

  record('D12. Ctrl+Shift+A mounts exactly one dev-stats panel', () => {
    hotkey({ code: 'KeyA', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false, defaultPrevented: false, preventDefault() {} })
    assert.ok(devStats(), 'the hotkey did not mount the dev-stats panel')
    assert.equal(inPane().filter(node => node.attributes && node.attributes.id === 'aura-dev-stats').length, 1,
      'the hotkey mounted more than one dev-stats panel')
    assert.equal(bodyChildren.some(node => node.attributes && node.attributes.id === 'aura-dev-stats'), false,
      'dev stats were appended to document.body')
  })

  sdk.failures.accent = 1
  let threw = false
  try {
    dispose()
  } catch {
    threw = true
  } finally {
    sdk.failures.accent = 0
  }
  record('D13. dispose removes the dev-stats panel even if a host call throws', () => {
    assert.equal(threw, true, 'the injected host failure did not surface (bad precondition)')
    assert.equal(devStats(), undefined, 'the dev-stats panel was stranded on the window by a throwing host call')
  })
}

// ------------------------------------------------- regression F2: boot panel
// The panel switch is remembered in settings, so boot has to honour it. It
// used to register the pane unconditionally, which brought a switched-off
// panel back after a restart as an empty column (the pane renders null).
{
  const off = makeCtx({ enabled: true, panelEnabled: false })
  const disposeOff = pluginModule.default.register(off.ctx)
  await sleep(30)
  await recordAsync('a panel switched off before the restart stays off at boot', async () => {
    assert.equal(
      off.contributions.some(c => c.id === 'panel'),
      false,
      'the pane registered at boot although the user had switched the panel off'
    )
  })
  disposeOff()

  const on = makeCtx({ enabled: true })
  const disposeOn = pluginModule.default.register(on.ctx)
  await sleep(30)
  await recordAsync('the default settings still register the pane at boot', () => {
    assert.ok(on.contributions.some(c => c.id === 'panel'), 'the pane did not register with the default settings')
  })
  disposeOn()
}

// ------------------------------------------- regression F4: watch window corner
// "Watch window corner" in settings never reached the pane registration, so
// the window always spawned top-left/top-right whatever the owner chose.
async function watchPaneFor(settings) {
  const bucket = makeCtx({
    enabled: true,
    backdropMode: 'video',
    windowVisual: true,
    videoWindow: true,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    ...settings
  })
  const dispose = pluginModule.default.register(bucket.ctx)
  bucket.timers.find(t => t.ms === 250).fn()
  await sleep(40)
  const pane = bucket.contributions.find(c => c.id === 'watch' && c.area === 'panes')
  return { pane, bucket, dispose }
}

{
  const chosen = await watchPaneFor({ panelEnabled: true, videoWindowCorner: 'bottom-right' })
  try {
    await recordAsync('the chosen watch-window corner reaches the floating pane', () => {
      assert.ok(chosen.pane, 'the watch window pane never registered')
      assert.equal(chosen.pane.data.placement, 'floating')
      assert.equal(chosen.pane.data.anchor, 'bottom-right', 'the corner setting was ignored')
    })
  } finally {
    chosen.dispose()
  }

  const fallback = await watchPaneFor({ panelEnabled: true })
  try {
    await recordAsync('the default corner still gives way to the open Right panel', () => {
      assert.ok(fallback.pane, 'the watch window pane never registered')
      assert.equal(fallback.pane.data.anchor, 'top-left', 'the watch window would open over the panel controls')
    })
  } finally {
    fallback.dispose()
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
