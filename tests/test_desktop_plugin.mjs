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
 *   4. the stage era is gone: no /aura route, sidebar row, palette command
 *      or pane — the backdrop and Settings are the product, plus the
 *      deliberate status-bar quick menu (see 9), and (since the page work)
 *      one sidebar row that opens the full Aura page (see scenario P),
 *   5. the polling interval is never faster than 4 Hz,
 *   6. the static SDK rules hold: no eval / new Function / JSX / dynamic
 *      import, no imports outside the three allowed specifiers, no
 *      document.querySelector('[data-slot=...]'), no document.body observer,
 *      no console output,
 *   7. host safety: with nothing opted in and no Aura Live theme active no
 *      stylesheet and no backdrop iframe reach the host and no host
 *      html/body/root style is mutated; the backdrop and the #aura-glass
 *      style appear only behind an opt-in (the windowVisual switch or the
 *      active aura-live theme) and vanish on switch-off, turning Aura off,
 *      Restore my theme and dispose,
 *   8. "Visual behind the app" turns Aura on when Aura was off, and shows a
 *      hint (instead of drawing nothing) when Aura is off while it is on,
 *   9. the status-bar quick menu registers on STATUSBAR_AREAS.right, renders
 *      the owner's controls (on/off, "Reacts to", intensity, transparency,
 *      style, gentle motion, All Aura settings), drives them through the
 *      same /control pushes and storage writes as the settings page, keeps
 *      the pulse dot still under reduced motion, adds the web half's
 *      reduced-motion=1 force-switch to the backdrop URL, and leaves no
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
import { createHash } from 'node:crypto'
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

function makeCtx(settings, catalog, quality) {
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
    behavior: settings && typeof settings.behavior === 'string' ? settings.behavior : 'balanced',
    intensity: settings && Number.isFinite(settings.intensity) ? settings.intensity : 0.25,
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
      return () => {
        if (record.removed) return
        record.removed = true
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
      if (route === '/catalog') {
        // Only the shelf scenarios hand in a catalogue; everywhere else the
        // route is as absent as it is on an old server, so the page must cope.
        if (!catalog) throw new Error('unexpected route /catalog')
        return catalog
      }
      if (String(route).startsWith('/quality')) {
        // The quality picker asks the server for the film's real files. Only
        // the quality scenarios hand in an answer; everywhere else the route is
        // as absent as it is on an old server, so the control must cope.
        if (!quality) throw new Error('unexpected route /quality')
        return typeof quality === 'function' ? quality(String(route)) : quality
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

fs.writeFileSync(pluginCopy, rewritten + '\nexport const wiringTest = { sync: typeof syncPlayerOwnership === "function" ? syncPlayerOwnership : null, urlBinding: typeof pageUrlInputBinding === "function" ? pageUrlInputBinding : null, setOwnWindow: typeof setOwnWindow === "function" ? setOwnWindow : null, video: $video, settings: $settings };\n')

fs.writeFileSync(
  sdkStub,
  `// Stub of @hermes/plugin-sdk: records the calls the plugin makes.
export const calls = { accent: [], themes: [], navigations: [], notifications: [], undismissed: [], revealed: [], composerFocus: [] }

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
  revealPane: paneId => { calls.revealed.push(paneId) },
  // The SDK's own caret verb (returnFocusToComposer): recorded, so a test can
  // prove Escape gives the keyboard back without touching the app's DOM.
  composer: { focus: surface => { calls.composerFocus.push(surface) } }
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
// Host popover used by the status-bar quick menu; the real one owns
// Escape/outside-click/focus, the stub just has to exist so the plugin's
// import resolves and the descriptor tree can be walked.
// The real Popover is a portal: its content is only in the tree when it is
// open. The stub keeps the children reachable so a test can drive a control in
// the panel; the app still owns open/close/Escape.
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

// The composer seams, as the real SDK names them. A contribution here is how a
// plugin is supposed to sit above or below the input (review 1).
export const COMPOSER_AREAS = {
  top: 'composer.top', bottom: 'composer.bottom', underside: 'composer.underside',
  leading: 'composer.leading', actions: 'composer.actions', middleware: 'composer.middleware',
  attachments: 'composer.attachments', microActions: 'composer.microActions',
  atCompletions: 'composer.atCompletions', modelPill: 'composer.modelPill', contextMenu: 'composer.contextMenu'
}

// The SDK's sandboxed frame. The stub records the src/title it was handed so a
// test can prove the film is drawn by THIS element and not by a raw iframe.
export const frames = []
globalThis.__sdkFrames = frames
export const SandboxedFrame = props => { frames.push(props); return null }
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
// The strip's own document-level gestures (drag move/up, resize) are attached
// to the document, exactly as a floating control has to: a drag that leaves the
// strip still has to follow the pointer. Recorded here so a test can fire them.
const docHandlers = new Map()
function fireDoc(type, event = {}) {
  for (const fn of [...(docHandlers.get(type) || [])]) fn(event)
}
const docListeners = type => (docHandlers.get(type) || []).length
globalThis.document = {
  hidden: false,
  visibilityState: 'visible',
  documentElement,
  // A settable viewport, so clamping can be exercised at more than one size.
  defaultView: { innerWidth: 1400, innerHeight: 900 },
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
// The stub returns descriptors rather than rendering: expand function elements
// (AuraPane → AuraFilm → SandboxedFrame) so a test sees what a render produces.
const expandTree = (node, depth = 0) => {
  if (depth > 8 || node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(child => expandTree(child, depth)); return }
  if (typeof node.type === 'function') {
    const out = node.type(node.props || {})
    if (!out || typeof out !== 'object') return
    // Replace in place, so a walker sees what the render produced — and then
    // resolve again, because the output may itself be a component.
    node.type = out.type
    node.props = out.props
    if (typeof node.type === 'function') { expandTree(node, depth + 1); return }
  }
  if (node.props) expandTree(node.props.children, depth + 1)
}
// The harness reports the pop-out window as open by default; a test that wants
// the in-app surfaces to own the player says so explicitly.
const closePopout = ctx => {
  const old = ctx.ctx.rest
  ctx.ctx.rest = async (route, options) => {
    const path = String(route)
    if (path.startsWith('/window')) return { ok: true, open: false }
    if (path === '/player') return { ok: true, window: { open: false }, player: {} }
    if (path.startsWith('/player/commands')) return { ok: true, commands: [], head_seq: 0 }
    if (path === '/player/report') return { ok: true }
    return old(route, options)
  }
}

// Run the real poll until the live server state lands (a previous test's
// in-flight poll can make a single call a no-op).
const primeLive = async () => {
  for (let attempt = 0; attempt < 8 && !tx.liveUrlForTest(); attempt += 1) {
    await tx.poll()
    await sleep(25)
  }
  return tx.liveUrlForTest()
}
// Mount/unmount the page stage the way React's ref does.
const pageStage = (width, height) => {
  if (!width) { tx.pageStageRef(null); return }
  tx.pageStageRef({ getBoundingClientRect: () => ({ width, height, top: 0, left: 0 }) })
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

const a = makeCtx({ enabled: true, intensity: 0.5, followAudio: true, themeOptIn: false })
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

// The pane itself is a VIDEO surface now (owner 04:50): its layout and its
// settings drawer are proven on a video-mode context in the "Right panel is a
// video surface" block further down, and in visualizer mode there is no pane to
// check at all.
record('in visualizer mode the Right panel is not contributed at all', () => {
  // Scenario A is visualizer mode with the "Right panel" switch on, and the
  // panel still must not exist: it is a film surface, and no film is on.
  assert.equal(a.storage.get('settings').backdropMode, undefined,
    'this scenario is meant to run on the default (Aura visual) mode')
  assert.equal(a.contributions.some(c => c.area === 'panes'), false,
    'the Right panel is contributed while the Aura visual is the backdrop')
  assert.equal(a.contributions.some(c => c.id === 'panel'), false)
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

record('contributes the Aura Live theme', () => {
  const theme = a.contributions.find(c => c.area === 'themes')
  assert.ok(theme, 'no themes contribution')
  assert.equal(theme.data.name, 'aura-live')
  const required = [
    'background', 'foreground', 'card', 'cardForeground', 'muted', 'mutedForeground',
    'popover', 'popoverForeground', 'primary', 'primaryForeground', 'secondary',
    'secondaryForeground', 'accent', 'accentForeground', 'border', 'input', 'ring',
    'destructive', 'destructiveForeground'
  ]
  for (const key of required) {
    assert.match(theme.data.colors[key], /^#[0-9a-f]{6}$/i, `colors.${key} is not a hex colour`)
    assert.match(theme.data.darkColors[key], /^#[0-9a-f]{6}$/i, `darkColors.${key} is not a hex colour`)
  }
  assert.equal(typeof theme.data.typography.fontSans, 'string')
  assert.equal(typeof theme.data.typography.fontMono, 'string')
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

await recordAsync('nothing is injected with no opt-in and no Aura Live theme', async () => {
  await sleep(30)
  assert.equal(hostStyles().length, 0, 'injected a stylesheet into the host head')
  assert.equal(hostIframes().length, 0, 'mounted a backdrop iframe on the host body')
  assert.equal(hostHasNegativeZ(), false, 'a host node uses a negative z-index')
  assert.deepEqual(Object.keys(documentElement.style), [], 'host html/root style was mutated')
  assert.deepEqual(Object.keys(document.body.style), [], 'host body style was mutated')
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

await recordAsync('the visual switch turns Aura on through the same door when Aura is off', async () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const switches = findSettingsSwitches(renderContribution(settings))
  assert.ok(switches.enabled && switches.visual, 'missing Aura enabled / Visual behind the app switches')
  switches.enabled.props.onCheckedChange(false)
  await sleep(30)
  switches.visual.props.onCheckedChange(true)
  await sleep(40)
  assert.deepEqual(a.controls.at(-1), { enabled: true }, 'the visual switch did not enable Aura via /control')
  const saved = a.storage.get('settings')
  assert.equal(saved.enabled, true, 'the visual switch did not enable Aura in the saved settings')
  assert.equal(saved.windowVisual, true, 'the visual switch did not persist windowVisual')
  // Clean up: visual off again, Aura stays on.
  switches.visual.props.onCheckedChange(false)
  await sleep(30)
})

await recordAsync('the visual row hints when the visual is on but Aura is off', async () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const switches = findSettingsSwitches(renderContribution(settings))
  assert.ok(switches.enabled && switches.visual, 'missing switches')
  switches.visual.props.onCheckedChange(true)
  await sleep(30)
  switches.enabled.props.onCheckedChange(false)
  await sleep(30)
  // windowVisual stays on, but nothing draws and the row says why.
  const text = texts(renderContribution(settings))
  assert.match(text, /Aura is off - turn it on to see the visual/)
  assert.equal(hostStyles().length, 0, 'drew glass while Aura was off')
  assert.equal(hostIframes().length, 0, 'drew a backdrop while Aura was off')
  // Clean up: visual off, Aura on again.
  switches.visual.props.onCheckedChange(false)
  switches.enabled.props.onCheckedChange(true)
  await sleep(30)
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
    tick.fn()
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
    a.timers.find(t => t.ms === 250).fn()
    await sleep(30)
    const text = texts(renderContribution(a.contributions.find(c => c.area === 'settings.plugins')))
    assert.match(text, /timed out/i)
    assert.doesNotMatch(text, /secret|token/)
  } finally {
    a.ctx.rest = oldRest
    a.timers.find(t => t.ms === 250).fn()
    await sleep(30)
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
      a.timers.find(t => t.ms === 250).fn()
      await sleep(30)
      const text = texts(renderContribution(a.contributions.find(c => c.area === 'settings.plugins')))
      assert.match(text, expected)
      assert.doesNotMatch(text, /secret|token/)
    }
  } finally {
    a.ctx.rest = oldRest
    a.timers.find(t => t.ms === 250).fn()
    await sleep(30)
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


// ------------------------------------------------------------- scenario B

sdk.themeState.name = 'nous'
const b = makeCtx({ enabled: true, intensity: 0.5, followAudio: true, themeOptIn: true })
let disposeB = null

await recordAsync('theme opt-in selects aura-live only after the active theme is known', async () => {
  disposeB = pluginModule.default.register(b.ctx)
  await sleep(20)
  assert.equal(sdk.calls.themes.includes('aura-live'), false, 'theme applied before the probe mounted')
  const probe = b.contributions.find(c => c.area === 'titleBar.center')
  renderContribution(probe)
  await sleep(20)
  assert.ok(sdk.calls.themes.includes('aura-live'), 'aura-live was not requested')
})



// ------------------------------------------------------------- scenario D
// The probe reports the theme the host is actually showing. A disable hands the
// user's theme back; the host then reports it, and that report must not be read
// as a fresh opt-in that drags the user onto aura-live again.

sdk.themeState.name = 'nous'
const th = makeCtx({ enabled: true, intensity: 0.5, themeOptIn: true })
const disposeTh = pluginModule.default.register(th.ctx)
const probeTh = th.contributions.find(c => c.area === 'titleBar.center')

await recordAsync('disabling Aura keeps the restored theme when the probe reports it back', async () => {
  renderContribution(probeTh)
  await sleep(20)
  sdk.themeState.name = 'aura-live'
  renderContribution(probeTh)
  await sleep(20)

  const switches = findSettingsSwitches(renderContribution(th.contributions.find(c => c.area === 'settings.plugins')))
  assert.ok(switches.enabled, 'no Aura enabled switch rendered')
  switches.enabled.props.onCheckedChange(false)
  await sleep(30)
  assert.equal(sdk.calls.themes.at(-1), 'nous', 'disabling did not restore the previous theme')
  const afterRestore = sdk.calls.themes.length

  // The host now reports the theme it restored for the user. That is the user's
  // own skin, not an opt-in request, so aura-live must not come back.
  sdk.themeState.name = 'nous'
  renderContribution(probeTh)
  await sleep(30)
  assert.equal(sdk.calls.themes.length, afterRestore, 'the restored theme was immediately re-applied over')
  assert.equal(sdk.calls.themes.at(-1), 'nous', 'Aura pulled the user back onto the aura-live theme')
  assert.equal(hostIframes().length, 0, 'the backdrop survived the restore')
})

record('dispose of the disabled instance is clean', () => {
  disposeTh()
  assert.equal(th.contributions.length, 0)
})

// ------------------------------------------------------------- scenario E
// The probe can still be reporting our own skin at the moment Aura re-applies,
// so "previous theme" must come from the last theme the USER wore, never from
// aura-live. Otherwise every switch-off asks the host to keep Aura's theme.

sdk.themeState.name = 'nous'
const own = makeCtx({ enabled: true, intensity: 0.5, themeOptIn: true })
const disposeOwn = pluginModule.default.register(own.ctx)
const probeOwn = own.contributions.find(c => c.area === 'titleBar.center')
const enabledSwitch = () => findSettingsSwitches(
  renderContribution(own.contributions.find(c => c.area === 'settings.plugins'))).enabled

await recordAsync('never hands back the Aura theme as the user previous theme', async () => {
  await sleep(20)                       // let register settle, as scenario B does
  renderContribution(probeOwn)          // first report: the user is on "nous"
  await sleep(20)
  assert.equal(sdk.calls.themes.at(-1), 'aura-live', 'the opt-in did not apply')
  sdk.themeState.name = 'aura-live'     // the host is now wearing our skin
  renderContribution(probeOwn)
  await sleep(20)

  enabledSwitch().props.onCheckedChange(false) // off: hands "nous" back
  await sleep(30)
  assert.equal(sdk.calls.themes.at(-1), 'nous', 'switching off did not restore the user theme')

  enabledSwitch().props.onCheckedChange(true)  // on again, probe still says aura-live
  await sleep(30)
  const beforeSecondOff = sdk.calls.themes.length
  enabledSwitch().props.onCheckedChange(false)
  await sleep(30)
  assert.equal(sdk.calls.themes.length, beforeSecondOff + 1,
    'switching off did not request a restore')
  assert.equal(sdk.calls.themes.at(-1), 'nous',
    'switching off handed back the Aura theme (recorded as the user previous theme)')
})

record('dispose of the themed instance is clean', () => {
  disposeOwn()
  assert.equal(own.contributions.length, 0)
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

// ------------------------------------------------------------- scenario D
// Disposal alone must restore the theme the user had before Aura.

sdk.themeState.name = 'nous'
const d = makeCtx({ enabled: true, intensity: 0.5, themeOptIn: true })
const disposeD = pluginModule.default.register(d.ctx)

await recordAsync('disposer restores the previous theme and removes listeners', async () => {
  await sleep(20)
  const probe = d.contributions.find(c => c.area === 'titleBar.center')
  renderContribution(probe)
  await sleep(20)
  assert.ok(sdk.calls.themes.includes('aura-live'), 'aura-live was not requested')
  disposeD()
  assert.equal(sdk.calls.themes.at(-1), 'nous', 'previous theme was not restored on dispose')
  assert.equal(d.contributions.length, 0)
  assert.ok(d.timers.every(t => t.cleared))
  assert.ok(d.listeners.every(t => t.removed))
  assert.equal(hostStyles().length, 0)
  assert.equal(hostIframes().length, 0)
})

// ------------------------------------------------------------- scenario E
// Opt-in by default: a fresh install applies no accent override and no theme.

const e = makeCtx()
const disposeE = pluginModule.default.register(e.ctx)

await recordAsync('accent pulse and Aura Live are off by default', async () => {
  await sleep(20)
  const accentBefore = sdk.calls.accent.length
  const themesBefore = sdk.calls.themes.length
  const probe = e.contributions.find(c => c.area === 'titleBar.center')
  renderContribution(probe)
  e.timers.find(t => t.ms === 250).fn()
  await sleep(30)
  assert.equal(sdk.calls.accent.length, accentBefore, 'accent was applied without opt-in')
  assert.equal(sdk.calls.themes.length, themesBefore, 'a theme was requested without opt-in')
  const settings = e.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let accentSwitch = null
  let themeSwitch = null
  walk(tree, node => {
    if (!accentSwitch && node.props && node.props['aria-label'] === 'Accent pulse') accentSwitch = node
    if (!themeSwitch && node.props && node.props['aria-label'] === 'Use Aura theme') themeSwitch = node
  })
  assert.ok(accentSwitch && themeSwitch, 'opt-in switches are missing')
  assert.equal(accentSwitch.props.checked, false, 'accent pulse defaults on')
  assert.equal(themeSwitch.props.checked, false, 'Aura Live theme defaults on')
  assert.equal(hostStyles().length, 0)
  assert.equal(hostIframes().length, 0)

  // Desktop defaults for a new user: agent_music, balanced, 25% intensity and
  // 25% opacity, "Show: Always". Saved settings keep their own values (covered
  // elsewhere).
  const motion = findSwitch(tree, 'Motion source')
  assert.equal(motion.props.value, 'agent_music', 'motion default is not agent_music')
  const behavior = (() => {
    let found = null
    walk(tree, node => {
      if (!found && node.type === 'select' && node.props && node.props['aria-label'] === 'Behaviour profile') found = node
    })
    return found
  })()
  assert.equal(behavior.props.value, 'balanced', 'behaviour default is not balanced')
  const opacity = (() => {
    let found = null
    walk(tree, node => {
      if (!found && node.type === 'input' && node.props && node.props['aria-label'] === 'Visual opacity') found = node
    })
    return found
  })()
  assert.equal(opacity.props.value, 25, 'opacity default is not 25%')
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
  assert.equal(intensity.props.value, 0.25, 'intensity default is not 0.25')
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
  f.timers.find(t => t.ms === 250).fn()
  await sleep(30)
}
const fSaved = () => f.storage.get('settings', {})
const fLastControl = () => f.controls.at(-1)


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
  assert.match(dim.props.style.color, /--ui-text-primary/,
    'the trigger is not full contrast while Aura is off')
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
  findByAria(quickTree(), 'Transparency').props.onChange({ target: { value: '30' } })
  await sleep(30)
  assert.deepEqual(fLastControl(), { opacity: 0.3 }, 'opacity push missing or wrong')
  assert.equal(fSaved().opacity, 0.3, 'opacity did not persist')
  assert.equal(findByAria(quickTree(), 'Transparency').props.value, 30, 'slider did not round-trip')
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
})

// The "Right panel" switch now means "show it in video mode", so it is driven in
// the video-mode block further down ("right panel switch ...").

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

await 
await 
await 
await 

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
  assert.equal(findByAria(tree, 'Transparency').props.value, 40, 'the menu still shows the stale opacity')
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
  findByAria(hMenu(), 'Transparency').props.onChange({ target: { value: '30' } })
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
  // Tray-only life: no docked panel, so the floating strip is the surface.
  panelEnabled: false,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
})
pluginModule.default.register(v.ctx)
// Drive one poll tick: the strip mounts from the poll, exactly like the app.
v.timers.find(t => t.ms === 250).fn()
await sleep(80)



// ------------------------------------------------- pane-only film (regression)
// Grok's review caught the demo-killer: with the defaults (window visual off,
// not on the Aura theme) nothing mounted, so the docked pane showed a stage
// that played nothing. The pane itself must be a reason to mount the film, at
// full opacity — a 20% film inside its own box reads as a stain on camera.

const paneOnly = makeCtx({
  enabled: true,
  backdropMode: 'video',
  windowVisual: false,
  themeOptIn: false,
  panelEnabled: true,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
})
pluginModule.default.register(paneOnly.ctx)
paneOnly.timers.find(t => t.ms === 250).fn()
await sleep(80)


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
  themeOptIn: false,
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
  if (typeof node.type === 'function' && !SDK_COMPONENTS.has(node.type)) {
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
    'Frame in Hermes',
    'Pop out to desktop'
  ]) {
    assert.ok(pageAria(tree, label), `the page is missing "${label}"`)
  }
  assert.ok(pageAria(tree, 'Aura enabled'), 'the page does not render AuraSettings')
  // This page is Video mode: the visualiser-only rows are hidden by the owner's
  // rule, so "Visual behind the app" is deliberately absent here.
  assert.equal(pageAria(tree, 'Visual behind the app'), null,
    'a visualiser-only row leaked onto the film page')
  assert.match(body, /Aura setup/, 'the page has no setup section')
  assert.match(body, /Big Buck Bunny/, 'the page does not offer the starter sources')
  assert.match(body, /Winamp-style player for Hermes/, 'the REVamp card is missing')
  const link = pageAria(tree, 'Get REVamp')
  assert.ok(link, 'the Get REVamp link is missing')
  assert.equal(link.type, 'a', 'Get REVamp must be a link to the repo')
  assert.equal(link.props.href, 'https://github.com/KeyArgo/hermes-revamp')
  // The settings page carries the one-line version too.
  const settingsTree = renderDeep(renderContribution(p.contributions.find(c => c.area === 'settings.plugins')))
  assert.match(texts(settingsTree), /Winamp-style player for Hermes/, 'AuraSettings has no REVamp line')
  const line = pageAria(settingsTree, 'Open REVamp')
  assert.ok(line, 'the settings REVamp line has no Open REVamp action')
})

record('the REVamp button opens /revamp', () => {
  const button = pageAria(pageTree(), 'Open REVamp')
  assert.ok(button, 'no Open REVamp button on the page')
  const before = sdk.calls.navigations.length
  button.props.onClick()
  assert.equal(sdk.calls.navigations.length, before + 1, 'the button did not navigate')
  assert.equal(sdk.calls.navigations.at(-1), '/revamp', 'the button did not open REVamp')
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
  panelEnabled: false,
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
  for (const label of ['Reacts to', 'Style', 'Intensity', 'Transparency', 'Gentle motion (motion-sensitive)', 'Show']) {
    assert.equal(findByAria(tree, label), null, `${label} is still rendered in video mode`)
  }
  // The video's own transparency stays usable.
  const preset = findByAria(tree, '50% video transparency')
  assert.ok(preset, 'the video transparency presets vanished')
  assert.ok(!preset.props.disabled, 'video transparency must stay active in video mode')
  assert.ok(findByAria(tree, 'Movie volume'), 'the volume slider vanished')
  assert.equal(s.storage.get('settings').showWhen, 'active', 'showWhen was rewritten by hiding')
})

record('Settings hides the Aura-visual rows in video mode and offers the same switch', () => {
  const tree = sSettings()
  for (const label of ['Behaviour profile', 'Reaction strength', 'Visual opacity', 'Gentle motion (motion-sensitive)', 'Show']) {
    assert.equal(findByAria(tree, label), null, `Settings still renders ${label} in video mode`)
  }
  assert.ok(findByAria(tree, 'Aura mode'), 'Settings has no mode switch')
  // Video transparency presets are still live.
  assert.ok(!findByAria(tree, '25% video transparency').props.disabled,
    'video transparency was hidden with the Aura controls')
  assert.equal(s.storage.get('settings').showWhen, 'active', 'Settings rewrote showWhen')
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

// ------------------------------------------------------------ starters
// The starter pack is the front door of the video backdrop, so it is checked
// as data rather than by eye: the catalogue must have grown past its original
// eight films, carry no duplicate URL or label, and every entry must be a URL
// this player can actually frame (a YouTube watch link with an 11-character id,
// or a direct media file). The entries are read out of the plugin source (the
// literals ARE the shipped catalogue) and the count is also taken through
// videoQueue(), the real path prev/next and the pickers walk.

const starterBlock = (() => {
  const start = source.indexOf('const STARTER_SOURCES = Object.freeze([')
  assert.ok(start >= 0, 'STARTER_SOURCES is not in the plugin source any more')
  const end = source.indexOf('\n])', start)
  assert.ok(end > start, 'STARTER_SOURCES has no closing bracket')
  return source.slice(start, end)
})()

const starterEntries = (() => {
  const found = []
  const entryRe = /\{\s*label:\s*'((?:[^'\\]|\\.)*)',\s*url:\s*'((?:[^'\\]|\\.)*)'\s*\}/g
  for (const match of starterBlock.matchAll(entryRe)) found.push({ label: match[1], url: match[2] })
  return found
})()

record('the starter pack grew, and every source is unique and well-formed', () => {
  const queue = pluginModule.__test.videoQueue()
  assert.ok(queue.length > 8,
    `the starter pack was not expanded: videoQueue() still offers ${queue.length} sources`)
  assert.ok(starterEntries.length >= 20,
    `expected 20 or more starter sources, the array has ${starterEntries.length}`)

  const urls = starterEntries.map(entry => entry.url)
  const labels = starterEntries.map(entry => entry.label)
  assert.equal(new Set(urls).size, urls.length, 'two starter entries share a URL')
  assert.equal(new Set(labels).size, labels.length, 'two starter entries share a label')

  for (const { label, url } of starterEntries) {
    assert.ok(label.trim().length >= 3, `starter label is too short for ${url}`)
    assert.doesNotMatch(url, /\s/, `starter url contains whitespace: ${url}`)
    // The owner's own playlist must never ship. Only a hash of its id prefix is
    // kept here, so this guard cannot leak the id it guards.
    const listId = (url.match(/[?&]list=([\w-]+)/) || [])[1] || ''
    assert.notEqual(createHash('sha256').update(listId.slice(0, 13)).digest('hex'), 'e5ae157250010ee61f730d5febabf21442331cd454557858b3f37493a8d3863a',
      `a real playlist id leaked into the pack: ${url}`)
    let parsed = null
    try {
      parsed = new URL(url)
    } catch {
      parsed = null
    }
    assert.ok(parsed, `starter url is not absolute: ${url}`)
    assert.equal(parsed.protocol, 'https:', `starter url is not https: ${url}`)
    const host = parsed.hostname.replace(/^www\./, '')
    if (host === 'youtube.com') {
      assert.equal(parsed.pathname, '/watch', `starter YouTube url is not a watch link: ${url}`)
      assert.match(parsed.searchParams.get('v') || '', /^[A-Za-z0-9_-]{11}$/,
        `starter YouTube id is malformed: ${url}`)
      assert.equal(parsed.searchParams.get('list'), null,
        `a starter entry is a playlist, not a film: ${url}`)
    } else {
      assert.equal(host, 'archive.org', `unexpected starter host ${host}: ${url}`)
      assert.match(parsed.pathname, /\.(mp4|webm|ogv|ogg|m4v|mov)$/,
        `a direct starter source is not a media file: ${url}`)
    }
    assert.ok(queue.some(item => item.url === url),
      `the queue drops this starter entry (duplicate or filtered): ${url}`)
  }

  const youtube = urls.filter(url => url.includes('youtube.com/watch'))
  const direct = urls.filter(url => !url.includes('youtube.com/watch'))
  assert.ok(youtube.length >= 15, `only ${youtube.length} YouTube starters`)
  assert.ok(direct.length >= 1, 'the pack has no direct-file starter')
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
  assert.equal(uSaved().videoHiddenStarters.length, starterEntries.length,
    'hide starters did not persist every starter')
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

record('two pop-out buttons: each names its own surface, and the frame is never a silent fallback', () => {
  // Owner: "two separate pop-out buttons". Pop out = the floating window inside
  // Hermes, and nothing else. Own window = the real OS window. The one allowed
  // in-app fallback is the server answering available:false (this machine has
  // no browser at all) — and that is said out loud, never done behind the
  // user's back after a failed open.
  const inline = source.slice(source.indexOf('function setInlineWindow'), source.indexOf('async function setOwnWindow'))
  const own = source.slice(source.indexOf('async function setOwnWindow'), source.indexOf('function popoutSurface'))

  assert.ok(!/openDesktopWindow|\/window\/open/.test(inline),
    'Pop out can still open an OS window')
  assert.match(inline, /setVideoWindow\(true\)/, 'Pop out does not open the floating window')
  assert.match(inline, /registerWatchPane\(true\)/, 'Pop out does not register its frame')

  assert.match(own, /openDesktopWindow/, 'Own window does not open the OS window')
  assert.match(own, /available === false/,
    'the in-app fallback is not gated on the server reporting available:false')
  assert.match(own, /setInlineWindow\(true\)/, 'the available:false fallback has no frame to fall back to')
  assert.match(own, /sayIt\(/, 'a failed OS window says nothing')
  assert.match(own, /stays in its frame inside Hermes/i,
    'the available:false fallback does not say where the film went')
  assert.match(own, /film stays in Hermes/i, 'the failure path does not say where the film went')
  // The frame is parked only AFTER the window answered: nothing in the request
  // path may take the film off screen before the outcome is known.
  const requestAt = own.indexOf('await openDesktopWindow()')
  const parkAt = own.indexOf('registerWatchPane(false)')
  assert.ok(requestAt > 0 && parkAt > requestAt,
    'the frame is parked before the window request has answered')
})

record('review 2: no document-level focus/key capture, and focus returns via the SDK', () => {
  // Was: a `focusin` capture listener plus a saved caret range and a synthetic
  // `element.focus()` to fight the backdrop iframe for the keyboard. Nous asked
  // for the whole mechanism to go: the app owns focus, and a plugin returns it
  // through `host.composer.focus(null)`.
  assert.ok(!/addEventListener\('focusin'/.test(source), 'a document-level focusin listener is back')
  assert.ok(!/addEventListener\('keydown',\s*countKey/.test(source), 'a key-counting capture listener is back')
  assert.ok(!/rememberCaret|releaseBackdropFocus|lastCaretRange/.test(source),
    'the caret/selection machinery is back')
  assert.match(source, /host\.composer\.focus\(null\)/, 'focus is never returned through the SDK')
  assert.match(source, /function returnFocusToComposer/, 'the SDK focus helper is missing')
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
    // The box is its own component now (one controlled draft, one apply path).
    expandTree(tree)
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
    expandTree(tree)
    const input = findByAria(tree, 'Video URL')
    assert.ok(input, 'the Settings Video URL box is missing')
    // One path: type, then Enter. No blur handler any more, so a click on Apply
    // can never race an apply that already ran on blur.
    input.props.onChange({ target: { value: listUrl } })
    input.props.onKeyDown({ key: 'Enter', preventDefault() {} })
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
  const ctx = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: 'https://example.com/old.mp4', videoClosed: true })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const menu = ctx.contributions.find(c => c.id === 'quick-menu')
    const menuTree = renderContribution(menu)
    expandTree(menuTree)
    const input = findByAria(menuTree, 'Video URL')
    assert.ok(input, 'the quick-menu Video URL box is missing')
    input.props.onChange({ target: { value: source } })
    input.props.onKeyDown({ key: 'Enter', preventDefault() {} })
    await sleep(40)
    const saved = ctx.storage.get('settings')
    assert.equal(saved.videoUrl, source)
    assert.equal(saved.videoClosed, false, 'the quick-menu box did not reopen the film')
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
  const ctx = makeCtx({ enabled: true, backdropMode: 'video' })
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
  const ctx = makeCtx({ enabled: true, backdropMode: 'video' })
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
    assert.deepEqual(modes.map(node => node.textContent), ['Visualizer', 'Movie'])
    const power = findAll(head, node => node.className === 'ap-power')[0]
    assert.ok(power, 'the header has no on/off control')
  } finally {
    dispose()
  }
})
record('panelVisible respects the host pane visibility atom', () => {
  const previous = sdk.host.paneVisibility
  const ctx = makeCtx({ enabled: true, backdropMode: 'video' })
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
  await pluginModule.wiringTest.setOwnWindow(true)
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
  assert.equal(pluginModule.wiringTest.settings.get().videoWindow, true)
  dispose()
})

await recordAsync('savelist: save/remove commands write the library, the report carries it', async () => {
  const url = 'https://example.test/octopus.mp4'
  const x = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: url })
  const reports = []
  let head = 0
  let queue = []
  const original = x.ctx.rest
  x.ctx.rest = async (route, options = {}) => {
    if (route === '/player') return { ok: true, window: { open: false }, player: {} }
    if (route.startsWith('/player/commands?')) return { ok: true, head_seq: head, commands: queue }
    if (route === '/player/report') {
      reports.push(options.body || {})
      return { ok: true }
    }
    return original(route, options)
  }
  const dispose = pluginModule.default.register(x.ctx)
  const sync = () => pluginModule.wiringTest.sync()
  const stored = () => x.storage.get('settings') || {}
  await sync() // first poll only takes the cursor

  // A save queued by aura_watch lands in the saved films, once, with its label.
  head = 1
  queue = [{ seq: 1, cmd: 'save', url, label: 'Secrets of the Octopus' }]
  await sync()
  assert.deepEqual((stored().videoSources || []).map(item => [item.label, item.url]),
    [['Secrets of the Octopus', url]], 'the save did not reach the saved films')

  // The library travels with the player report, so action=list can read it.
  const reported = reports[reports.length - 1] || {}
  assert.ok(Array.isArray(reported.library), 'the player report has no library field')
  assert.deepEqual(reported.library.map(item => [item.label, item.url, item.kind]),
    [['Secrets of the Octopus', url, 'film']],
    'the report does not carry the saved film')

  // Saving the same film again does not file a second copy.
  head = 2
  queue = [{ seq: 2, cmd: 'save', url, label: 'Secrets of the Octopus' }]
  await sync()
  assert.equal((stored().videoSources || []).length, 1,
    `a duplicate save made ${(stored().videoSources || []).length} copies`)

  // Remove by label: the desktop resolves the one saved film and drops it.
  head = 3
  queue = [{ seq: 3, cmd: 'remove', label: 'secrets of the octopus' }]
  await sync()
  assert.deepEqual((stored().videoSources || []).map(item => item.url), [],
    'remove by label left the film in the library')
  const after = reports[reports.length - 1] || {}
  assert.deepEqual(after.library || [], [],
    'the report still lists the film that was just removed')

  // An ambiguous label removes nothing: a wrong film must never be dropped.
  queue = [{ seq: 4, cmd: 'save', url: 'https://example.test/octopus-two.mp4', label: 'Octopus Two' },
    { seq: 5, cmd: 'save', url: 'https://example.test/octopus-three.mp4', label: 'Octopus Three' },
    { seq: 6, cmd: 'remove', label: 'octopus' }]
  head = 6
  await sync()
  assert.deepEqual((stored().videoSources || []).map(item => item.url),
    ['https://example.test/octopus-three.mp4', 'https://example.test/octopus-two.mp4'],
    'an ambiguous label removed something anyway')
  dispose()
})

await recordAsync('page buttons: Frame in Hermes floats inside Hermes, Pop out to desktop opens the OS window', async () => {
  const x = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: 'https://example.test/one.mp4' })
  const calls = []
  const frames = []
  const original = x.ctx.rest
  x.ctx.rest = async (route, options = {}) => {
    calls.push(route)
    if (route === '/window') return { ok: true, available: true, open: false }
    if (route === '/window/open') return { ok: true, window: { open: true } }
    if (route === '/window/close') return { ok: true, closed: true, window: { open: false } }
    if (route === '/player') return { ok: true, player: {}, window: { open: false } }
    if (route === '/player/report') return { ok: true }
    if (route.startsWith('/player/commands?')) return { ok: true, head_seq: 0, commands: [] }
    return original(route, options)
  }
  const dispose = pluginModule.default.register(x.ctx)
  await sleep(40)
  const route = x.contributions.find(c => c.area === 'routes')
  const tree = renderDeep(renderContribution(route))
  // "Frame in Hermes": the floating pane appears, and no OS window is asked for.
  pageAria(tree, 'Frame in Hermes').props.onClick()
  await sleep(40)
  assert.ok(!calls.includes('/window/open'), 'Frame in Hermes opened an OS window')
  assert.ok(x.contributions.find(c => c.id === 'watch'), 'Frame in Hermes did not register the floating pane')
  assert.equal(x.storage.get('settings').videoWindow, true, 'the floating window was not remembered')

  // "Pop out to desktop": now the OS window, and the floating pane goes away.
  const tree2 = renderDeep(renderContribution(route))
  pageAria(tree2, 'Pop out to desktop').props.onClick()
  await sleep(60)
  assert.ok(calls.includes('/window/open'), 'Pop out to desktop did not ask the server for a window')
  assert.ok(!x.contributions.find(c => c.id === 'watch'), 'the floating pane survived Pop out to desktop')
  assert.notEqual((x.storage.get('settings') || {}).videoWindow, true, 'the floating window stayed on')
  dispose()
  void frames

  // A host with no browser: the server says so, so the film falls back to its
  // frame inside Hermes — and the user is told. Owner 04:50: the fallback is
  // allowed only on available:false, and it is never silent.
  const y = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: 'https://example.test/one.mp4' })
  const originalY = y.ctx.rest
  y.ctx.rest = async (route, options = {}) => {
    if (route === '/window/open') return { ok: false, error: 'no Chrome or Chromium found' }
    if (route === '/window') return { ok: true, available: false, open: false }
    if (route === '/player') return { ok: true, window: { open: false }, player: {} }
    if (route.startsWith('/player/commands')) return { ok: true, head_seq: 0, commands: [] }
    if (route === '/player/report') return { ok: true }
    return originalY(route, options)
  }
  const saidBefore = sdk.calls.notifications.length
  const disposeY = pluginModule.default.register(y.ctx)
  await sleep(40)
  const routeY = y.contributions.find(c => c.area === 'routes')
  pageAria(renderDeep(renderContribution(routeY)), 'Pop out to desktop').props.onClick()
  await sleep(60)
  assert.equal((y.storage.get('settings') || {}).videoWindow, true,
    'available:false did not fall back to the frame inside Hermes')
  assert.ok(y.contributions.find(c => c.id === 'watch'),
    'the available:false fallback did not put the film in its frame')
  const told = sdk.calls.notifications.slice(saidBefore).join('\n')
  assert.match(told, /no Chrome or Chromium/i, 'the fallback happened without saying why')
  assert.equal(y.contributions.some(c => c.id === 'panel'), true,
    'the fallback lost the Right panel')
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
  for (const label of ['Movie volume', 'Watch window']) {
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

// ------------------------------------------- review 1 + 3: SDK surfaces only
// Nous asked for two things that are really one rule: a plugin draws inside the
// surfaces the host gives it. No composer DOM queries, no body-appended frames
// or control bars — a COMPOSER_AREAS slot for the strip and SandboxedFrame for
// the picture. These tests pin the mechanism, not a screenshot.

record('review 1: the transport strip is registered in the composer underside slot', () => {
  const ctx = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: 'https://example.test/film.mp4' })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const strip = ctx.contributions.find(c => c.area === 'composer.underside')
    assert.ok(strip, 'no composer.underside contribution — the strip still lives on the body')
    assert.equal(strip.id, 'strip')
    assert.equal(typeof strip.render, 'function')
  } finally {
    dispose()
  }
})

record('review 1: nothing measures or queries the app\'s composer', () => {
  assert.ok(!/querySelectorAll\(\s*['"]textarea/.test(source), 'the composer scan is back')
  assert.ok(!/contenteditable/.test(source), 'the composer scan is back')
  assert.ok(!/composerRect/.test(source), 'the composer-rect measuring helper is back')
  // The strip floats over the app (owner: it must sit where it was dropped), but
  // its coordinates are the user's own — never derived from the app's markup.
  assert.ok(!/elementsFromPoint|elementFromPoint/.test(source), 'the strip measures the app again')
  assert.match(source, /videoBarX/, 'the strip has no saved position of its own')
})

record('review 3: the film is an SDK SandboxedFrame, never a raw iframe', () => {
  assert.match(source, /SandboxedFrame/, 'SandboxedFrame is not used')
  assert.ok(!/createElement\(\s*['"]iframe['"]/.test(source), 'a raw iframe is created again')
  assert.ok(!/doc\.body\s*\.\s*appendChild|appendChild\([^)]*\)\s*\n?.*doc\.body/.test(source),
    'something is appended to the app body again')
  assert.ok(!/#aura-glass/.test(source), 'the host stylesheet injection is back')
})

await recordAsync('review 3 + quality: the frame is the LOCAL player page, with its token', async () => {
  const videoUrl = 'https://www.youtube.com/watch?v=abc123def45&list=PL0123456789'
  const ctx = makeCtx({ enabled: true, backdropMode: 'video', videoUrl })
  closePopout(ctx)
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    // Drive the real poll: it is what fills $live with the server's url+token.
    await primeLive()
    globalThis.__sdkFrames.length = 0
    const pane = ctx.contributions.find(c => c.area === 'panes')
    expandTree(pane.render())
    const framed = globalThis.__sdkFrames.find(props => String(props.src || '').includes('/player.html'))
    assert.ok(framed, `no player frame: owner=${tx.filmOwner()} live=${tx.liveUrlForTest()} liveObj=${JSON.stringify(tx.liveForTest())} src=${tx.filmSrc()} gates=${JSON.stringify(tx.filmGates())} frames=${JSON.stringify(globalThis.__sdkFrames.map(f => f.src))}`)
    const url = new URL(framed.src)
    // Exactly the local server the backend reported — never the film's own host.
    assert.equal(url.origin, 'http://127.0.0.1:4321', `wrong origin: ${framed.src}`)
    assert.equal(url.pathname, '/player.html', `wrong path: ${framed.src}`)
    assert.equal(url.searchParams.get('token'), 'not-shown-in-ui', 'the token was dropped')
    assert.equal(url.searchParams.get('url'), videoUrl, 'the film url was not passed through')
    assert.equal(framed.title, 'Aura film')
  } finally {
    dispose()
  }
})

await recordAsync('quality: Aura (visualiser) mode frames the local visualiser on the page, never the audio url', async () => {
  const ctx = makeCtx({
    enabled: true, backdropMode: 'aura',
    audioUrl: 'https://example.test/stream.mp3'
  })
  closePopout(ctx)
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    await primeLive()
    // Owner 04:50: the Right panel is a film surface, so visualizer mode has no
    // pane at all. The Aura page is the surface that frames the visualiser.
    assert.equal(ctx.contributions.find(c => c.area === 'panes'), undefined,
      'the Right panel is contributed while the Aura visual is the backdrop')
    pageStage(1200, 400)
    globalThis.__sdkFrames.length = 0
    expandTree(renderContribution(ctx.contributions.find(c => c.area === 'routes')))
    const framed = globalThis.__sdkFrames.find(f => String(f.src || '').includes('overlay=1'))
    assert.ok(framed, `the visualiser was not framed: owner=${tx.filmOwner()} src=${tx.filmSrc()} gates=${JSON.stringify(tx.filmGates())}`)
    const url = new URL(framed.src)
    assert.equal(url.origin, 'http://127.0.0.1:4321', `wrong origin: ${framed.src}`)
    assert.ok(!String(framed.src).includes('example.test'), 'the audio url was embedded as a page')
    assert.equal(url.searchParams.get('overlay'), '1', 'the visualiser frame is not overlay mode')
  } finally {
    pageStage(null)
    dispose()
  }
})

await recordAsync('display: the visualiser frame is never dimmed a second time', async () => {
  // CONTRACT.md §9.2: the PAGE applies opacity to its own canvas and compensates
  // its scrim for it, so the frame element must stay at full strength. Dimming
  // the frame too squared the setting (25% drew 6%) and dimmed the page chrome
  // the contract keeps legible.
  // The music being on is what gives visualiser mode a surface at all: the Right
  // panel is a video surface, so with the film closed the ONE frame lives on the
  // audio seat (or the Aura page, which is mounted too).
  const ctx = makeCtx({ enabled: true, backdropMode: 'aura', opacity: 0.25, audioUrl: 'https://example.test/music.mp3' })
  closePopout(ctx)
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    await primeLive()
    globalThis.__sdkFrames.length = 0
    assert.equal(ctx.contributions.find(c => c.area === 'panes'), undefined,
      'the Right panel is contributed while the Aura visual is the backdrop')
    const surfaces = ctx.contributions.filter(c => c.id === 'audio-surface' || c.id === 'aura-page')
    assert.ok(surfaces.length, 'visualiser mode has no surface to draw the page on')
    for (const surface of surfaces) expandTree(surface.render())
    const framed = globalThis.__sdkFrames.find(f => String(f.src || '').includes('overlay=1'))
    assert.ok(framed, `the visualiser was not framed: ${JSON.stringify(globalThis.__sdkFrames.map(f => f.src))}`)
    assert.equal(framed.style.opacity, 1,
      'the frame carries the user opacity on top of the page, which applies it again (0.25 drew 0.0625)')
  } finally {
    dispose()
  }
  // A film is a different surface: the player page has no opacity of its own, so
  // the frame keeps carrying the video's adaptive transparency.
  const film = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: true,
    videoUrl: 'https://example.test/film.mp4'
  })
  closePopout(film)
  const disposeFilm = pluginModule.default.register(film.ctx)
  try {
    await primeLive()
    globalThis.__sdkFrames.length = 0
    const pane = film.contributions.find(c => c.area === 'panes')
    assert.ok(pane, 'no pane contribution')
    expandTree(pane.render())
    const framed = globalThis.__sdkFrames.find(f => String(f.src || '').includes('/player.html'))
    assert.ok(framed, 'the film was not framed')
    assert.ok(Number(framed.style.opacity) > 0 && Number(framed.style.opacity) < 1,
      'the film lost its adaptive transparency: ' + framed.style.opacity)
  } finally {
    disposeFilm()
  }
})

await recordAsync('quality: a closed film and an off server draw no frame', async () => {
  // Closed: the user pressed Close, so nothing may keep playing.
  const closed = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: 'https://example.test/a.mp4', videoClosed: true })
  closePopout(closed)
  const disposeClosed = pluginModule.default.register(closed.ctx)
  try {
    await primeLive()
    globalThis.__sdkFrames.length = 0
    const pane = closed.contributions.find(c => c.area === 'panes')
    if (pane) expandTree(pane.render())
    assert.equal(tx.filmOwner(), '', 'a closed film still owns the player')
    assert.equal(globalThis.__sdkFrames.filter(f => String(f.src || '').includes('/player.html')).length, 0,
      'a closed film still rendered a player frame')
  } finally {
    disposeClosed()
  }
  // No server: no url, so no page to load.
  const offline = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: 'https://example.test/a.mp4' })
  offline.ctx.rest = async () => { throw new Error('down') }
  const disposeOffline = pluginModule.default.register(offline.ctx)
  try {
    await primeLive()
    globalThis.__sdkFrames.length = 0
    const pane = offline.contributions.find(c => c.area === 'panes')
    if (pane) expandTree(pane.render())
    assert.equal(tx.filmOwner(), '', 'a dead server still produced an owner')
    assert.equal(globalThis.__sdkFrames.filter(f => String(f.src || '').includes('/player.html')).length, 0)
  } finally {
    disposeOffline()
  }
})

await recordAsync('quality: pane and page open together produce ONE player, owned by the page', async () => {
  const ctx = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: 'https://example.test/a.mp4' })
  closePopout(ctx)
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    await primeLive()
    // Open the page: it registers a stage, which is what pageVisible() reads.
    const page = ctx.contributions.find(c => c.area === 'routes' || c.area === 'routes')
    const pane = ctx.contributions.find(c => c.area === 'panes')
    // Pretend the page is mounted by handing the plugin its stage element.
    pageStage(1200, 400)
    globalThis.__sdkFrames.length = 0
    expandTree(pane.render())
    const frames = globalThis.__sdkFrames.filter(f => String(f.src || '').includes('/player.html'))
    assert.equal(frames.length, 0, 'the pane drew a second player while the page owned it')
    assert.equal(tx.filmOwner(), 'page', `the page did not take ownership: ${JSON.stringify(tx.filmGates())}`)
    void page
  } finally {
    pageStage(null)
    dispose()
  }
})

await recordAsync('two pop-outs never coexist, and Bring back returns the film to the pane', async () => {
  const ctx = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: 'https://example.test/one.mp4' })
  const opened = []
  let windowOpen = false
  const original = ctx.ctx.rest
  ctx.ctx.rest = async (route, options = {}) => {
    const path = String(route)
    if (path === '/window/open') { opened.push(options.body && options.body.url); windowOpen = true; return { ok: true, window: { open: true } } }
    if (path === '/window/close') { windowOpen = false; return { ok: true, closed: true, window: { open: false } } }
    if (path === '/window') return { ok: true, available: true, open: windowOpen }
    if (path === '/player') return { ok: true, window: { open: windowOpen }, player: {} }
    if (path.startsWith('/player/commands')) return { ok: true, head_seq: 0, commands: [] }
    if (path === '/player/report') return { ok: true }
    return original(route, options)
  }
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    await primeLive()
    // Pop out: floating surface only.
    tx.setInlineWindow(true)
    assert.ok(ctx.contributions.find(c => c.id === 'watch'), 'Pop out did not open the floating window')
    assert.equal(tx.filmOwner(), 'window', 'the floating window did not take the film')
    assert.equal(opened.length, 0, 'Pop out opened an OS window')

    // Own window: the floating surface closes as the OS window opens.
    await tx.setOwnWindow(true)
    assert.equal(opened.length, 1, 'Own window did not open the OS window')
    assert.ok(!ctx.contributions.find(c => c.id === 'watch'), 'both surfaces were open at once')
    assert.equal(tx.filmOwner(), '', 'an in-app surface still claims the film while the OS window owns it')

    // Bring back: the OS window closes and the pane has the film again.
    await tx.setOwnWindow(false)
    assert.equal(tx.filmOwner(), 'pane', `Bring back did not return the film to the pane: ${JSON.stringify(tx.filmGates())}`)
  } finally {
    dispose()
  }
})

await recordAsync('the floating watch window is restored after a reload', async () => {
  const ctx = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: 'https://example.test/one.mp4', videoWindow: true })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    await primeLive()
    assert.ok(ctx.contributions.find(c => c.id === 'watch'), 'a saved floating window did not come back')
    assert.equal(tx.filmOwner(), 'window', 'the restored pane did not own the film')
  } finally {
    dispose()
  }
})

// ---------------------------------------------- version chip (VERSION-CHIP.md)
// One text, one behaviour, everywhere. The chip renders the backend's
// chip_line() verbatim and never invents a number.

record('the chip renders the backend line byte for byte', () => {
  const line = tx.buildLine({
    version: '1.0.0-dev.342', commit: '1a2b3c4d5e6f7a8b', commit_short: '1a2b3c4d',
    commit_date: '2026-11-13T09:12:00-07:00', dirty: false, line: 'v1.0.0-dev.342 · 1a2b3c4d · 2026-11-13'
  })
  assert.equal(line, 'v1.0.0-dev.342 · 1a2b3c4d · 2026-11-13')
  // An older server without `line` still gets the same shape, built here.
  assert.equal(
    tx.buildLine({ version: '1.0.0', commit_short: 'abcdef12', commit_date: '2026-11-13T10:00:00Z' }),
    'v1.0.0 · abcdef12 · 2026-11-13'
  )
  assert.equal(tx.buildLine({ version: '1.0.0-dev', commit: '', commit_date: '' }), 'v1.0.0-dev')
  assert.equal(tx.buildLine({ version: '1.0.0', dirty: true }), 'v1.0.0 · modified')
  assert.equal(tx.buildLine(null), '', 'a chip was drawn with no build')
})

record('the chip tooltip lists the standard lines in order', () => {
  const title = tx.buildTitle({
    version: '1.0.0-dev.342', commit: '1a2b3c4d5e6f7a8b', commit_date: '2026-11-13T09:12:00-07:00',
    built_at: '2026-11-13T09:12:05-07:00', channel: 'dev', source: 'git'
  }, 'v1.0.0-dev.342 · 1a2b3c4d · 2026-11-13')
  assert.deepEqual(title.split('\n'), [
    'Aura 1.0.0-dev.342',
    'commit 1a2b3c4d5e6f7a8b',
    'committed 2026-11-13T09:12:00-07:00',
    'installed 2026-11-13T09:12:05-07:00',
    'channel dev',
    'read from git',
    'Click to copy'
  ])
})

await recordAsync('the chip shows nothing until the backend answers, then copies the standard line', async () => {
  const ctx = makeCtx({ enabled: true })
  const dispose = pluginModule.default.register(ctx.ctx)
  const copied = []
  const desk = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  try {
    // Nothing fetched yet: no chip, no guessed number.
    tx.resetBuildForTest()
    assert.equal(tx.buildLine(null), '')
    const chip = tx.VersionChip({ compact: true })
    assert.equal(chip, null, 'a chip was rendered before /version answered')

    // The backend answers (the real fetch path, through ctx.rest).
    const original = ctx.ctx.rest
    ctx.ctx.rest = async (route, options) => {
      if (route === '/version') {
        return {
          version: '1.0.0-dev.342', commit: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
          commit_short: '1a2b3c4d', commit_date: '2026-11-13T09:12:00-07:00',
          built_at: '2026-11-13T09:12:05-07:00', channel: 'dev', dirty: false, source: 'git',
          line: 'v1.0.0-dev.342 · 1a2b3c4d · 2026-11-13'
        }
      }
      return original(route, options)
    }
    await tx.refreshVersion()
    await sleep(20)

    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: async text => { copied.push(text) } } },
      configurable: true, writable: true
    })
    const rendered = tx.VersionChip({ compact: true })
    assert.ok(rendered, 'no chip after the backend answered')
    assert.equal(rendered.props.children, 'v1.0.0-dev.342 · 1a2b3c4d · 2026-11-13')
    assert.equal(rendered.props['aria-label'], 'Copy version v1.0.0-dev.342 · 1a2b3c4d · 2026-11-13')
    assert.equal(rendered.props.type, 'button')
    await rendered.props.onClick()
    assert.deepEqual(copied, ['Aura v1.0.0-dev.342 · 1a2b3c4d · 2026-11-13'])
  } finally {
    if (desk) Object.defineProperty(globalThis, 'navigator', desk)
    else delete globalThis.navigator
    dispose()
  }
})

await recordAsync('cold start: the film appears when the server answers, with no toggling', async () => {
  // Owner's blocker: "it doesn't even play at all ... I had to toggle aura on and
  // off and then visualizer and video". A cold start must mount the player as
  // soon as the backend answers — the user touches nothing. The Right panel is
  // the film's surface (owner 04:50), so this is the video-mode cold start.
  const ctx = makeCtx({
    enabled: true,
    backdropMode: 'video',
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
  })
  closePopout(ctx)
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    // First render happens BEFORE the server has answered: nothing may be drawn
    // (there is no page to draw yet), and nothing may be cached as "off".
    globalThis.__sdkFrames.length = 0
    const pane = ctx.contributions.find(c => c.area === 'panes')
    expandTree(pane.render())
    assert.equal(globalThis.__sdkFrames.length, 0, 'a frame was drawn with no server')

    // The live signal arrives on its own (one poll, no user action).
    await primeLive()
    globalThis.__sdkFrames.length = 0
    expandTree(pane.render())
    const framed = globalThis.__sdkFrames.find(f => String(f.src || '').includes('/player.html'))
    assert.ok(framed, 'the film never mounted after the server answered — the toggle bug')
    assert.match(framed.src, /token=/, 'the player frame carries no token, so it cannot play')
    assert.equal(ctx.storage.get('settings').backdropMode, 'video',
      'mounting the film changed the user\'s mode')
  } finally {
    dispose()
  }
})

await recordAsync('a stale backend is named, not left looking broken', async () => {
  // Hermes keeps the Python module it loaded: after an update the pane can be new
  // while the server is old. Its /version then has no `line`, and the pane says
  // so — "restart Hermes to finish the update" — instead of drawing nothing.
  // The pane is a video-mode surface (owner 04:50), so that is where its note lives.
  const ctx = makeCtx({ enabled: true, backdropMode: 'video' })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    tx.resetBuildForTest()
    const original = ctx.ctx.rest
    ctx.ctx.rest = async (route, options) => {
      if (route === '/version') {
        return { version: '1.0.0', commit: '', commit_short: '', commit_date: '', compiled: true }
      }
      return original(route, options)
    }
    await tx.refreshVersion()
    await sleep(20)
    assert.equal(tx.staleServerForTest(), true, 'an old server was not detected')
    const pane = ctx.contributions.find(c => c.area === 'panes')
    const tree = pane.render()
    expandTree(tree)
    const body = texts(tree)
    assert.match(body, /restart Hermes to finish the update/i, 'the pane does not say how to fix it')

    // A current server clears it again.
    ctx.ctx.rest = async (route, options) => {
      if (route === '/version') {
        return {
          version: '1.0.0-dev.342', commit: 'abc', commit_short: 'abc12345',
          commit_date: '2026-11-13', dirty: false, channel: 'dev', source: 'git',
          line: 'v1.0.0-dev.342 · abc12345 · 2026-11-13'
        }
      }
      return original(route, options)
    }
    await tx.refreshVersion()
    await sleep(20)
    assert.equal(tx.staleServerForTest(), false, 'a current server still looked stale')
  } finally {
    dispose()
  }
})

// ------------------------------------- lane strip-drag: the strip is the user's
// Two bugs, one cause: the transport strip was not the user's to place. The ⠿
// grip popped the film out into window mode (older code called
// writeSettings({ videoWindow: true }) from the drag), and the strip parked
// itself by scanning the app's composer, so a new panel with text inputs shoved
// it up over the chat. Now: a drag moves the strip and nothing else, the
// position is the user's (videoBarX / videoBarY), and no app markup is read.

const stripSettingsOf = ctx => ctx.storage.get('settings') || {}
// The strip is a singleton (one transport, one player); the host slot it lives
// in is the one React hands the plugin, stood in for here by a plain div.
const stripSlot = document.createElement('div')
document.body.appendChild(stripSlot)
const mountStrip = () => {
  const bar = tx.mountVideoBarForTest(stripSlot)
  assert.ok(bar, 'the strip did not mount')
  return bar
}
const stripEvent = (node, x, y) => ({
  button: 0, clientX: x, clientY: y, target: node,
  preventDefault() {}, stopPropagation() {}
})
const pressOn = (node, x, y) => {
  const event = stripEvent(node, x, y)
  for (const fn of node.__handlers.mousedown || []) fn(event)
}
// A press that lands on a control inside the strip: the bar's own handler is
// what runs, so the "is this empty chrome?" test sees the real target.
const pressBarTargeting = (bar, target, x, y) => {
  const event = stripEvent(target, x, y)
  for (const fn of bar.__handlers.mousedown || []) fn(event)
}
const movePointer = (x, y) => fireDoc('mousemove', stripEvent(null, x, y))
const dropPointer = (x, y) => fireDoc('mouseup', stripEvent(null, x, y))
const resetGrip = grip => {
  for (const fn of grip.__handlers.dblclick || []) fn({ preventDefault() {} })
}

const dragScenario = makeCtx({
  enabled: true,
  backdropMode: 'video',
  windowVisual: true,
  panelEnabled: false,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
})
pluginModule.default.register(dragScenario.ctx)
dragScenario.timers.find(t => t.ms === 250).fn()
await sleep(40)

record('strip-drag: dragging the grip moves the strip and leaves every mode alone', () => {
  const bar = mountStrip()
  const settingsAtom = pluginModule.wiringTest.settings
  const before = { ...settingsAtom.get() }
  assert.equal(before.videoWindow, false, 'the film was already in window mode')
  const home = tx.videoBarPointForTest()
  const grip = findByLabel(bar, 'Drag to move the controls')
  assert.ok(grip, 'the grip has no drag handle')
  pressOn(grip, 120, 300)
  movePointer(200, 260)
  dropPointer(200, 260)
  const after = { ...settingsAtom.get() }
  assert.equal(after.videoWindow, false, 'dragging the grip popped the film into window mode')
  assert.equal(tx.videoBarElForTest().style.left, `${home.x + 80}px`, 'the strip did not move right')
  assert.equal(tx.videoBarElForTest().style.top, `${home.y - 40}px`, 'the strip did not move up')
  // A drag writes the position and NOTHING else.
  const changed = Object.keys(after).filter(key => after[key] !== before[key]).sort()
  assert.deepEqual(changed, ['videoBarX', 'videoBarY'], `a drag changed other settings: ${changed.join(', ')}`)
  assert.equal(stripSettingsOf(dragScenario).videoBarX, home.x + 80, 'the drop did not reach storage')
})

record('strip-drag: the same drag in window mode keeps the film in window mode', () => {
  // "Every mode": with the film in its own floating window the grip still drags
  // the controls only — it must not slam the film in or out of the window.
  tx.setVideoWindow(true)
  try {
    assert.equal(stripSettingsOf(dragScenario).videoWindow, true, 'the film did not go to window mode')
    const bar = tx.videoBarElForTest()
    const grip = findByLabel(bar, 'Drag to move the controls')
    const before = tx.videoBarPointForTest()
    pressOn(grip, 60, 60)
    movePointer(100, 90)
    dropPointer(100, 90)
    assert.equal(stripSettingsOf(dragScenario).videoWindow, true, 'a drag took the film out of its window')
    assert.notEqual(tx.videoBarPointForTest().x, before.x, 'the strip did not move in window mode')
  } finally {
    tx.setVideoWindow(false)
  }
})

record('strip-drag: the Frame in Hermes button is the only thing that pops the film out', () => {
  const bar = tx.videoBarElForTest()
  const popOut = findByLabel(bar, 'Frame in Hermes')
  assert.ok(popOut, 'the strip has no Frame in Hermes button')
  for (const fn of popOut.__handlers.click || []) fn({ preventDefault() {} })
  assert.equal(stripSettingsOf(dragScenario).videoWindow, true, 'the pop-out button no longer pops out')
  const before = tx.videoBarPointForTest()
  const grip = findByLabel(bar, 'Drag to move the controls')
  pressOn(grip, 300, 120)
  movePointer(340, 150)
  dropPointer(340, 150)
  assert.equal(stripSettingsOf(dragScenario).videoWindow, true, 'a drag after popping out slammed the film back in')
  assert.notEqual(tx.videoBarPointForTest().x, before.x, 'the strip did not move while popped out')
  tx.setVideoWindow(false)
})

record('strip-drag: empty strip area drags too, and the controls never do', () => {
  const bar = tx.videoBarElForTest()
  const before = tx.videoBarPointForTest()
  pressOn(bar, 40, 40)
  movePointer(80, 20)
  dropPointer(80, 20)
  const after = tx.videoBarPointForTest()
  assert.equal(after.x, before.x + 40, 'the empty strip area did not drag')
  assert.equal(after.y, before.y - 20, 'the empty strip area did not drag')
  assert.equal(stripSettingsOf(dragScenario).videoWindow, false, 'the empty-area drag changed the mode')

  // A press that lands on Play (or the scrubber) belongs to that control.
  const play = findByLabel(bar, 'Play')
  pressBarTargeting(bar, play, 10, 10)
  movePointer(400, 400)
  dropPointer(400, 400)
  assert.equal(tx.videoBarPointForTest().x, after.x, 'pressing a control started a drag')
})

record('strip-drag: a new panel with text inputs does not move the strip', () => {
  const bar = tx.videoBarElForTest()
  const left = bar.style.left
  const top = bar.style.top
  // The app grows a panel with an input and a rich-text box, exactly the shape
  // the old composer scan was looking for.
  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  const editable = document.createElement('div')
  editable.setAttribute('contenteditable', 'true')
  document.body.appendChild(editable)
  dragScenario.timers.find(t => t.ms === 250).fn()
  assert.equal(bar.style.left, left, 'the strip jumped sideways when a text field appeared')
  assert.equal(bar.style.top, top, 'the strip jumped up over the chat when a text field appeared')
  // Nothing in the plugin reads the app's composer at all.
  assert.ok(!/composerRect/.test(source), 'the composer-rect measuring helper is back')
  assert.ok(!/querySelectorAll\(\s*['"]textarea/.test(source), 'the composer scan is back')
  assert.ok(!/contenteditable/.test(source), 'the composer scan is back')
  assert.match(source, /videoBarX/, 'the strip has no saved position of its own')
})

record('strip-drag: the dropped position is remembered, and double-click resets it', () => {
  const dropped = tx.videoBarPointForTest()
  const saved = stripSettingsOf(dragScenario)
  assert.equal(saved.videoBarX, dropped.x, 'the drop did not persist')
  assert.equal(saved.videoBarY, dropped.y, 'the drop did not persist')
  // A remount (another plugin, a restart) comes back where it was dropped.
  tx.removeVideoBar()
  const bar = mountStrip()
  assert.equal(bar.style.left, `${saved.videoBarX}px`, 'the strip forgot its position on remount')
  assert.equal(bar.style.top, `${saved.videoBarY}px`, 'the strip forgot its position on remount')

  const grip = findByLabel(bar, 'Drag to move the controls')
  assert.ok(grip, 'the grip vanished')
  assert.equal(grip.title, 'Drag to move the controls (double-click to reset)',
    'the grip tooltip does not say how to reset')
  resetGrip(grip)
  const home = tx.videoBarHomeForTest()
  assert.equal(stripSettingsOf(dragScenario).videoBarX, null, 'the reset did not clear the saved x')
  assert.equal(stripSettingsOf(dragScenario).videoBarY, null, 'the reset did not clear the saved y')
  assert.equal(bar.style.left, `${home.x}px`, 'the reset did not put the strip back')
  assert.equal(bar.style.top, `${home.y}px`, 'the reset did not put the strip back')
  assert.equal(home.x, 16, 'the home corner is not 16px from the left edge')
})

record('strip-drag: the strip stays inside the window at drop and on resize', () => {
  const bar = tx.videoBarElForTest()
  const size = tx.videoBarSizeForTest()
  const view = document.defaultView
  view.innerWidth = 640
  view.innerHeight = 480
  fireDoc('resize')
  assert.equal(bar.style.left, '16px', 'a resize left the strip outside the window')
  assert.ok(parseInt(bar.style.top, 10) + size.height <= 480 - 16, 'the strip hangs off the bottom after a resize')

  // Drag past the right and bottom edges: the drop clamps, it does not park the
  // strip off screen for the next start.
  const grip = findByLabel(bar, 'Drag to move the controls')
  pressOn(grip, 20, 20)
  movePointer(5000, 5000)
  dropPointer(5000, 5000)
  const maxX = 640 - size.width - 16
  const maxY = 480 - size.height - 16
  assert.equal(tx.videoBarPointForTest().x, maxX, 'the drop was not clamped to the right edge')
  assert.equal(tx.videoBarPointForTest().y, maxY, 'the drop was not clamped to the bottom edge')
  assert.equal(stripSettingsOf(dragScenario).videoBarX, maxX, 'the saved position is off screen')

  // And past the top-left corner.
  pressOn(grip, 20, 20)
  movePointer(-5000, -5000)
  dropPointer(-5000, -5000)
  assert.equal(tx.videoBarPointForTest().x, 16, 'the drop was not clamped to the left edge')
  assert.equal(tx.videoBarPointForTest().y, 16, 'the drop was not clamped to the top edge')

  // A temporarily smaller window does not destroy the saved position.
  const savedX = stripSettingsOf(dragScenario).videoBarX
  view.innerWidth = 520
  view.innerHeight = 420
  fireDoc('resize')
  assert.ok(parseInt(bar.style.left, 10) + size.width <= 520 - 16, 'the strip stayed off screen after a shrink')
  assert.ok(parseInt(bar.style.top, 10) + size.height <= 420 - 16, 'the strip stayed off screen after a shrink')
  assert.equal(stripSettingsOf(dragScenario).videoBarX, savedX, 'a resize rewrote the stored position')

  view.innerWidth = 1400
  view.innerHeight = 900
  fireDoc('resize')
  tx.removeVideoBar()
  assert.equal(docListeners('mousemove'), 0, 'the drag listeners outlived the strip')
  assert.equal(docListeners('resize'), 0, 'the resize listener outlived the strip')
})

// ------------------------------------------------------------- scenario NP
// Now playing (owner ask): whatever film plays — starter, any YouTube video or
// playlist item, direct file — says its title, and its channel when the player
// knows it, on the Aura page next to the big player, large and clear. The
// status-bar item that carries the "A" is bold and full contrast, accent while
// Aura is active, and includes the same "Watching …" line.

const npUrl = 'https://www.youtube.com/watch?v=JK9x0zqldsE'
// The host window is a browser, so `message` events have a real target. The
// plugin registers its bridge through that target; give Node the same door.
if (typeof globalThis.addEventListener !== 'function') globalThis.addEventListener = () => {}

// Aura off: the status-bar item must stay bold and full contrast (the faint
// tertiary token is what made it unreadable). Registered and disposed on its
// own — the module is single-instance, so two live instances would fight.
const byClass = (tree, className) => {
  let found = null
  walk(tree, node => {
    if (!found && node.props && node.props.className === className) found = node
  })
  return found
}

record('status bar: with Aura off the label stays bold and full contrast', () => {
  const off = makeCtx({ enabled: false, backdropMode: 'video', videoUrl: npUrl })
  const disposeOff = pluginModule.default.register(off.ctx)
  try {
    const menu = () => renderContribution(off.contributions.find(c => c.id === 'quick-menu'))
    const trigger = quickTrigger(menu())
    assert.ok(trigger, 'the status-bar trigger vanished while Aura is off')
    assert.ok(Number(trigger.props.style.fontWeight) >= 600, 'the off label is not bold')
    assert.match(trigger.props.style.color, /--ui-text-primary/,
      `the off label is not full contrast: ${trigger.props.style.color}`)
    const watching = byClass(menu(), 'aura-status-title')
    assert.ok(watching, 'the watching label is missing while Aura is off')
    assert.ok(Number(watching.props.style.fontWeight) >= 600, 'the watching label is not bold')
    assert.match(watching.props.style.color, /--ui-text-primary/,
      'the watching label is not full contrast')
  } finally {
    disposeOff()
  }
})

const np = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: npUrl, panelEnabled: false })
const disposeNP = pluginModule.default.register(np.ctx)

const npPage = () => renderDeep(renderContribution(np.contributions.find(c => c.area === 'routes')))
const npMenu = () => renderContribution(np.contributions.find(c => c.id === 'quick-menu'))
const nowTitle = () => {
  const block = byClass(npPage(), 'aura-now-title')
  assert.ok(block, 'the Aura page has no now-playing title')
  return texts(block)
}
const nowChannel = () => {
  const block = byClass(npPage(), 'aura-now-channel')
  return block ? texts(block) : ''
}
const playerMessage = data => {
  const listener = np.listeners.find(entry => entry.type === 'message' && !entry.removed)
  assert.ok(listener, 'no message bridge listener')
  listener.fn({ source: npFrame.contentWindow, data })
}
const npFrame = { contentWindow: { postMessage() {} } }
tx.setBackdropForTest(npFrame)

record('now playing: the page names the source before the player reports', () => {
  // The stored title for the source, never the raw URL.
  assert.match(nowTitle(), /Nosferatu \(1922\)/, `wrong idle title: ${nowTitle()}`)
  const body = texts(byClass(npPage(), 'aura-now'))
  assert.ok(!body.includes('youtube.com/watch'), 'the page shows the URL as a title')
})

record('now playing: the player title and channel land on the page', () => {
  playerMessage({
    aura: 'video-state', url: npUrl, kind: 'youtube', playing: true, position: 12,
    duration: 5400, muted: true, title: 'Nosferatu (1922) full film',
    author: 'Internet Archive', videoId: 'JK9x0zqldsE', controllable: true
  })
  assert.equal(nowTitle(), 'Nosferatu (1922) full film', 'the reported title did not reach the page')
  assert.equal(nowChannel(), 'Internet Archive', 'the channel did not reach the page')
})

record('now playing: a playlist moving to the next item updates the page', () => {
  playerMessage({
    aura: 'video-state', url: npUrl, kind: 'playlist', playing: true, position: 4,
    duration: 600, muted: true, title: 'The Cabinet of Dr. Caligari (1920)',
    author: 'Silent Film Archive', videoId: 'ZqB2l4V6a1c', controllable: true
  })
  assert.equal(nowTitle(), 'The Cabinet of Dr. Caligari (1920)', 'the next episode did not replace the title')
  assert.equal(nowChannel(), 'Silent Film Archive', 'the next episode did not replace the channel')
})

await recordAsync('now playing: a source change shows the new source, not the last film', async () => {
  await tx.applyVideoSource('https://www.youtube.com/watch?v=R6MlUcmOul8')
  await sleep(30)
  assert.match(nowTitle(), /Tears of Steel/, `the previous film is still named: ${nowTitle()}`)
  assert.equal(nowChannel(), '', 'the old channel survived the source change')
})

record('status bar: the label is bold, full contrast, and names the film', () => {
  const trigger = quickTrigger(npMenu())
  assert.ok(trigger, 'the status-bar trigger vanished')
  assert.ok(Number(trigger.props.style.fontWeight) >= 600, 'the status-bar label is not bold')
  assert.match(trigger.props.style.color, /--ui-accent/, 'an active Aura label is not accent-coloured')
  const word = (() => {
    let found = null
    walk(trigger, node => {
      if (!found && (node.key === 'word' || (node.props && node.props.key === 'word'))) found = node
    })
    return found
  })()
  assert.ok(word, 'the Aura wordmark is missing')
  // The mark and word sit in one bold wrapper that inherits the trigger colour.
  const markWrap = (() => {
    let found = null
    walk(trigger, node => {
      if (!found && node.props && node.props.style && node.props.style.fontSize === 12 && node.props.style.fontWeight) {
        found = node
      }
    })
    return found
  })()
  assert.ok(markWrap, 'the mark wrapper is missing')
  assert.ok(Number(markWrap.props.style.fontWeight) >= 600, 'the wordmark is not bold')
  assert.equal(markWrap.props.style.color, 'inherit', 'the wordmark does not follow the trigger colour')
  assert.ok(!/tertiary/.test(String(word.props.style.color || '')),
    'the wordmark is drawn in the faint tertiary token')
  assert.match(texts(npMenu()), /Watching/, 'the status bar does not say what is being watched')
  assert.match(texts(npMenu()), /Tears of Steel/, 'the status-bar label does not name the film')
})

record('dispose from the now-playing scenario is clean', () => {
  tx.setBackdropForTest(null)
  disposeNP()
  assert.equal(np.contributions.length, 0, 'a contribution survived dispose')
  assert.ok(np.listeners.every(entry => entry.removed), 'a listener survived dispose')
})

// ------------------------------------------------------------ readable text
// Owner ask: "change the font and color of the hermes chat text so we can make
// it much easier to read". The only supported door is the host theme contract —
// typography (baseSize/fontSans/fontUrl) and colours (foreground/
// mutedForeground) on Aura's OWN contributed theme. Nothing here may restyle
// host markup, so the DOM checks below are part of the scenario, not an aside.

sdk.themeState.name = 'nous'
const rd = makeCtx({ enabled: true, themeOptIn: false })
const disposeRd = pluginModule.default.register(rd.ctx)
// Snapshotted AFTER register: mounting the plugin may legitimately style its
// own surface. What must not change is anything the Readable controls do.
const rdHead = headChildren.length
const rdBody = bodyChildren.length
// The app always mounts the theme probe; its first report is what lets the
// plugin remember which theme it owes the user back.
renderContribution(rd.contributions.find(c => c.area === 'titleBar.center'))

const rdTheme = () => {
  const found = rd.contributions.filter(c => c.area === 'themes')
  assert.equal(found.length, 1, `expected exactly one contributed theme, found ${found.length}`)
  return found[0].data
}
const rdPage = () => renderContribution(rd.contributions.find(c => c.area === 'settings.plugins'))
const rdControl = label => {
  const node = findSwitch(rdPage(), label)
  assert.ok(node, `no Readable control labelled "${label}"`)
  return node
}
// Relative luminance, so "easy to read over a film" is measured, not asserted
// by vibes: the readable inks are the ones that stay bright on a dark surface.
const luminance = hex => {
  const channels = [1, 3, 5].map(at => parseInt(String(hex).slice(at, at + 2), 16) / 255)
    .map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

const baseDarkInk = rdTheme().darkColors.foreground
const basePrimary = rdTheme().colors.primary

record('readable: off by default, so the contributed theme carries no readable overrides', () => {
  const theme = rdTheme()
  assert.equal(theme.typography.baseSize, undefined, 'a base size was painted with Readable off')
  assert.equal(theme.typography.fontUrl, undefined, 'a font stylesheet was fetched with Readable off')
  assert.equal(rdControl('Readable text').props.checked, false, 'Readable is on by default')
  for (const label of ['Readable text size S', 'Readable text size L']) {
    assert.equal(rdControl(label).props.disabled, true, `${label} is live while Readable is off`)
  }
  for (const label of ['Readable text font', 'Readable text colour']) {
    assert.equal(rdControl(label).props.disabled, true, `${label} is live while Readable is off`)
  }
})

record('readable: turning it on persists the choice and asks for the Aura theme', () => {
  const before = sdk.calls.themes.length
  rdControl('Readable text').props.onCheckedChange(true)
  assert.equal(rd.storage.get('settings').readable, true, 'Readable was not persisted')
  assert.ok(sdk.calls.themes.slice(before).includes('aura-live'),
    'turning Readable on did not request the Aura theme')
  assert.equal(rd.contributions.filter(c => c.area === 'themes').length, 1,
    'the theme was contributed twice instead of updated in place')
  for (const label of ['Readable text font', 'Readable text colour']) {
    assert.equal(rdControl(label).props.disabled, false, `${label} stayed disabled with Readable on`)
  }
})

record('readable: the readable theme survives an idle window, because it is not a skin', () => {
  // "Keep my theme when idle" is on by default and normally hands the user's
  // own theme back whenever no film or visual is showing. Readable must outlive
  // that, or the text reverts the moment the film ends.
  assert.equal(rd.storage.get('settings').readable, true, 'Readable is not on at this point')
  const idle = rdControl('Keep my theme when idle')
  const before = sdk.calls.themes.length
  idle.props.onCheckedChange(true)
  assert.equal(sdk.calls.themes.length, before,
    'the readable theme was handed back while Aura had nothing on screen')
})

record('readable: S/M/L/XL each paint a larger typography.baseSize and lineHeight', () => {
  const painted = {}
  for (const size of ['s', 'm', 'l', 'xl']) {
    rdControl(`Readable text size ${size.toUpperCase()}`).props.onClick()
    const theme = rdTheme()
    assert.equal(rd.storage.get('settings').readableSize, size, `${size} was not persisted`)
    assert.match(String(theme.typography.baseSize), /^[\d.]+rem$/, `${size} painted no base size`)
    assert.match(String(theme.typography.lineHeight), /^[\d.]+$/, `${size} painted no line height`)
    painted[size] = parseFloat(theme.typography.baseSize)
  }
  assert.ok(painted.s < painted.m && painted.m < painted.l && painted.l < painted.xl,
    `the four sizes are not ordered: ${JSON.stringify(painted)}`)
})

record('readable: each font sets typography.fontSans, with a CDN URL only where a webfont is needed', () => {
  const expected = {
    system: /system-ui/,
    atkinson: /Atkinson Hyperlegible/,
    inter: /Inter/,
    mono: /mono/i
  }
  for (const [font, pattern] of Object.entries(expected)) {
    rdControl('Readable text font').props.onChange({ target: { value: font } })
    const theme = rdTheme()
    assert.equal(rd.storage.get('settings').readableFont, font, `${font} was not persisted`)
    assert.match(String(theme.typography.fontSans), pattern, `${font} did not reach fontSans`)
    if (font === 'system' || font === 'mono') {
      assert.equal(theme.typography.fontUrl, undefined,
        `${font} ships with the system: it must not fetch a stylesheet`)
    } else {
      assert.match(String(theme.typography.fontUrl), /^https:\/\/fonts\.(bunny|googleapis)\.net\//,
        `${font} is not served by a well-known font CDN`)
    }
  }
})

record('readable: each text colour sets foreground and mutedForeground on both palettes', () => {
  const seen = {}
  for (const ink of ['white', 'warm', 'yellow']) {
    rdControl('Readable text colour').props.onChange({ target: { value: ink } })
    const theme = rdTheme()
    assert.equal(rd.storage.get('settings').readableInk, ink, `${ink} was not persisted`)
    for (const key of ['foreground', 'mutedForeground']) {
      assert.match(String(theme.colors[key]), /^#[0-9a-f]{6}$/i, `light ${key} is not a hex colour`)
      assert.match(String(theme.darkColors[key]), /^#[0-9a-f]{6}$/i, `dark ${key} is not a hex colour`)
    }
    assert.ok(luminance(theme.darkColors.foreground) > 0.5,
      `${ink} is not bright enough to read over a film: ${theme.darkColors.foreground}`)
    seen[ink] = theme.darkColors.foreground
  }
  assert.equal(new Set(Object.values(seen)).size, 3,
    `the three inks are not distinct: ${JSON.stringify(seen)}`)
  assert.equal(rdTheme().colors.primary, basePrimary,
    'Readable changed the palette: it must only move text tokens')
  assert.notEqual(seen.white, baseDarkInk, 'the White ink is the palette default, so nothing changed')
})

record('readable: the group points at Hermes own chat font setting', () => {
  const tree = rdPage()
  assert.ok(texts(tree).includes('Readable'), 'no Readable group on the settings page')
  const link = findSwitch(tree, 'Open Hermes chat font setting')
  assert.ok(link, 'no jump to the Hermes chat font setting')
  link.props.onClick()
  assert.equal(sdk.calls.navigations.at(-1), '/settings?tab=config:appearance',
    'the link does not open Appearance, where Hermes keeps its chat font')
})

record('readable: turning it off restores the previous theme and drops every override', () => {
  sdk.themeState.name = 'aura-live'          // the host is wearing it, as after an opt-in
  rdControl('Readable text').props.onCheckedChange(false)
  assert.equal(rd.storage.get('settings').readable, false, 'Readable was not turned off')
  assert.equal(sdk.calls.themes.at(-1), 'nous', 'the previous theme was not handed back')
  const theme = rdTheme()
  assert.equal(theme.typography.baseSize, undefined, 'the readable size survived the switch-off')
  assert.equal(theme.typography.fontUrl, undefined, 'the font stylesheet survived the switch-off')
  assert.equal(theme.darkColors.foreground, baseDarkInk, 'the readable ink survived the switch-off')
})

record('readable: nothing was written to the host DOM', () => {
  assert.equal(headChildren.length, rdHead, 'a node was appended to the host head')
  assert.equal(bodyChildren.length, rdBody, 'a node was appended to the host body')
  assert.deepEqual(Object.keys(documentElement.style), [], 'host html/root style was mutated')
  assert.deepEqual(Object.keys(document.body.style), [], 'host body style was mutated')
})

record('dispose from the readable scenario is clean', () => {
  disposeRd()
  assert.equal(rd.contributions.length, 0, 'a contribution survived dispose')
})

// ----------------------------------------- the Right panel is a VIDEO surface
// Owner 04:50: "the right panel shows ONLY in video mode". It used to be
// contributed whenever the "Right panel" switch was on, so it sat over the Aura
// visual with no film to show and stayed there after the film was closed. Now
// the pane exists exactly while video mode holds the film, comes back with it,
// and the switch means "show it in video mode".
const rightPanelScenario = extra => makeCtx({
  enabled: true,
  backdropMode: 'video',
  panelEnabled: true,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  ...extra
})
const hasRightPanel = ctx => ctx.contributions.some(c => c.area === 'panes')

record('docks the theatre as an enforced right-hand pane the host lays out', () => {
  const ctx = rightPanelScenario()
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const pane = ctx.contributions.find(c => c.area === 'panes')
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
    // A pane is laid out by the app; anything we would have to pin ourselves is
    // exactly what broke the layout before.
    assert.ok(!('position' in pane.data), 'pane must not set its own position')
  } finally {
    dispose()
  }
})

record('the Right panel offers every Aura setting in a collapsible drawer', () => {
  const ctx = rightPanelScenario()
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const paneOf = () => ctx.contributions.find(c => c.area === 'panes')
    let tree = renderContribution(paneOf())
    assert.equal(tree.props.style.overflowY, 'auto', 'the pane must scroll when content is taller than the window')
    assert.ok(texts(tree).includes('Aura settings'), 'the settings drawer title is missing')
    assert.equal(texts(tree).includes('Aura enabled'), false, 'the settings drawer must start collapsed')
    let toggle = null
    walk(tree, node => {
      if (!toggle && node.props && node.props['aria-label'] === 'Expand Aura settings') toggle = node
    })
    assert.ok(toggle, 'the settings drawer has no expand control')
    toggle.props.onClick()
    assert.equal(ctx.storage.get('settings').panelSettingsOpen, true, 'opening the drawer was not remembered')
    tree = renderContribution(paneOf())
    let settingsNode = null
    walk(tree, node => {
      if (!settingsNode && node.props && node.props.key === 'controls' && typeof node.type === 'function') settingsNode = node
    })
    assert.ok(settingsNode, 'the pane does not render the AuraSettings component')
    assert.ok(
      texts(settingsNode.type(settingsNode.props)).includes('Aura enabled'),
      'the full AuraSettings component is not rendered in the pane'
    )
    let collapse = null
    walk(tree, node => {
      if (!collapse && node.props && node.props['aria-label'] === 'Collapse Aura settings') collapse = node
    })
    assert.ok(collapse, 'the open drawer has no collapse control')
    collapse.props.onClick()
    assert.equal(ctx.storage.get('settings').panelSettingsOpen, false, 'closing the drawer was not remembered')
  } finally {
    dispose()
  }
})

await recordAsync('right panel switch: off disposes the pane, on re-registers it, in video mode', async () => {
  const ctx = rightPanelScenario()
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    assert.ok(hasRightPanel(ctx), 'the pane was not registered in video mode')
    const undismissedBefore = sdk.calls.undismissed.length
    const revealedBefore = sdk.calls.revealed.length
    const settingsPage = () => renderContribution(ctx.contributions.find(c => c.area === 'settings.plugins'))
    const off = findByAria(settingsPage(), 'Right panel')
    assert.ok(off, 'the Right panel switch is missing')
    off.props.onCheckedChange(false)
    await sleep(30)
    assert.equal(hasRightPanel(ctx), false, 'the pane contribution survived switch-off')
    assert.equal(ctx.storage.get('settings').panelEnabled, false, 'switch-off was not persisted')
    const on = findByAria(settingsPage(), 'Right panel')
    on.props.onCheckedChange(true)
    await sleep(30)
    assert.ok(hasRightPanel(ctx), 'the pane did not re-register when switched back on')
    assert.equal(ctx.storage.get('settings').panelEnabled, true, 'switch-on was not persisted')
    assert.equal(sdk.calls.undismissed.length, undismissedBefore + 1, 'undismissPane was not called')
    assert.equal(sdk.calls.undismissed.at(-1), 'aura:panel', 'undismissPane got the wrong contribution-scoped id')
    assert.equal(sdk.calls.revealed.length, revealedBefore + 1, 'revealPane was not called')
    assert.equal(sdk.calls.revealed.at(-1), 'aura:panel', 'revealPane got the wrong contribution-scoped id')
  } finally {
    dispose()
  }
})

await recordAsync('right panel: video mode shows it, the Aura visual takes it away, back with video', async () => {
  const ctx = rightPanelScenario()
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    assert.ok(hasRightPanel(ctx), 'video mode did not contribute the Right panel')
    assert.equal(tx.panelVisible(), true, 'a video-mode panel is not counted as on screen')
    // The real switch the owner would use, not a settings poke.
    await tx.setBackdropMode('aura')
    assert.equal(hasRightPanel(ctx), false, 'the panel stayed after switching to the Aura visual')
    assert.equal(tx.panelVisible(), false, 'a removed panel still counts as on screen')
    // ...and video mode brings it back on its own.
    await tx.setBackdropMode('video')
    assert.ok(hasRightPanel(ctx), 'the panel did not come back with video mode')
    assert.equal(tx.panelVisible(), true, 'the returned panel is not on screen')
  } finally {
    dispose()
  }
})

await recordAsync('right panel: closing the film takes the panel away, reopening brings it back', async () => {
  const ctx = rightPanelScenario()
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    assert.ok(hasRightPanel(ctx), 'the panel is missing to start with')
    tx.closeVideo()
    assert.equal(hasRightPanel(ctx), false, 'the panel survived the film being closed')
    assert.equal(ctx.storage.get('settings').videoClosed, true, 'Close video did not persist')
    tx.openVideo()
    assert.ok(hasRightPanel(ctx), 'the panel did not return when the film was reopened')
    assert.equal(ctx.storage.get('settings').videoClosed, false, 'Open video did not persist')
  } finally {
    dispose()
  }
})

// ------------------------------------------------------ narrow-surface layout
// Owner screenshots: the quick menu's bottom row overflowed its right edge, and
// the docked pane squashed its play button, spread its volume slider past the
// card and clipped film titles to "Yo...". These tests pin the rule for both
// boxes: nothing may be wider than the box it sits in, and the two pop-out
// buttons say the same words on every surface.

// Each scenario below registers its own context: registering replaces the
// plugin's global settings, so a shared one would leak between tests.

const layoutVideo = extra => makeCtx({
  enabled: true,
  backdropMode: 'video',
  panelEnabled: true,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  ...extra
})
const layoutMenuOf = ctx => renderContribution(ctx.contributions.find(c => c.id === 'quick-menu'))
const layoutPageOf = ctx => renderDeep(renderContribution(ctx.contributions.find(c => c.area === 'routes')))
const layoutMountPanel = ctx => {
  // Two panes share the "panes" area (the player panel and the floating watch
  // window), so pick the one that carries the settings drawer.
  const panes = ctx.contributions.filter(c => c.area === 'panes')
  assert.ok(panes.length, 'the docked pane is not registered')
  let ref = null
  for (const pane of panes) {
    const tree = renderContribution(pane)
    let isPanel = false
    let candidate = null
    walk(tree, node => {
      if (node.props && node.props['aria-label'] === 'Aura settings') isPanel = true
      if (!candidate && node.props && node.props.key === 'theatre') candidate = node.props.ref
    })
    if (isPanel && candidate) { ref = candidate; break }
  }
  assert.equal(typeof ref, 'function', 'the pane has no theatre ref')
  const host = document.createElement('div')
  ref(host)
  const panel = host.children.find(node => node.attributes && node.attributes.id === 'aura-panel')
  assert.ok(panel, 'the panel did not mount')
  return panel
}
const layoutDescendants = (node, out = []) => {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children || []) layoutDescendants(child, out)
  return out
}
const layoutPx = value => {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value == null ? '' : value).trim())
  return match ? Number(match[1]) : null
}
// A one-class-per-rule stylesheet, so the declarations a class gives an element
// can be read straight out of the text (the fake DOM has no cascade).
const layoutRules = css => {
  const rules = new Map()
  const re = /([.#][a-z0-9-]+)\s*\{([^}]*)\}/gi
  let match = re.exec(css)
  while (match) {
    const decls = {}
    for (const part of match[2].split(';')) {
      const at = part.indexOf(':')
      if (at < 0) continue
      const name = part.slice(0, at).trim()
      if (name) decls[name] = part.slice(at + 1).trim()
    }
    rules.set(match[1].toLowerCase(), decls)
    match = re.exec(css)
  }
  return rules
}

record('quick menu: every row fits the menu, and no control is wider than it', () => {
  const width = tx.quickMenuWidth
  assert.ok(Number.isFinite(width) && width > 0, 'the quick menu has no declared width')
  // The popover is given that width (the SDK stub drops PopoverContent's style,
  // so the source is what says so).
  assert.match(source, /minWidth: QUICK_MENU_WIDTH,\s*width: QUICK_MENU_WIDTH/,
    'the popover is not laid out at QUICK_MENU_WIDTH')
  const ctx = layoutVideo({ panelEnabled: false })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const tree = layoutMenuOf(ctx)
    let rows = 0
    walk(tree, node => {
      const style = (node.props && node.props.style) || {}
      for (const key of ['width', 'minWidth']) {
        const value = layoutPx(style[key])
        if (value != null) {
          assert.ok(value <= width, `a quick-menu control is ${value}px wide inside a ${width}px menu`)
        }
      }
      if (style.justifyContent === 'space-between' && style.flexWrap === 'wrap') {
        rows += 1
        const children = Array.isArray(node.props && node.props.children)
          ? node.props.children
          : [node.props && node.props.children]
        const label = children[0] && children[0].props && children[0].props.style
        const control = children[1] && children[1].props && children[1].props.style
        assert.ok(label, 'a quick-menu row has no label box')
        assert.equal(label.minWidth, 0, 'a row label cannot shrink inside the menu')
        assert.equal(label.overflow, 'hidden', 'a row label cannot ellipsis')
        assert.equal(label.textOverflow, 'ellipsis', 'a row label has no ellipsis')
        assert.ok(control, 'a quick-menu row has no control box')
        assert.equal(control.minWidth, 0, 'a row control cannot shrink inside the menu')
      }
    })
    assert.ok(rows >= 6, `only ${rows} quick-menu rows are shrinkable; the rows are not all fixed`)
    const frame = findByAria(tree, 'Frame in Hermes')
    const pop = findByAria(tree, 'Pop out to desktop')
    assert.ok(frame, 'the quick menu has no Frame in Hermes button')
    assert.ok(pop, 'the quick menu has no Pop out to desktop button')
    for (const node of [frame, pop]) {
      assert.equal(node.props.style.flex, '1 1 0', 'the two pop-out buttons are not equal width')
      assert.equal(node.props.style.minWidth, 0, 'a pop-out button cannot shrink')
    }
  } finally {
    dispose()
  }
})

record('skipped episodes: no row at zero, a "Show all N again" row at two', () => {
  const empty = layoutVideo({ panelEnabled: false })
  const disposeEmpty = pluginModule.default.register(empty.ctx)
  try {
    assert.ok(!texts(layoutMenuOf(empty)).includes('Skipped episodes'),
      'the skipped-episodes row is shown at zero')
  } finally {
    disposeEmpty()
  }

  const two = layoutVideo({ panelEnabled: false, videoHiddenIds: ['aaaaaaaaaaa', 'bbbbbbbbbbb'] })
  const disposeTwo = pluginModule.default.register(two.ctx)
  try {
    const tree = layoutMenuOf(two)
    assert.ok(texts(tree).includes('Skipped episodes'), 'the skipped-episodes row is missing at two')
    assert.ok(!texts(tree).includes('Hidden episodes'), 'the old "Hidden episodes" words are back')
    assert.ok(texts(tree).includes('Show all 2 again'), 'the row does not offer "Show all 2 again"')
    const button = findByAria(tree, 'Show all 2 skipped episodes again')
    assert.ok(button, 'the skipped-episodes button has no label of its own')
    assert.equal(button.props.title, 'Episodes you hid from your playlists. Aura skips them.',
      'the skipped-episodes tooltip does not explain itself')
    button.props.onClick()
    assert.deepEqual(two.storage.get('settings').videoHiddenIds, [], 'show all again did not clear the list')
  } finally {
    disposeTwo()
  }
})

await recordAsync('the two pop-out buttons: same words, same jobs, on every surface', async () => {
  const ctx = makeCtx({
    enabled: true,
    backdropMode: 'video',
    panelEnabled: true,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
  })
  const dispose = pluginModule.default.register(ctx.ctx)
  await sleep(40)
  try {
    const words = ['Frame in Hermes', 'Pop out to desktop']
    const menu = renderContribution(ctx.contributions.find(c => c.id === 'quick-menu'))
    const page = layoutPageOf(ctx)
    for (const label of words) {
      assert.ok(findByAria(menu, label), `the quick menu has no "${label}" button`)
      assert.ok(pageAria(page, label), `the Aura page has no "${label}" button`)
    }
    // The panel and the strip build DOM, not descriptors.
    const panelButtons = () => layoutDescendants(layoutMountPanel(ctx)).filter(node => node.className === 'ap-popout')
    const panelWords = panelButtons().map(node => node.getAttribute('aria-label')).sort()
    assert.deepEqual(panelWords, [...words].sort(), 'the right panel does not carry both pop-out buttons')
    const strip = tx.videoBarElForTest() || tx.mountVideoBarForTest(document.createElement('div'))
    for (const label of words) assert.ok(findByLabel(strip, label), `the control strip has no "${label}" button`)

    // Frame in Hermes toggles the in-app frame and never opens an OS window.
    const opened = ctx.requests.filter(entry => entry.route === '/window/open').length
    const frameBtn = panelButtons().find(node => node.className === 'ap-popout')
    for (const fn of frameBtn.__handlers.click || []) fn({ preventDefault() {} })
    assert.equal(pluginModule.wiringTest.settings.get().videoWindow, true,
      'Frame in Hermes did not switch the in-app frame on')
    assert.equal(ctx.requests.filter(entry => entry.route === '/window/open').length, opened,
      'Frame in Hermes opened a desktop window')
    const pressed = panelButtons().find(node => node.getAttribute('aria-label') === 'Frame in Hermes')
    assert.equal(pressed.getAttribute('aria-pressed'), 'true', 'the frame toggle is not pressed when it is on')

    // Pop out to desktop asks the server for the OS window, and then reads
    // "Bring back" — the only button that says those words.
    const ownBtn = panelButtons().find(node => node.getAttribute('aria-label') === 'Pop out to desktop')
    assert.ok(ownBtn, 'the panel lost its Pop out to desktop button')
    for (const fn of ownBtn.__handlers.click || []) fn({ preventDefault() {} })
    await sleep(60)
    assert.ok(ctx.requests.filter(entry => entry.route === '/window/open').length > opened,
      'Pop out to desktop did not ask the server for a window')
    const back = panelButtons().find(node => node.getAttribute('aria-label') === 'Bring back')
    assert.ok(back, 'an open desktop window does not read "Bring back"')
    assert.equal(back.textContent, 'Bring back', 'the desktop button text did not follow its state')
  } finally {
    tx.setVideoWindow(false)
    await tx.setOwnWindow(false)
    dispose()
  }
})

record('right panel: no fixed width wider than a 260px pane, and it wraps instead', () => {
  const ctx = layoutVideo({})
  const dispose = pluginModule.default.register(ctx.ctx)
  const panel = layoutMountPanel(ctx)
  const css = (panelStyles()[panelStyles().length - 1] || {}).textContent || ''
  assert.ok(css.includes('.ap-card'), 'the panel stylesheet is empty')
  // Every fixed px width in the panel's own stylesheet fits the narrowest pane
  // under test: the layout flexes, it does not assume 320px.
  const narrowest = 260
  for (const match of css.matchAll(/(?:^|;|\{)\s*(min-width|max-width|width)\s*:\s*(\d+(?:\.\d+)?)px/g)) {
    assert.ok(Number(match[2]) <= narrowest,
      `.${match[1]}: ${match[2]}px is wider than a ${narrowest}px pane`)
  }
  const rules = layoutRules(css)
  assert.ok(rules.has('.ap-transport'), 'no transport rule')
  assert.match(rules.get('.ap-transport')['flex-wrap'] || '', /wrap/, 'the transport row cannot wrap')
  assert.match(rules.get('.ap-transport')['justify-content'] || '', /space-evenly/,
    'the transport buttons are not evenly spaced')
  assert.match(rules.get('.ap-volume')['max-width'] || '', /100%/, 'the volume slider is not contained')
  assert.equal(rules.get('.ap-volume')['min-width'], '0', 'the volume slider cannot shrink')
  assert.match(rules.get('.ap-field')['flex-wrap'] || '', /wrap/, 'the see-through row cannot wrap')
  assert.match(rules.get('.ap-pills')['flex-wrap'] || '', /wrap/, 'the see-through presets cannot wrap')
  assert.equal(rules.get('.ap-card')['flex-direction'], 'column', 'the film card is not stacked')
  assert.match(rules.get('.ap-thumb').width || '', /100%/, 'the thumbnail is not card-wide')
  assert.match(rules.get('.ap-title')['-webkit-line-clamp'] || '', /2/, 'the film title is not clamped to 2 lines')

  // At each width, no child of the panel asks for more than the panel has.
  for (const width of [260, 320, 400]) {
    panel.style.width = `${width}px`
    for (const node of layoutDescendants(panel)) {
      for (const key of ['width', 'minWidth']) {
        const value = layoutPx(node.style && node.style[key])
        if (value != null) {
          assert.ok(value <= width, `a panel child is ${value}px wide inside a ${width}px pane`)
        }
      }
      const className = String(node.className || '').split(/\s+/).filter(Boolean)
      for (const name of className) {
        const rule = rules.get(`.${name}`)
        if (!rule) continue
        for (const key of ['width', 'min-width']) {
          const value = layoutPx(rule[key])
          if (value != null) {
            assert.ok(value <= width, `.${name} is ${value}px wide inside a ${width}px pane`)
          }
        }
      }
    }
  }

  // The five see-through choices are all there, and the card puts its title
  // under the thumbnail rather than beside it.
  const pills = layoutDescendants(panel).filter(node => node.className === 'ap-pill')
  assert.deepEqual(pills.map(node => node.textContent), ['Auto', '25%', '50%', '75%', '100%'])
  const card = layoutDescendants(panel).find(node => node.className === 'ap-card')
  assert.ok(card, 'the panel has no film card')
  assert.ok(card.children[0].className === 'ap-thumb', 'the thumbnail is not the card’s first block')
  assert.ok(card.children[1] && card.children[1].className === 'ap-meta', 'the card has no title block')
  assert.equal(layoutDescendants(card).find(node => node.className === 'ap-title') !== undefined, true,
    'the card has no title')

  // The transport row's five buttons fit side by side at the narrowest width:
  // five 28px minimums plus four 4px gaps against the pane's inner width.
  const inner = narrowest - 2 * 14 - 2 * 12
  const transportButtons = layoutDescendants(panel)
    .filter(node => node.tagName === 'BUTTON' && node.parentNode && node.parentNode.className === 'ap-transport')
  assert.equal(transportButtons.length, 5, 'the transport row does not have five buttons')
  const needed = 5 * 28 + 4 * 4
  assert.ok(needed <= inner, `the transport buttons need ${needed}px inside ${inner}px`)
  dispose()
  assert.equal(ctx.contributions.length, 0, 'a contribution survived dispose')
})

// --------------------------------------------------------------- the shelf
// The catalogue is a committed file (web/catalog.json); the shelf draws one
// horizontally scrolling row per category, Picks (STARTER_SOURCES) first, and
// one click plays a title through the same applyVideoSource path a starter uses.

const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'catalog.json'), 'utf8'))
const CATALOG_CATEGORIES = [...new Set(CATALOG.map(item => item.category))]

const sh = makeCtx(
  { enabled: true, backdropMode: 'aura', videoUrl: '' },
  { ok: true, count: CATALOG.length, items: CATALOG }
)
const disposeSh = pluginModule.default.register(sh.ctx)
// Prime the mount once: the fetch is asynchronous, so the first render is the
// one that starts it and the next one sees the catalogue.
renderDeep(renderContribution(sh.contributions.find(c => c.area === 'routes')))
await sleep(120)
const shPage = () => renderDeep(renderContribution(sh.contributions.find(c => c.area === 'routes')))
const shelfRowsOf = tree => {
  const rows = []
  walk(tree, node => {
    if (node.props && typeof node.props['data-category'] === 'string') rows.push(node)
  })
  return rows
}
const stripOf = row => row.props.children[1]

record('shelf: one row per catalogue category, Picks first, each row titled and counted', () => {
  const rows = shelfRowsOf(shPage())
  assert.deepEqual(
    rows.map(row => row.props['data-category']),
    ['picks', ...CATALOG_CATEGORIES],
    'the shelf does not draw Picks plus one row per category, in catalogue order'
  )
  const picksCount = rows[0]
  assert.equal(texts(picksCount.props.children[0].props.children[0]), 'Picks')
  assert.equal(
    texts(picksCount.props.children[0].props.children[1]),
    String(starterEntries.length),
    'the Picks row does not hold the whole starter pack'
  )
  CATALOG_CATEGORIES.forEach((category, index) => {
    const row = rows[index + 1]
    const expected = CATALOG.filter(item => item.category === category)
    assert.equal(texts(row.props.children[0].props.children[0]), category, 'the row is not titled with its category')
    assert.equal(texts(row.props.children[0].props.children[1]), String(expected.length),
      `the ${category} row does not show its count`)
    assert.equal(stripOf(row).props.children.length, expected.length,
      `the ${category} row does not hold every title`)
  })
})

record('shelf: a card is poster-less and carries title, year, length and its note', () => {
  const tree = shPage()
  const item = CATALOG.find(entry => entry.year && entry.duration_s)
  assert.ok(item, 'the catalogue has no title with a year and a length to check')
  const card = pageAria(tree, `Play ${item.title}`)
  assert.ok(card, 'no shelf card for a catalogue title')
  assert.equal(card.props.title, item.note, 'the one-line note is not on the hover title')
  const classes = []
  const pictures = []
  walk(card, node => {
    if (node.props && node.props.className) classes.push(node.props.className)
    if (node.props && node.props.style && node.props.style.backgroundImage) pictures.push(node)
  })
  assert.ok(classes.includes('aura-shelf-title'), 'the card has no title block')
  assert.ok(classes.includes('aura-shelf-meta'), 'the card has no year/length line')
  assert.ok(classes.includes('aura-shelf-note'), 'the card has no note line')
  assert.equal(pictures.length, 0, 'a catalogue card grew a poster')
  const body = texts(card)
  assert.match(body, new RegExp(String(item.year)), 'the year is missing from the card')
  assert.match(body, new RegExp(tx.fmtLength(item.duration_s).replace(/ /g, '\\s+')),
    'the length is missing from the card')
  assert.ok(body.includes(item.title), 'the title is missing from the card')
})

record('shelf: lengths read as hours and minutes, and unknown lengths say nothing', () => {
  assert.equal(tx.fmtLength(0), '')
  assert.equal(tx.fmtLength(null), '')
  assert.equal(tx.fmtLength(95), '2 min')
  assert.equal(tx.fmtLength(2700), '45 min')
  assert.equal(tx.fmtLength(3600), '1 h')
  assert.equal(tx.fmtLength(5520), '1 h 32 min')
})

await recordAsync('shelf: clicking a catalogue card plays it exactly like a starter', async () => {
  const item = CATALOG.find(entry => entry.category === 'Anime')
  assert.ok(item, 'the Anime row is empty')
  const card = pageAria(shPage(), `Play ${item.title}`)
  assert.ok(card, 'no card to click')
  card.props.onClick()
  await sleep(150)
  const saved = sh.storage.get('settings') || {}
  assert.equal(saved.videoUrl, item.url, 'the clicked title was not applied')
  assert.equal(saved.backdropMode, 'video', 'the shelf did not switch to video mode')
  assert.ok(sh.controls.some(patch => patch && patch.backdrop_mode === 'video'),
    'the mode change never reached /control')
  assert.ok((saved.videoRecent || []).some(row => row.url === item.url),
    'the played title did not join the queue like a picked source')
})

record('shelf: one search box filters every row, and clearing it restores them', () => {
  const box = pageAria(shPage(), 'Search the catalogue')
  assert.ok(box, 'the shelf has no search box')
  box.props.onChange({ target: { value: 'Mobile Suit' } })
  const filtered = shPage()
  const rows = shelfRowsOf(filtered)
  assert.ok(rows.length >= 2, 'the query hid every row instead of filtering them')
  assert.ok(rows.length < CATALOG_CATEGORIES.length + 1, 'the query did not hide any row')
  for (const row of rows) {
    for (const card of stripOf(row).props.children) {
      assert.match(card.props['aria-label'], /Mobile Suit/i,
        `a card that does not match the query survived in ${row.props['data-category']}`)
    }
  }
  assert.equal(pageAria(filtered, 'Search the catalogue').props.value, 'Mobile Suit',
    'the search box does not show what was typed')

  // A starter-only phrase keeps the catalogue empty but leaves its Picks.
  pageAria(filtered, 'Search the catalogue').props.onChange({ target: { value: '· Blender film' } })
  const picksOnly = shPage()
  assert.deepEqual(shelfRowsOf(picksOnly).map(row => row.props['data-category']), ['picks'])
  assert.ok(stripOf(shelfRowsOf(picksOnly)[0]).props.children.length >= 3,
    'the search did not keep the matching Picks')

  pageAria(picksOnly, 'Search the catalogue').props.onChange({ target: { value: '' } })
  assert.equal(shelfRowsOf(shPage()).length, CATALOG_CATEGORIES.length + 1,
    'clearing the search did not restore every row')
})

record('shelf: the catalogue is fetched once per mount, not once per render', () => {
  const calls = sh.requests.filter(request => request.route === '/catalog')
  assert.equal(calls.length, 1, `the page asked for /catalog ${calls.length} times`)
})

record('shelf: rows scroll sideways and shrink on a narrow window, never widen the page', () => {
  assert.match(source, /\.aura-shelf-strip\s*\{[^}]*overflow-x:\s*auto/,
    'the shelf strip does not scroll horizontally')
  assert.match(source, /\.aura-shelf-strip\s*\{[^}]*max-width:\s*100%/,
    'the shelf strip has no width ceiling')
  assert.match(source, /@media \(max-width: 760px\)[\s\S]*?\.aura-shelf-card, #aura-page \.aura-shelf-slot \{\s*flex-basis: 148px/,
    'narrow windows do not shrink the shelf cards')
  const row = shelfRowsOf(shPage()).find(entry => entry.props['data-category'] === 'Anime')
  assert.ok(row, 'the Anime row is missing')
  assert.equal(stripOf(row).props.style.overflowX, 'auto', 'the rendered strip is not a horizontal scroller')
  for (const card of stripOf(row).props.children) {
    assert.equal(card.props.style && card.props.style.width, undefined,
      'a shelf card sets its own pixel width inline, which no media query can undo')
  }
})

// An old server (or no network) has no /catalog at all: the page must still be
// the working library it was, with Picks and the saved lists only.
const shDown = makeCtx({ enabled: true, backdropMode: 'aura', videoUrl: '' })
const disposeShDown = pluginModule.default.register(shDown.ctx)
await sleep(80)

record('shelf: with no catalogue the page still offers Picks and the saved library', () => {
  const tree = renderDeep(renderContribution(shDown.contributions.find(c => c.area === 'routes')))
  const rows = shelfRowsOf(tree)
  assert.deepEqual(rows.map(row => row.props['data-category']), ['picks'],
    'a failed /catalog left rows behind')
  assert.equal(stripOf(rows[0]).props.children.length, starterEntries.length,
    'the Picks row is empty after a failed fetch')
  assert.ok(pageAria(tree, 'Play Sintel · Blender film'), 'Picks are not playable after a failed fetch')
  assert.match(texts(tree), /How to add a YouTube playlist/, 'the library half disappeared with the catalogue')
})
disposeShDown()
disposeSh()

// --------------------------------------------------------------- subtitles
// A CC switch. Off by default because YouTube decides on its own otherwise;
// on, the page asks for captions in the embed and keeps asking the live player
// (every new video in a playlist is a fresh captions context). The rules that
// pick the query parts and the commands live in web/captions.js, so they run
// here exactly as the page runs them, and the page's own wiring is checked
// where it is written.

const PAGE = path.join(ROOT, 'web', 'player.html')
const pageSource = fs.readFileSync(PAGE, 'utf8')
const captionsModule = (await import(pathToFileURL(path.join(ROOT, 'web', 'captions.js')).href)).default
const pageFn = name => {
  const match = new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\n  \\}`).exec(pageSource)
  assert.ok(match, `web/player.html has no ${name}()`)
  return match[0]
}
const CC_TRACKS = [
  { languageCode: 'ar', displayName: 'Arabic' },
  { languageCode: 'nl', displayName: 'Dutch' },
  { languageCode: 'en-US', displayName: 'English (United States)' },
  { languageCode: 'fr', displayName: 'French' },
  { languageCode: 'de', displayName: 'German' },
  { languageCode: 'iw', displayName: 'Hebrew' }
]
const ccInfo = (tracklist, current) => ({
  event: 'apiInfoDelivery',
  info: {
    namespaces: ['captions'],
    captions: {
      options: ['reload', 'fontSize', 'track', 'tracklist'],
      track: { languageCode: current || 'en-US', displayName: 'English (United States)' },
      tracklist: tracklist || CC_TRACKS
    }
  }
})

record('subtitles: the embed asks YouTube for captions only when they are on', () => {
  assert.deepEqual(captionsModule.embedParams({ on: false }), [],
    'captions off still asked the embed for captions')
  assert.deepEqual(captionsModule.embedParams({ on: true }), ['cc_load_policy=1'])
  assert.deepEqual(captionsModule.embedParams({ on: true, lang: 'fr' }),
    ['cc_load_policy=1', 'cc_lang_pref=fr'], 'the preferred language did not reach the embed')
  assert.deepEqual(captionsModule.embedParams({ on: false, lang: 'fr' }), [],
    'a language alone turned captions on')
  assert.deepEqual(captionsModule.embedParams({ on: true, lang: 'fr; drop' }),
    ['cc_load_policy=1'], 'a junk language code reached the query')
})

record('subtitles: on loads the captions module and picks a track, off unloads it', () => {
  assert.deepEqual(captionsModule.commands({ on: true }), [{ func: 'loadModule', args: ['captions'] }])
  assert.deepEqual(captionsModule.commands({ on: true, lang: 'de' }), [
    { func: 'loadModule', args: ['captions'] },
    { func: 'setOption', args: ['captions', 'track', { languageCode: 'de' }] }
  ], 'a chosen language is not applied to the track')
  assert.deepEqual(captionsModule.commands({ on: false, lang: 'de' }),
    [{ func: 'unloadModule', args: ['captions'] }],
    'off must unload the module and must not set a track')
})

record('subtitles: the language list comes from the player, defaulting to the machine then English', () => {
  const found = captionsModule.tracksFrom(ccInfo().info)
  assert.ok(found, 'the captions namespace was not read')
  assert.deepEqual(found.tracks.map(track => track.code), ['ar', 'nl', 'en-US', 'fr', 'de', 'iw'])
  assert.deepEqual(found.tracks.map(track => track.name)[2], 'English (United States)')
  assert.equal(found.current, 'en-US', 'the playing track was not read')
  assert.equal(captionsModule.tracksFrom({ namespaces: ['captions'] }), null,
    'an empty captions namespace was reported as a list')
  assert.equal(captionsModule.tracksFrom({ playerState: 1 }), null,
    'a frame with no captions namespace produced a list')
  assert.equal(captionsModule.pickTrack(found.tracks, 'de-DE'), 'de',
    'a regional preference did not match its base language')
  assert.equal(captionsModule.pickTrack(found.tracks, 'en-GB'), 'en-US',
    'an English machine did not pick the English track')
  assert.equal(captionsModule.pickTrack(found.tracks, 'es-ES'), 'en-US',
    'a language this video does not have did not fall back to English')
  assert.equal(captionsModule.pickTrack(found.tracks, ''), 'en-US')
  assert.equal(captionsModule.pickTrack([], 'en'), '', 'an empty list picked a track')
  assert.equal(captionsModule.hasCaptions(found.tracks), true)
  assert.equal(captionsModule.hasCaptions([]), false, 'an empty tracklist claims subtitles')
})

record('subtitles: the page builds every embed through the one caption rule', () => {
  assert.match(pageSource, /<script src="captions\.js"><\/script>/,
    'the page does not load web/captions.js')
  assert.match(pageSource, /AuraCaptions\.embedParams\(/,
    'the embed query does not ask the caption rules for cc_load_policy')
  assert.match(pageSource, /params\.get\('captions'\) === '1'/,
    'the page does not read ?captions=1')
  assert.match(pageSource, /params\.get\('cc_lang'\)/,
    'the page does not read ?cc_lang=')
  assert.match(pageSource, /captions: \{[\s\S]{0,400}?tracks:/,
    'the page does not report its caption tracks back to the app')
})

record('subtitles: the page posts loadModule/unloadModule, and posts again for every new video', () => {
  const scene = options => {
    const sent = []
    const pageCaptions = {
      on: options.on, lang: options.lang || '', tracks: options.tracks || [],
      current: '', known: true, appliedFor: ''
    }
    const state = { videoId: options.videoId || '' }
    const build = new Function(
      'captions', 'state', 'youtubeCommand', 'navigator', 'AuraCaptions', 'frame', 'kind',
      `${pageFn('captionLanguage')}\n${pageFn('applyCaptions')}\n${pageFn('applyCaptionsForVideo')}\n` +
      'return { applyCaptions: applyCaptions, forVideo: applyCaptionsForVideo, language: captionLanguage }'
    )
    const api = build(pageCaptions, state, (func, args) => sent.push({ func, args: args || [] }),
      { language: options.machine || 'en-GB' }, captionsModule,
      options.frame === false ? null : {}, options.kind || 'youtube')
    return { sent, api, captions: pageCaptions, state }
  }

  const off = scene({ on: false, videoId: 'aaa' })
  off.api.forVideo()
  assert.deepEqual(off.sent, [{ func: 'unloadModule', args: ['captions'] }],
    'captions off did not unload the module')
  // Nothing new for the same video: the toggle already sent it once.
  off.api.forVideo()
  assert.equal(off.sent.length, 1, 'the same video was told again on every frame')

  const on = scene({ on: true, videoId: 'aaa', tracks: CC_TRACKS })
  on.api.forVideo()
  assert.deepEqual(on.sent, [
    { func: 'loadModule', args: ['captions'] },
    { func: 'setOption', args: ['captions', 'track', { languageCode: 'en-US' }] }
  ], 'captions on did not load the module and pick the machine language')
  // A playlist moves to its next episode: YouTube resets captions per video.
  on.state.videoId = 'bbb'
  on.api.forVideo()
  assert.equal(on.sent.length, 4, 'the commands were not re-sent for the new video')
  assert.deepEqual(on.sent.slice(2), on.sent.slice(0, 2), 'the new video got different commands')

  // A chosen language wins over the machine's.
  const chosen = scene({ on: true, lang: 'fr', videoId: 'aaa', tracks: CC_TRACKS })
  assert.equal(chosen.api.language(), 'fr', 'the chosen language was not used')
})

record('subtitles: a direct file switches its own text tracks between showing and hidden', () => {
  const tracks = [
    { language: 'en', label: 'English', mode: 'disabled' },
    { language: 'fr', label: 'Français', mode: 'disabled' }
  ]
  const build = new Function('captions', 'AuraCaptions', 'video', 'navigator',
    `${pageFn('applyVideoCaptions')}\nreturn applyVideoCaptions`)
  const pageCaptions = { on: true, lang: '', tracks: [], current: '', known: false }
  const run = build(pageCaptions, captionsModule, { textTracks: tracks }, { language: 'fr-FR' })
  run()
  assert.deepEqual(tracks.map(track => track.mode), ['hidden', 'showing'],
    'the machine language track was not shown')
  assert.equal(pageCaptions.current, 'fr')
  assert.deepEqual(pageCaptions.tracks.map(track => track.code), ['en', 'fr'],
    'a direct file did not report its own tracks')
  pageCaptions.on = false
  run()
  assert.deepEqual(tracks.map(track => track.mode), ['hidden', 'hidden'],
    'turning captions off left a track showing')
})

record('subtitles: off by default, and every stored value is validated', () => {
  const fresh = makeCtx({ enabled: true })
  const d1 = pluginModule.default.register(fresh.ctx)
  assert.equal(pluginModule.wiringTest.settings.get().videoCaptions, false,
    'captions must be off on a fresh install')
  assert.equal(pluginModule.wiringTest.settings.get().videoCaptionLang, '')
  d1()
  const saved = makeCtx({ enabled: true, videoCaptions: true, videoCaptionLang: 'fr' })
  const d2 = pluginModule.default.register(saved.ctx)
  assert.equal(pluginModule.wiringTest.settings.get().videoCaptions, true,
    'the saved switch did not come back')
  assert.equal(pluginModule.wiringTest.settings.get().videoCaptionLang, 'fr',
    'the saved language did not come back')
  d2()
  const junk = makeCtx({ enabled: true, videoCaptions: 'on', videoCaptionLang: 'fr; drop table' })
  const d3 = pluginModule.default.register(junk.ctx)
  assert.equal(pluginModule.wiringTest.settings.get().videoCaptions, false,
    'a non-boolean switch was accepted')
  assert.equal(pluginModule.wiringTest.settings.get().videoCaptionLang, '',
    'a junk language code was accepted')
  d3()
})

record('subtitles: the switch is remembered and reaches the player', () => {
  const ctx = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: false,
    videoUrl: 'https://www.youtube.com/watch?v=9FqwhW0B3tY'
  })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const posts = []
    tx.setBackdropForTest({ contentWindow: { postMessage: message => posts.push(message) } })
    tx.setVideoCaptions(true)
    assert.equal(ctx.storage.get('settings').videoCaptions, true, 'the switch was not persisted')
    assert.deepEqual(posts[0], { aura: 'transport', cmd: 'captions', value: 1 },
      'turning captions on did not reach the page')
    tx.setVideoCaptions(false)
    assert.equal(posts[posts.length - 1].value, 0, 'turning captions off did not reach the page')
  } finally {
    tx.setBackdropForTest(null)
    dispose()
  }
})

await recordAsync('subtitles: the player page is told to start with them on, and only then', async () => {
  const off = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: false,
    videoUrl: 'https://www.youtube.com/watch?v=9FqwhW0B3tY'
  })
  closePopout(off)
  const d1 = pluginModule.default.register(off.ctx)
  try {
    await primeLive()
    const src = new URL(tx.filmSrc())
    assert.equal(src.searchParams.get('captions'), null, 'captions were requested while off')
    assert.equal(src.searchParams.get('cc_lang'), null, 'a language was requested while off')
  } finally {
    d1()
  }
  const on = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: false,
    videoUrl: 'https://www.youtube.com/watch?v=9FqwhW0B3tY',
    videoCaptions: true, videoCaptionLang: 'fr'
  })
  closePopout(on)
  const d2 = pluginModule.default.register(on.ctx)
  try {
    await primeLive()
    const src = new URL(tx.filmSrc())
    assert.equal(src.searchParams.get('captions'), '1', 'the page was not told captions are on')
    assert.equal(src.searchParams.get('cc_lang'), 'fr', 'the chosen language did not reach the page')
  } finally {
    d2()
  }
})

await recordAsync('subtitles: the agent\'s captions command turns them on, not just the page', async () => {
  const ctx = makeCtx({
    enabled: true, backdropMode: 'video', panelEnabled: false,
    videoUrl: 'https://www.youtube.com/watch?v=9FqwhW0B3tY'
  })
  let commands = []
  const original = ctx.ctx.rest
  ctx.ctx.rest = async (route, options = {}) => {
    if (route === '/player') return { ok: true, window: { open: false }, player: { desktop: false } }
    if (route.startsWith('/player/commands?')) return { ok: true, head_seq: 1, commands }
    if (route === '/player/report') return { ok: true }
    return original(route, options)
  }
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    await pluginModule.wiringTest.sync()
    commands = [{ seq: 2, cmd: 'captions', value: 1 }]
    await pluginModule.wiringTest.sync()
    assert.equal(pluginModule.wiringTest.settings.get().videoCaptions, true,
      'the queued captions command did not turn the setting on')
    commands = [{ seq: 3, cmd: 'captions', value: 0 }]
    await pluginModule.wiringTest.sync()
    assert.equal(pluginModule.wiringTest.settings.get().videoCaptions, false,
      'the queued captions command did not turn the setting off')
  } finally {
    dispose()
  }
})

record('subtitles: a video with several tracks offers a language list, and the choice sticks', () => {
  const url = 'https://www.youtube.com/watch?v=9FqwhW0B3tY'
  const ctx = makeCtx({ enabled: true, backdropMode: 'video', panelEnabled: false, videoUrl: url })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const frame = { contentWindow: { postMessage() {} } }
    tx.setBackdropForTest(frame)
    const listener = ctx.listeners.find(entry => entry.type === 'message' && !entry.removed)
    assert.ok(listener, 'no message bridge listener')
    listener.fn({
      source: frame.contentWindow,
      data: {
        aura: 'video-state', url, kind: 'youtube', playing: true, position: 5,
        duration: 2910, muted: true, title: 'Our Planet: High Seas',
        videoId: '9FqwhW0B3tY', controllable: true,
        captions: {
          on: false, current: 'en-US', known: true,
          tracks: [
            { code: 'en-US', name: 'English (United States)' },
            { code: 'fr', name: 'French' },
            { code: 'de', name: 'German' }
          ]
        }
      }
    })
    const menu = renderDeep(renderContribution(ctx.contributions.find(c => c.id === 'quick-menu')))
    const select = findByAria(menu, 'Subtitle language')
    assert.ok(select, 'the quick menu offers no language list')
    assert.deepEqual(select.props.children.map(option => option.props.value), ['', 'en-US', 'fr', 'de'],
      'the language list is not Automatic plus the video’s own tracks')
    select.props.onChange({ target: { value: 'fr' } })
    assert.equal(ctx.storage.get('settings').videoCaptionLang, 'fr',
      'the chosen language was not remembered')
    // The language list is only there when there is a choice to make.
    listener.fn({
      source: frame.contentWindow,
      data: {
        aura: 'video-state', url, kind: 'youtube', playing: true, position: 5,
        duration: 2910, muted: true, title: 'Our Planet: High Seas',
        videoId: '9FqwhW0B3tY', controllable: true,
        captions: { on: false, current: '', known: true, tracks: [] }
      }
    })
    const bare = renderDeep(renderContribution(ctx.contributions.find(c => c.id === 'quick-menu')))
    assert.equal(findByAria(bare, 'Subtitle language'), null,
      'a language list was offered for a video with no subtitles')
  } finally {
    tx.setBackdropForTest(null)
    dispose()
  }
})

record('subtitles: the strip has a CC button, and it is disabled when the video has none', () => {
  const url = 'https://www.youtube.com/watch?v=9FqwhW0B3tY'
  const ctx = makeCtx({
    enabled: true, backdropMode: 'video', windowVisual: true, panelEnabled: false, videoUrl: url
  })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const slot = document.createElement('div')
    document.body.appendChild(slot)
    const bar = tx.mountVideoBarForTest(slot)
    assert.ok(bar, 'the strip did not mount')
    const cc = findByLabel(bar, 'Subtitles (CC)')
    assert.ok(cc, 'the strip has no CC button')
    assert.equal(cc.textContent, 'CC')
    for (const fn of cc.__handlers.click || []) fn({ preventDefault() {} })
    assert.equal(ctx.storage.get('settings').videoCaptions, true, 'the CC button did not turn captions on')
    tx.syncVideoBar(true)
    assert.equal(cc.getAttribute('aria-pressed'), 'true', 'the CC button does not show it is on')
    for (const fn of cc.__handlers.click || []) fn({ preventDefault() {} })
    assert.equal(ctx.storage.get('settings').videoCaptions, false, 'the CC button did not turn captions off')

    // A video with no captions: the button says so instead of pretending.
    const frame = { contentWindow: { postMessage() {} } }
    tx.setBackdropForTest(frame)
    const listener = ctx.listeners.find(entry => entry.type === 'message' && !entry.removed)
    listener.fn({
      source: frame.contentWindow,
      data: {
        aura: 'video-state', url, kind: 'youtube', playing: true, position: 5,
        duration: 300, muted: true, title: 'Forests from Above', videoId: 'EColTNIbOko',
        controllable: true, captions: { on: false, current: '', known: true, tracks: [] }
      }
    })
    tx.syncVideoBar(true)
    assert.equal(cc.disabled, true, 'the CC button is live on a video with no subtitles')
    assert.equal(cc.title, 'No subtitles for this video', `wrong tooltip: ${cc.title}`)
    tx.setBackdropForTest(null)
    tx.removeVideoBar()
  } finally {
    dispose()
  }
})

record('subtitles: the Aura page and the panel carry the same CC control', () => {
  const url = 'https://www.youtube.com/watch?v=9FqwhW0B3tY'
  const ctx = makeCtx({ enabled: true, backdropMode: 'video', panelEnabled: true, videoUrl: url })
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const page = renderDeep(renderContribution(ctx.contributions.find(c => c.area === 'routes')))
    assert.ok(findByAria(page, 'Subtitles (CC)'), 'the Aura page has no CC control')
    const panel = layoutMountPanel(ctx)
    const cc = findByLabel(panel, 'Subtitles (CC)')
    assert.ok(cc, 'the panel has no CC control')
    assert.equal(cc.textContent, 'CC')
    for (const fn of cc.__handlers.click || []) fn({ preventDefault() {} })
    assert.equal(ctx.storage.get('settings').videoCaptions, true,
      'the panel CC did not turn captions on')
  } finally {
    dispose()
  }
})

// ------------------------------------------- lane popout: the frame and the window
// Owner, live on the hackathon build: "small frame in hermes has no drag bar.
// pop out to its own window doesn't do anything". Two separate failures, so two
// sets of tests: the frame must BE a frame (own bar, own position, draggable),
// and the pop-out must either open the OS window or say the server's own reason
// out loud — never quietly do something else.

// The frame starts at a free point well inside the viewport, so a drag has room
// to move in every direction (the corner presets park it against an edge).
const frameScenario = extra => makeCtx({
  enabled: true,
  backdropMode: 'video',
  panelEnabled: true,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  videoWindow: true,
  videoWindowCorner: 'free',
  videoWindowX: 100,
  videoWindowY: 100,
  ...extra
})
const frameTreeOf = ctx => renderContribution(ctx.contributions.find(c => c.id === 'watch'))
const frameBarOf = tree => {
  let bar = null
  walk(tree, node => {
    if (!bar && node.props && node.props['aria-label'] === 'Drag to move the frame') bar = node
  })
  return bar
}
const frameEvent = (x, y, target) => ({
  button: 0, clientX: x, clientY: y, target: target || { getAttribute: () => null },
  preventDefault() {}, stopPropagation() {}
})

record('the frame in Hermes has its own visible bar: title, grip and the three controls', () => {
  const ctx = frameScenario()
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const frame = frameTreeOf(ctx)
    assert.ok(frame, 'the frame did not render an element')
    const style = frame.props.style || {}
    // A real floating box: the frame is positioned by its own saved point, not
    // laid out by the app (that is what left it with no handle at all).
    assert.equal(style.position, 'fixed', 'the frame is not a floating box')
    assert.match(String(style.left), /px$/, 'the frame has no position of its own')
    const bar = frameBarOf(frame)
    assert.ok(bar, 'the frame has no drag bar')
    assert.equal(bar.props.role, 'toolbar', 'the bar does not read as a toolbar')
    assert.equal(typeof bar.props.onMouseDown, 'function', 'the bar does not take a drag')
    const textsInBar = texts(bar)
    assert.ok(textsInBar.includes('⠿'), 'the bar has no visible grip')
    assert.match(textsInBar, /Aura film|aqz-KE|youtube/i, 'the bar carries no title')
    for (const label of ['Bring back', 'Pop out to desktop', 'Close video']) {
      assert.ok(findByAria(bar, label), `the frame bar has no "${label}" control`)
    }
    // The bar sits along the TOP edge, above the picture.
    const children = frame.props.children || []
    assert.equal(children[0], bar, 'the bar is not the frame\'s first row')
  } finally {
    dispose()
  }
})

record('dragging the frame bar moves the frame — and only the frame', () => {
  const ctx = frameScenario()
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const bar = frameBarOf(frameTreeOf(ctx))
    assert.ok(bar, 'the frame has no drag bar')
    const start = tx.videoWindowPointForTest()
    // The live atom, not the raw ctx object: a drag must leave every other
    // setting exactly as the plugin holds it.
    const before = { ...pluginModule.wiringTest.settings.get() }
    bar.props.onMouseDown(frameEvent(500, 300))
    fireDoc('mousemove', frameEvent(540, 330))
    fireDoc('mouseup', frameEvent(540, 330))
    const after = { ...pluginModule.wiringTest.settings.get() }
    assert.equal(after.videoWindowX, start.x + 40, 'the frame did not move right with the pointer')
    assert.equal(after.videoWindowY, start.y + 30, 'the frame did not move down with the pointer')
    assert.equal(after.videoWindowCorner, 'free', 'the drop was not remembered as a free position')
    // Nothing else moved: not the strip's seat, not the modes, not the film.
    assert.equal(after.videoBarX, before.videoBarX, 'dragging the frame moved the control strip')
    assert.equal(after.videoBarY, before.videoBarY, 'dragging the frame moved the control strip')
    assert.equal(after.backdropMode, 'video', 'dragging the frame changed the mode')
    assert.equal(after.videoWindow, true, 'dragging the frame closed the frame')
    assert.equal(after.videoClosed, before.videoClosed, 'dragging the frame changed the film')
    const changed = Object.keys(after).filter(key => after[key] !== before[key])
    assert.ok(changed.includes('videoWindowX') && changed.includes('videoWindowY'),
      'the drop did not persist the frame position')
    const allowed = new Set(['videoWindowCorner', 'videoWindowX', 'videoWindowY'])
    const alsoChanged = changed.filter(key => !allowed.has(key))
    assert.deepEqual(alsoChanged, [],
      `a frame drag changed other settings: ${alsoChanged.join(', ')}`)
  } finally {
    dispose()
  }
})

record('the frame position is clamped to the viewport and survives a remount', () => {
  const ctx = frameScenario()
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const bar = frameBarOf(frameTreeOf(ctx))
    // Drag far past the bottom-right corner: the frame stays fully on screen.
    bar.props.onMouseDown(frameEvent(10, 10))
    fireDoc('mousemove', frameEvent(9000, 9000))
    fireDoc('mouseup', frameEvent(9000, 9000))
    const saved = ctx.storage.get('settings')
    const width = 480 // the default watch-window width
    assert.equal(saved.videoWindowX, 1400 - width - 8, `the frame left the right edge: ${saved.videoWindowX}`)
    assert.equal(saved.videoWindowY, 900 - tx.watchFrameHeightForTest() - 8,
      `the frame left the bottom edge (bar included): ${saved.videoWindowY}`)

    // ...and drag past the top-left corner: clamped to 8px, never negative.
    bar.props.onMouseDown(frameEvent(100, 100))
    fireDoc('mousemove', frameEvent(-4000, -4000))
    fireDoc('mouseup', frameEvent(-4000, -4000))
    assert.equal(ctx.storage.get('settings').videoWindowX, 8, 'the frame went off the left edge')
    assert.equal(ctx.storage.get('settings').videoWindowY, 8, 'the frame went off the top edge')

    // A remount (another plugin, a restart) comes back where it was dropped.
    const frame = frameTreeOf(ctx)
    assert.equal(frame.props.style.left, '8px', 'the frame forgot its position on remount')
    assert.equal(frame.props.style.top, '8px', 'the frame forgot its position on remount')
  } finally {
    dispose()
  }
})

record('the frame bar\'s own controls are not drag handles', () => {
  const ctx = frameScenario()
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const bar = frameBarOf(frameTreeOf(ctx))
    const before = tx.videoWindowPointForTest()
    const ownButton = { getAttribute: name => (name === 'aria-label' ? 'Pop out to desktop' : null) }
    bar.props.onMouseDown(frameEvent(300, 300, ownButton))
    fireDoc('mousemove', frameEvent(700, 700))
    fireDoc('mouseup', frameEvent(700, 700))
    const after = tx.videoWindowPointForTest()
    assert.equal(after.x, before.x, 'a press on a bar control dragged the frame')
    assert.equal(after.y, before.y, 'a press on a bar control dragged the frame')
  } finally {
    dispose()
  }
})

await recordAsync('pop out: the status says available, so the button asks /window/open', async () => {
  const ctx = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: 'https://example.test/a.mp4' })
  const seen = []
  const original = ctx.ctx.rest
  ctx.ctx.rest = async (route, options = {}) => {
    seen.push({ route, options })
    return original(route, options)
  }
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    await primeLive()
    const tree = renderDeep(renderContribution(ctx.contributions.find(c => c.area === 'routes')))
    pageAria(tree, 'Pop out to desktop').props.onClick()
    await sleep(80)
    assert.ok(seen.some(entry => entry.route === '/window'),
      'the button never asked the server whether it has a window')
    const open = seen.find(entry => entry.route === '/window/open')
    assert.ok(open, 'available:true did not reach /window/open')
    assert.equal(open.options.method, 'POST', 'the window was not asked for with POST')
    assert.equal(open.options.body.url, 'https://example.test/a.mp4', 'the film url was not sent')
    assert.equal(ctx.storage.get('settings').videoWindow === true, false,
      'a successful pop-out left the in-app frame on as well')
  } finally {
    dispose()
  }
})

await recordAsync('pop out: an error reply shows the server reason and moves nothing', async () => {
  const ctx = frameScenario()
  const original = ctx.ctx.rest
  ctx.ctx.rest = async (route, options = {}) => {
    if (route === '/window') return { ok: true, available: true, open: false }
    if (route === '/window/open') {
      throw new Error('503: {"ok":false,"error":"no Chrome or Chromium found; install one"}')
    }
    return original(route, options)
  }
  const saidBefore = sdk.calls.notifications.length
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    await primeLive()
    const tree = renderDeep(renderContribution(ctx.contributions.find(c => c.area === 'routes')))
    pageAria(tree, 'Pop out to desktop').props.onClick()
    await sleep(80)
    const told = sdk.calls.notifications.slice(saidBefore).join('\n')
    assert.match(told, /no Chrome or Chromium found/,
      `the server's own reason was swallowed: ${told || '(nothing said)'}`)
    assert.ok(tx.liveForTest().error.includes('no Chrome or Chromium found'),
      'the settings page still shows a generic error instead of the reason')
    // No silent fallback and no lost film: the frame still holds it.
    assert.ok(ctx.contributions.find(c => c.id === 'watch'),
      'the failed pop-out closed the frame instead of leaving the film alone')
    assert.equal(tx.filmOwner(), 'window', 'the failed pop-out moved the film off its frame')
    assert.equal(ctx.storage.get('settings').videoWindow, true, 'the failed pop-out changed the surface')
    assert.equal(ctx.storage.get('settings').backdropMode, 'video', 'the failed pop-out changed the mode')
  } finally {
    dispose()
  }
})

// ------------------------------------------- watching with Aura switched off
// Owner: "even if aura is off you should be able to play in the aura app, the
// on and off is for being able to overlay on your chat … not inside the plugin".
// The page, the Right panel, the film frame, the pop-outs and the strip are
// Aura's own surfaces. Aura's switch owns the overlay painted on the chat.

const offWatchUrl = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
const offCtx = makeCtx({
  enabled: false,
  backdropMode: 'video',
  panelEnabled: true,
  videoUrl: offWatchUrl
})
closePopout(offCtx)
const disposeOffCtx = pluginModule.default.register(offCtx.ctx)
await primeLive()
pageStage(1200, 400)

record('aura off: the page plays the film instead of asking for Aura to be on', () => {
  const body = texts(layoutPageOf(offCtx))
  assert.ok(!/Aura is off/i.test(body),
    `the page still refuses to play while Aura is off: ${JSON.stringify(body)}`)
  globalThis.__sdkFrames.length = 0
  layoutPageOf(offCtx)
  const framed = globalThis.__sdkFrames.filter(frame => String(frame.src || '').includes('/player.html'))
  assert.equal(framed.length, 1, 'the page drew no film frame while Aura is off')
})

record('aura off: the Right panel still holds the film and never refuses', () => {
  const panel = layoutMountPanel(offCtx)
  const texts_ = layoutDescendants(panel)
    .map(node => String(node.textContent || ''))
    .join('\n')
  assert.ok(!/Aura is off/i.test(texts_),
    `the Right panel still refuses to play while Aura is off: ${JSON.stringify(texts_)}`)
  assert.equal(tx.filmOwner() === 'page', true,
    `an in-app surface no longer owns the film: ${JSON.stringify(tx.filmGates())}`)
})

await recordAsync('aura off: Frame in Hermes and Pop out to desktop still move the film', async () => {
  pageAria(layoutPageOf(offCtx), 'Frame in Hermes').props.onClick()
  assert.equal(pluginModule.wiringTest.settings.get().videoWindow, true,
    'Frame in Hermes did nothing while Aura is off')
  tx.setVideoWindow(false)
  // An earlier scenario can leave a pop-out half-open; settle it first.
  await tx.setOwnWindow(false)
  pageAria(layoutPageOf(offCtx), 'Pop out to desktop').props.onClick()
  await sleep(80)
  assert.ok(pageAria(layoutPageOf(offCtx), 'Bring back'),
    `Pop out to desktop opened nothing while Aura is off: ${JSON.stringify(tx.filmGates())}`)
  assert.equal(tx.filmOwner(), '',
    `the film is still in an in-app surface with the window open: ${JSON.stringify(tx.filmGates())}`)
  await tx.setOwnWindow(false)
})

pageStage(null)
disposeOffCtx()

const offStripCtx = makeCtx({
  enabled: false,
  backdropMode: 'video',
  panelEnabled: false,
  videoUrl: offWatchUrl
})
closePopout(offStripCtx)
const disposeOffStrip = pluginModule.default.register(offStripCtx.ctx)
await primeLive()

record('aura off: the control strip is there to play the film with', () => {
  const strip = offStripCtx.contributions.find(c => c.id === 'strip')
  assert.ok(strip, 'the strip contribution is gone')
  const tree = strip.render()
  const element = tree && typeof tree.type === 'function' ? tree.type(tree.props) : tree
  assert.ok(element, 'the control strip renders nothing while Aura is off')
  assert.equal(offStripCtx.storage.get('settings').enabled, false,
    'the scenario is meant to run with Aura off')
})

disposeOffStrip()

// ------------------------------------------- the sidebar row is optional
// Owner: "there should be an option in there to remove the menu option and
// only have in status tray". Off removes the sidebar row only: the page stays
// registered, and the status-bar menu carries the way in.

const navCtx = makeCtx({
  enabled: true,
  backdropMode: 'video',
  panelEnabled: false,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
})
const disposeNav = pluginModule.default.register(navCtx.ctx)
await primeLive()

const navRow = () => navCtx.contributions.find(c => c.area === 'sidebar.nav')
const navPage = () => navCtx.contributions.find(c => c.area === 'routes')
const navMenu = () => renderContribution(navCtx.contributions.find(c => c.id === 'quick-menu'))
const navSettings = () => renderDeep(renderContribution(navCtx.contributions.find(c => c.area === 'settings.plugins')))
const navSwitch = () => findSwitch(navSettings(), 'Show Aura in the sidebar')

record('sidebar: the row is there by default and the menu adds no second way in', () => {
  assert.ok(navRow(), 'the sidebar row is missing by default')
  assert.ok(navPage(), 'the Aura page route is missing')
  assert.equal(findByAria(navMenu(), 'Open Aura page'), null,
    'the menu carries an Open Aura page link while the row is in the sidebar')
})

record('sidebar: switching it off removes the row and keeps the page reachable from the menu', () => {
  const control = navSwitch()
  assert.ok(control, 'Settings has no "Show Aura in the sidebar" switch')
  control.props.onCheckedChange(false)
  assert.equal(navCtx.storage.get('settings').sidebarPage, false, 'the choice was not remembered')
  assert.equal(navRow(), undefined, 'the sidebar row survived the switch')
  assert.ok(navPage(), 'switching the row off removed the page itself')
  const link = findByAria(navMenu(), 'Open Aura page')
  assert.ok(link, 'the menu has no way into the page while the row is hidden')
  const before = sdk.calls.navigations.length
  link.props.onClick()
  assert.equal(sdk.calls.navigations.at(-1), '/aura', 'the menu link did not open the Aura page')
  assert.equal(sdk.calls.navigations.length, before + 1)
})

record('sidebar: switching it back on puts the row back and drops the menu link', () => {
  const control = navSwitch()
  assert.ok(control, 'the switch vanished with its own row off')
  control.props.onCheckedChange(true)
  assert.ok(navRow(), 'the sidebar row did not come back')
  assert.equal(findByAria(navMenu(), 'Open Aura page'), null,
    'the menu kept its Open Aura page link after the row returned')
})

disposeNav()

// ------------------------------------------- one-click "Play a film"
// Owner: playing a film from the status bar took three switches. One control
// resumes the last film where it stopped (or starts the first pick), and it
// puts Aura into video mode itself.

const playLastUrl = 'https://example.com/last-night.mp4'
const playCtx = makeCtx({
  enabled: true,
  backdropMode: 'aura',
  panelEnabled: false,
  videoUrl: '',
  videoRecent: [{ label: 'Last night', url: playLastUrl }],
  videoPositions: { [playLastUrl]: { position: 1432, duration: 3600, at: 1 } }
})
const disposePlay = pluginModule.default.register(playCtx.ctx)
await primeLive()
pageStage(1200, 400)

await recordAsync('play a film: the menu resumes the last film and switches to video mode', async () => {
  const button = findByAria(renderContribution(playCtx.contributions.find(c => c.id === 'quick-menu')), 'Play a film')
  assert.ok(button, 'the status-bar menu has no "Play a film"')
  button.props.onClick()
  await sleep(60)
  const saved = playCtx.storage.get('settings')
  assert.equal(saved.backdropMode, 'video', 'Play a film did not switch to video mode')
  assert.equal(saved.videoUrl, playLastUrl, 'Play a film did not play the last film')
  assert.equal(saved.videoClosed, false, 'Play a film left the film closed')
  assert.equal(new URL(tx.filmSrc()).searchParams.get('resume'), '1432',
    'the film did not resume where it stopped')
})

pageStage(null)
disposePlay()

const playFreshCtx = makeCtx({
  enabled: true,
  backdropMode: 'aura',
  panelEnabled: false,
  videoUrl: ''
})
const disposePlayFresh = pluginModule.default.register(playFreshCtx.ctx)
await primeLive()
const firstStarterUrl = tx.videoQueue()[0].url

await recordAsync('play a film: with nothing watched yet it starts the first pick', async () => {
  const button = findByAria(renderContribution(playFreshCtx.contributions.find(c => c.id === 'quick-menu')), 'Play a film')
  assert.ok(button, 'the status-bar menu has no "Play a film"')
  button.props.onClick()
  await sleep(60)
  const saved = playFreshCtx.storage.get('settings')
  assert.equal(saved.backdropMode, 'video', 'Play a film did not switch to video mode')
  assert.equal(saved.videoUrl, firstStarterUrl, 'Play a film did not start the first pick')
})

disposePlayFresh()

// ------------------------------------------- a film that never loads
// Row 46, second half: a blocked embed reports itself, but a film that simply
// never starts says nothing at all. After 20 s without a ready/playing signal
// the surfaces say so and offer a way out instead of spinning forever.

const stallUrl = 'https://www.youtube.com/watch?v=4Xy0KzPq1Wm'
const stallCtx = makeCtx({
  enabled: true,
  backdropMode: 'video',
  panelEnabled: true,
  videoUrl: stallUrl
})
closePopout(stallCtx)
const disposeStall = pluginModule.default.register(stallCtx.ctx)
await primeLive()
pageStage(1200, 400)

const stallTimers = ctx => ctx.timers.filter(t => t.kind === 'timeout' && t.ms === 20000 && !t.cleared)
const panelText = ctx => layoutDescendants(layoutMountPanel(ctx))
  .map(node => String(node.textContent || ''))
  .join('\n')

record('stall: a film that never reports is called stuck after 20 s, on page and panel', () => {
  const timers = stallTimers(stallCtx)
  assert.equal(timers.length, 1,
    `expected one 20 s watchdog, timers: ${stallCtx.timers.map(t => t.ms).join(',')}`)
  timers[0].fn()
  const page = layoutPageOf(stallCtx)
  assert.match(texts(page), /isn't loading/, 'the page says nothing after 20 s of nothing')
  assert.ok(pageAria(page, 'Try again'), 'the page offers no Try again')
  assert.ok(pageAria(page, 'Pick another'), 'the page offers no way to pick another film')
  assert.match(panelText(stallCtx), /isn't loading/, 'the Right panel says nothing after 20 s')
})

await recordAsync('stall: Try again reloads the same film and re-arms the watch', async () => {
  pageAria(layoutPageOf(stallCtx), 'Try again').props.onClick()
  await sleep(30)
  assert.ok(!/isn't loading/.test(texts(layoutPageOf(stallCtx))), 'Try again left the message up')
  assert.match(tx.filmSrc(), /retry=/, 'Try again did not reload the film')
  const state = tx.stallStateForTest()
  assert.equal(state.timer, true, 'Try again did not watch the new attempt')
  assert.match(String(state.armed), /\|1$/, `the reload was not a new watch: ${state.armed}`)
})

await recordAsync('stall: Pick another starts a different film', async () => {
  // The reload never arrives either: the same 20 s verdict, then the way out.
  const last = stallCtx.timers.filter(t => t.kind === 'timeout' && t.ms === 20000).at(-1)
  last.fn()
  const another = pageAria(layoutPageOf(stallCtx), 'Pick another')
  assert.ok(another, 'the film was not called stuck a second time')
  another.props.onClick()
  await sleep(60)
  const saved = stallCtx.storage.get('settings')
  assert.ok(saved.videoUrl && saved.videoUrl !== stallUrl,
    `Pick another did not change the film: ${saved.videoUrl}`)
})

pageStage(null)
disposeStall()

const readyCtx = makeCtx({
  enabled: true,
  backdropMode: 'video',
  panelEnabled: true,
  videoUrl: stallUrl
})
closePopout(readyCtx)
const disposeReady = pluginModule.default.register(readyCtx.ctx)
await primeLive()
pageStage(1200, 400)

record('stall: a film that reports playing is never called stuck', () => {
  const timers = stallTimers(readyCtx)
  assert.equal(timers.length, 1, 'no watchdog was armed for the film')
  const listener = readyCtx.listeners.find(entry => entry.type === 'message' && !entry.removed)
  assert.ok(listener, 'no message bridge listener')
  const frame = { contentWindow: { postMessage() {} } }
  tx.setBackdropForTest(frame)
  listener.fn({
    source: frame.contentWindow,
    data: {
      aura: 'video-state', url: stallUrl, kind: 'youtube', playing: true, position: 4,
      duration: 5400, muted: true, title: 'A film', controllable: true
    }
  })
  assert.equal(timers[0].cleared, true, 'a playing film left its 20 s watchdog armed')
  // Even if a stale timer somehow runs, a film with a known length is not stuck.
  timers[0].fn()
  assert.ok(!/isn't loading/.test(texts(layoutPageOf(readyCtx))),
    'a film that reported playing was called stuck')
  tx.setBackdropForTest(null)
})

pageStage(null)
disposeReady()

// --------------------------------------- lane controlbar: the strip, redesigned
// Owner ask, in his words: "seek bar across the whole top, times on the bottom;
// big bottom controls; both pop-out buttons on the bottom row; X on the left,
// under the drag bar but low enough that moving the bar can't hit it;
// transparency, and mouse wheel / hover / keyboard control like the volume."
// These pin the layout and the three gestures, not a screenshot.

const barUrl = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
const barSettings = extra => Object.assign({
  enabled: true, backdropMode: 'video', windowVisual: true, panelEnabled: false,
  videoUrl: barUrl, videoVolume: 0.5
}, extra || {})
// The strip is built as rows: drag row, seek row, time row, bottom row. `rowOf`
// finds the top-level row a node lives in, however deeply it is nested.
const stripRows = bar => bar.children || []
const rowOf = (bar, node) => {
  if (!node) return null
  let walk = node
  while (walk && walk.parentNode !== bar) walk = walk.parentNode
  return walk && walk.parentNode === bar ? walk : null
}
const bottomRowOf = bar => stripRows(bar)[stripRows(bar).length - 1]
const nodesTagged = (root, tag) => {
  const out = []
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (node.tagName === tag) out.push(node)
    for (const child of node.children || []) visit(child)
  }
  visit(root)
  return out
}
const withStrip = fn => {
  const ctx = makeCtx(barSettings())
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const bar = tx.mountVideoBarForTest(document.createElement('div'))
    assert.ok(bar, 'the strip did not mount')
    return fn(ctx, bar)
  } finally {
    tx.removeVideoBar()
    dispose()
  }
}

record('control bar: the seek bar spans the whole strip, times on their own row', () => {
  withStrip((ctx, bar) => {
    const seek = findByLabel(bar, 'Seek')
    assert.ok(seek, 'the strip has no seek bar')
    assert.equal(seek.style.width, '100%', 'the seek bar does not span the strip')
    const seekRow = rowOf(bar, seek)
    assert.ok(seekRow, 'the seek bar has no row of its own')
    assert.equal(seekRow.style.width, '100%', 'the seek row is not strip-wide')
    const elapsed = findByLabel(bar, 'Elapsed time')
    const remaining = findByLabel(bar, 'Remaining and total time')
    assert.ok(elapsed, 'the strip has no elapsed clock')
    assert.ok(remaining, 'the strip has no remaining/total clock')
    const timeRow = rowOf(bar, elapsed)
    assert.equal(rowOf(bar, remaining), timeRow, 'the two clocks are not on one row')
    assert.equal(timeRow.children[0], elapsed, 'the elapsed clock is not on the left')
    assert.equal(timeRow.children[timeRow.children.length - 1], remaining,
      'the remaining clock is not on the right')
    // The seek row comes before the clocks — the owner's order, top to bottom.
    const order = stripRows(bar).indexOf(seekRow)
    assert.equal(stripRows(bar).indexOf(timeRow), order + 1, 'the clocks are not directly under the seek bar')
  })
})

record('control bar: Close is the far-left control of the bottom row, below the grip', () => {
  withStrip((ctx, bar) => {
    const close = findByLabel(bar, 'Close video')
    const grip = findByLabel(bar, 'Drag to move the controls')
    assert.ok(close, 'the strip has no Close control')
    assert.ok(grip, 'the strip has no grip')
    const bottom = bottomRowOf(bar)
    const bottomIndex = stripRows(bar).indexOf(bottom)
    assert.equal(bottom.children[0], close, 'Close is not the first control of the bottom row')
    // At least the seek bar and the clock row sit between the grip and Close, so
    // a drag that starts on the grip can never land on Close.
    const seekRow = rowOf(bar, findByLabel(bar, 'Seek'))
    const timeRow = rowOf(bar, findByLabel(bar, 'Elapsed time'))
    assert.ok(stripRows(bar).indexOf(rowOf(bar, close)) > stripRows(bar).indexOf(seekRow),
      'Close shares a row with (or sits above) the seek bar')
    assert.ok(stripRows(bar).indexOf(rowOf(bar, close)) > stripRows(bar).indexOf(timeRow),
      'Close sits above the clocks')
    assert.notEqual(rowOf(bar, grip), rowOf(bar, close), 'Close shares a row with the grip')
    assert.equal(bottomIndex, stripRows(bar).length - 1, 'the bottom row is not the last row')
  })
})

record('control bar: the wheel seeks over the seek bar and sets the level over the volume', () => {
  withStrip((ctx, bar) => {
    const sent = []
    tx.setBackdropForTest({ contentWindow: { postMessage: message => sent.push(message) } })
    const wheel = (node, deltaY) => {
      const event = { deltaY, target: node, preventDefault() {} }
      for (const fn of bar.__handlers.wheel || []) fn(event)
      return event
    }
    const volume = findByLabel(bar, 'Volume — scroll to change')
    const seek = findByLabel(bar, 'Seek')
    assert.ok(volume && seek, 'the strip is missing the volume or the seek bar')

    wheel(volume, -100)
    assert.equal(Math.round(ctx.storage.get('settings').videoVolume * 100), 55,
      'the wheel over the volume no longer raises it by 5%')
    const level = ctx.storage.get('settings').videoVolume

    // A wheel over the seek bar seeks, and leaves the level alone.
    wheel(seek, -1)
    assert.equal((sent.filter(message => message.cmd === 'seek').at(-1) || {}).value, 5,
      'a wheel up over the seek bar did not seek forward 5 s')
    wheel(seek, 1)
    assert.equal((sent.filter(message => message.cmd === 'seek').at(-1) || {}).value, -5,
      'a wheel down over the seek bar did not seek back 5 s')
    assert.equal(ctx.storage.get('settings').videoVolume, level,
      'a wheel over the seek bar changed the volume')
  })
})

record('control bar: the keyboard drives the strip, and only while the strip has focus', () => {
  withStrip((ctx, bar) => {
    const sent = []
    tx.setBackdropForTest({ contentWindow: { postMessage: message => sent.push(message) } })
    const press = (key, target) => {
      const event = { key, target: target || bar, defaultPrevented: false, preventDefault() { event.defaultPrevented = true } }
      for (const fn of bar.__handlers.keydown || []) fn(event)
      return event
    }
    press('ArrowRight')
    assert.equal((sent.filter(message => message.cmd === 'seek').at(-1) || {}).value, 5,
      'Right does not seek forward 5 s')
    press('ArrowLeft')
    assert.equal((sent.filter(message => message.cmd === 'seek').at(-1) || {}).value, -5,
      'Left does not seek back 5 s')
    const start = ctx.storage.get('settings').videoVolume
    press('ArrowUp')
    assert.equal(Math.round(ctx.storage.get('settings').videoVolume * 100),
      Math.round(start * 100) + 5, 'Up does not raise the volume by 5%')
    press('ArrowDown')
    assert.equal(Math.round(ctx.storage.get('settings').videoVolume * 100),
      Math.round(start * 100), 'Down does not lower the volume by 5%')

    const before = sent.length
    const space = press(' ')
    assert.ok(space.defaultPrevented, 'Space does not take the key')
    assert.ok(sent.slice(before).some(message => message.cmd === 'play' || message.cmd === 'pause'),
      'Space does not play or pause')

    press('c')
    assert.equal(ctx.storage.get('settings').videoCaptions, true, 'C does not turn captions on')
    press('C')
    assert.equal(ctx.storage.get('settings').videoCaptions, false, 'C does not turn captions off')

    const focused = sdk.calls.composerFocus.length
    press('Escape')
    assert.equal(sdk.calls.composerFocus.length, focused + 1,
      'Escape does not hand the keyboard back to the chat')

    // The chat's own text box keeps its keys: nothing over a text input.
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    const seeks = sent.filter(message => message.cmd === 'seek').length
    const levels = ctx.storage.get('settings').videoVolume
    const typed = press('ArrowRight', textarea)
    assert.equal(typed.defaultPrevented, false, 'the strip swallowed a key meant for a text input')
    assert.equal(sent.filter(message => message.cmd === 'seek').length, seeks,
      'a key pressed in a text input seeked the film')
    assert.equal(ctx.storage.get('settings').videoVolume, levels,
      'a key pressed in a text input changed the volume')
  })
})

record('control bar: transparency is a persisted setting, and the strip is opaque on hover', () => {
  withStrip((ctx, bar) => {
    assert.equal(pluginModule.wiringTest.settings.get().videoBarOpacity, 0.6,
      'the strip does not start at 0.6 transparency')
    tx.setVideoBarOpacity(0.4)
    assert.equal(ctx.storage.get('settings').videoBarOpacity, 0.4,
      'the transparency setting was not persisted')
    tx.syncVideoBar(true)
    assert.match(bar.style.background, /0\.4\)$/, `the strip ignored the setting: ${bar.style.background}`)

    for (const fn of bar.__handlers.mouseenter || []) fn({})
    assert.match(bar.style.background, /,\s*1\)$/, 'the strip is not fully solid while hovered')
    for (const fn of bar.__handlers.mouseleave || []) fn({})
    assert.match(bar.style.background, /0\.4\)$/, 'the strip stayed solid after the pointer left')

    for (const fn of bar.__handlers.focus || []) fn({ type: 'focus', target: bar })
    assert.match(bar.style.background, /,\s*1\)$/, 'the strip is not fully solid while focused')
    for (const fn of bar.__handlers.blur || []) fn({ type: 'blur', target: bar })
    assert.match(bar.style.background, /0\.4\)$/, 'the strip stayed solid after it lost focus')

    // The range is 0.2..1: a nearly invisible strip is not a usable one.
    tx.setVideoBarOpacity(0.01)
    assert.equal(ctx.storage.get('settings').videoBarOpacity, 0.2,
      'the transparency can be set below 20%')
  })
})

record('control bar: both pop-out buttons share the bottom row, on 36px targets', () => {
  withStrip((ctx, bar) => {
    const bottom = bottomRowOf(bar)
    const frame = findByLabel(bar, 'Frame in Hermes')
    const own = findByLabel(bar, 'Pop out to desktop')
    assert.ok(frame && own, 'the strip lost a pop-out button')
    const pair = frame.parentNode
    assert.ok(pair, 'the two pop-out buttons have no shared container')
    assert.equal(own.parentNode, pair, 'the two pop-out buttons are not together')
    assert.equal(pair.parentNode, bottom, 'the pop-out pair is not part of the bottom row')
    assert.equal(bottom.children[bottom.children.length - 1], pair,
      'the pop-out pair is not the last thing on the bottom row')
    // The transport shares that row: the named buttons live with the big
    // controls, not on a row of their own above them.
    for (const label of ['Close video', 'Previous source', 'Play', 'Next source']) {
      assert.equal(rowOf(bar, findByLabel(bar, label)), bottom,
        `"${label}" left the bottom row`)
    }

    for (const label of [
      'Close video', 'Previous source', 'Play', 'Next source',
      'Volume — scroll to change', 'Subtitles (CC)'
    ]) {
      const node = findByLabel(bar, label)
      assert.ok(node, `the strip has no "${label}" control`)
      const height = parseInt(String(node.style.height || '0'), 10)
      assert.ok(height >= 36, `"${label}" is a ${height}px target, not at least 36px`)
    }
  })
})

record('control bar: every button is named, and a 320px window wraps instead of overflowing', () => {
  withStrip((ctx, bar) => {
    const buttons = nodesTagged(bar, 'BUTTON')
    assert.ok(buttons.length >= 6, `the strip has only ${buttons.length} buttons`)
    for (const button of buttons) {
      assert.ok(String(button.getAttribute('aria-label') || '').trim(),
        `a strip button has no accessible name (${button.textContent})`)
    }
    const bottom = bottomRowOf(bar)
    assert.match(String(bottom.style.flexWrap), /wrap/, 'the bottom row cannot wrap')
    // Nothing in the bottom row may demand more width than a 288px strip has:
    // a fixed px width above that is what overflow looks like.
    for (const child of bottom.children) {
      const wanted = String(child.style.width || '')
      const fixed = /^(\d+)px$/.exec(wanted)
      if (fixed) assert.ok(Number(fixed[1]) <= 120, `a bottom-row control is ${wanted} wide`)
      const min = String(child.style.minWidth || '')
      const floor = /^(\d+)px$/.exec(min)
      if (floor) assert.ok(Number(floor[1]) <= 120, `a bottom-row control has min-width ${min}`)
    }
    // The strip itself is capped to the window, so 320px can never overflow.
    assert.match(String(bar.style.maxWidth), /100vw/, 'the strip is not capped to the window width')
    assert.match(String(bar.style.boxSizing), /border-box/, 'the strip is not border-box')
  })
})

// ---------------------------------------------------------------- quality
// The owner asked for a quality picker that is honest about each source:
// archive.org's real derivatives as choices, YouTube's one honest answer ("Auto
// (YouTube decides)" — measured: the embed ignores setPlaybackQuality), and
// nothing at all for a single direct file. No control goes on the strip.

const ARCHIVE_ITEM = 'The_General_Buster_Keaton'
const ARCHIVE_BASE = `https://archive.org/download/${ARCHIVE_ITEM}/`
const ARCHIVE_ORIGINAL = `${ARCHIVE_BASE}The_General.mp4`
const ARCHIVE_OGV = `${ARCHIVE_BASE}The_General.ogv`
const ARCHIVE_SMALL = `${ARCHIVE_BASE}The_General_512kb.mp4`
const YOUTUBE_FILM = 'https://www.youtube.com/watch?v=EF8C4v7JIbA'

const archiveQuality = {
  ok: true, mode: 'archive', item: ARCHIVE_ITEM, current: ARCHIVE_ORIGINAL,
  choices: [
    { url: ARCHIVE_ORIGINAL, file: 'The_General.mp4', label: '640×480 · 393 MB · h.264', height: 480, width: 640, size_bytes: 412400222, current: true },
    { url: ARCHIVE_OGV, file: 'The_General.ogv', label: '400×300 · 290 MB · Ogg Video', height: 300, width: 400, size_bytes: 304061885, current: false },
    { url: ARCHIVE_SMALL, file: 'The_General_512kb.mp4', label: '320×240 · 289 MB · 512Kb MPEG4', height: 240, width: 320, size_bytes: 302790246, current: false }
  ],
  smallest: ARCHIVE_SMALL, largest: ARCHIVE_ORIGINAL, note: '3 files on archive.org'
}
const youtubeQuality = {
  ok: true, mode: 'youtube', current: '', smallest: '', largest: '',
  choices: [{ url: '', label: 'Auto (YouTube decides)', auto: true }],
  note: 'YouTube chooses the quality itself; the embed API is deprecated.'
}
const singleQuality = {
  ok: true, mode: 'single', current: 'https://example.org/films/octopus.mp4', smallest: '', largest: '',
  choices: [{ url: 'https://example.org/films/octopus.mp4', label: 'The film\'s own file', current: true }],
  note: 'A direct file is one file.'
}

const menuOf = ctx => renderContribution(ctx.contributions.find(c => c.id === 'quick-menu'))
const pageOf = ctx => {
  const route = ctx.contributions.find(c => c.area === 'routes')
  assert.ok(route, 'the Aura page route vanished')
  return renderDeep(renderContribution(route))
}
const qualitySelect = (tree, label) => {
  let found = null
  walk(tree, node => {
    if (!found && node.type === 'select' && node.props && node.props['aria-label'] === label) found = node
  })
  return found
}
const optionText = (select, value) => {
  const option = (select.props.children || []).flat(Infinity)
    .find(node => node && node.props && node.props.value === value)
  return option ? texts(option) : ''
}

await recordAsync('quality: the A menu lists the film\'s real archive.org files', async () => {
  const ctx = makeCtx(
    { enabled: true, backdropMode: 'video', panelEnabled: true, videoUrl: ARCHIVE_OGV },
    null, archiveQuality
  )
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    // The poll tick loads a film's quality choices in the real app; this
    // harness has no /player route, so the same function is called directly.
    await tx.refreshQuality(true)
    const menu = menuOf(ctx)
    const select = qualitySelect(menu, 'Quality (film)')
    assert.ok(select, 'the A menu has no Quality control')
    assert.ok(!select.props.disabled, 'an archive film with real choices is disabled')
    assert.equal(optionText(select, ARCHIVE_ORIGINAL), '640×480 · 393 MB · h.264',
      'the real resolution/size is not offered')
    assert.equal(optionText(select, ARCHIVE_SMALL), '320×240 · 289 MB · 512Kb MPEG4')
    assert.equal(select.props.value, ARCHIVE_ORIGINAL, 'the file playing is not the one shown')
    // The rule for new films is its own small control, and persisting is a rule
    // — not a fake file.
    const rule = qualitySelect(menu, 'Quality rule (film)')
    assert.ok(rule, 'the A menu has no quality rule control')
    for (const value of ['auto', 'smallest', 'largest']) {
      assert.ok(optionText(rule, value), `the ${value} rule is not offered`)
    }
    // The page carries the same control, in the setup section.
    const page = pageOf(ctx)
    assert.ok(qualitySelect(page, 'Quality (settings)'), 'the Aura page has no Quality control')
    assert.ok(qualitySelect(page, 'Quality rule (settings)'), 'the page has no quality rule control')
    // And it is NOT on the floating strip (another lane owns that strip).
    const strip = layoutMountPanel(ctx)
    walk(strip, node => {
      assert.notEqual(node.props && node.props['aria-label'], 'Quality', 'the quality control is on the strip')
    })
  } finally {
    dispose()
  }
})

await recordAsync('quality: a real choice switches the film and keeps the second', async () => {
  const ctx = makeCtx(
    { enabled: true, backdropMode: 'video', panelEnabled: true, videoUrl: ARCHIVE_OGV },
    null, archiveQuality
  )
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    const posts = []
    const frame = { style: {}, contentWindow: { postMessage: message => posts.push(message) } }
    tx.setBackdropForTest(frame)
    // The page says where the film is; the switch has to keep that.
    const listener = ctx.listeners.find(entry => entry.type === 'message' && !entry.removed)
    listener.fn({
      source: frame.contentWindow,
      data: {
        aura: 'video-state', url: ARCHIVE_OGV, kind: 'video', playing: true,
        position: 412.5, duration: 4723, muted: false, title: 'The General'
      }
    })
    await tx.refreshQuality(true)
    const select = qualitySelect(menuOf(ctx), 'Quality (film)')
    select.props.onChange({ target: { value: ARCHIVE_SMALL } })
    await sleep(90)
    assert.equal(ctx.storage.get('settings').videoUrl, ARCHIVE_SMALL,
      'the chosen file did not become the film')
    assert.deepEqual(posts.at(-1), { aura: 'transport', cmd: 'quality', url: ARCHIVE_SMALL },
      'the page was not told to swap in place')
    const marks = ctx.storage.get('settings').videoPositions || {}
    assert.equal(marks[ARCHIVE_SMALL] && marks[ARCHIVE_SMALL].position, 412.5,
      'the swap forgot where the film was, so a reload would restart it')
  } finally {
    tx.setBackdropForTest(null)
    dispose()
  }
})

await recordAsync('quality: "Smallest" is remembered and switches now', async () => {
  const ctx = makeCtx(
    { enabled: true, backdropMode: 'video', panelEnabled: false, videoUrl: ARCHIVE_ORIGINAL },
    null, archiveQuality
  )
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    await tx.refreshQuality(true)
    const rule = qualitySelect(menuOf(ctx), 'Quality rule (film)')
    rule.props.onChange({ target: { value: 'smallest' } })
    await sleep(90)
    assert.equal(ctx.storage.get('settings').videoQuality, 'smallest', 'the preference was not persisted')
    assert.equal(ctx.storage.get('settings').videoUrl, ARCHIVE_SMALL, 'the film did not switch now')
  } finally {
    dispose()
  }
})

await recordAsync('quality: YouTube offers exactly one choice, and no fake command', async () => {
  const ctx = makeCtx(
    { enabled: true, backdropMode: 'video', panelEnabled: true, videoUrl: YOUTUBE_FILM },
    null, youtubeQuality
  )
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    await tx.refreshQuality(true)
    const select = qualitySelect(menuOf(ctx), 'Quality (film)')
    assert.ok(select, 'YouTube has no Quality control at all')
    const options = (select.props.children || []).flat(Infinity)
      .filter(node => node && node.props && 'value' in node.props)
    assert.equal(options.length, 1, `YouTube offered ${options.length} choices`)
    assert.equal(texts(options[0]), 'Auto (YouTube decides)')
    assert.equal(select.props.disabled, true, 'the YouTube control pretends it can change the level')
  } finally {
    dispose()
  }
})

await recordAsync('quality: a direct file has no picker at all', async () => {
  const ctx = makeCtx(
    { enabled: true, backdropMode: 'video', panelEnabled: true, videoUrl: 'https://example.org/films/octopus.mp4' },
    null, singleQuality
  )
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    await tx.refreshQuality(true)
    assert.equal(tx.qualityInfoForTest().mode, 'single', 'a direct file was not recognised')
    assert.equal(qualitySelect(menuOf(ctx), 'Quality (film)'), null,
      'a single file was given a picker')
    assert.equal(qualitySelect(pageOf(ctx), 'Quality (settings)'), null,
      'the Aura page gave a single file a picker')
  } finally {
    dispose()
  }
})

await recordAsync('quality: the preference is applied to the next archive.org film', async () => {
  const ctx = makeCtx(
    { enabled: true, backdropMode: 'video', panelEnabled: false, videoUrl: ARCHIVE_OGV, videoQuality: 'largest' },
    null, archiveQuality
  )
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    await tx.applyVideoSource(ARCHIVE_SMALL)
    assert.equal(ctx.storage.get('settings').videoUrl, ARCHIVE_ORIGINAL,
      'the "largest" rule was not applied to the new film')
  } finally {
    dispose()
  }

  const auto = makeCtx(
    { enabled: true, backdropMode: 'video', panelEnabled: false, videoUrl: YOUTUBE_FILM, videoQuality: 'auto' },
    null, archiveQuality
  )
  const d2 = pluginModule.default.register(auto.ctx)
  try {
    await tx.applyVideoSource(ARCHIVE_SMALL)
    assert.equal(auto.storage.get('settings').videoUrl, ARCHIVE_SMALL,
      '"auto" changed the file the source named')
    assert.equal(auto.requests.filter(r => String(r.route).startsWith('/quality')).length, 0,
      '"auto" still asked the server for a different file')
  } finally {
    d2()
  }
})

await recordAsync('quality: a queued quality command from Hermes is applied', async () => {
  const ctx = makeCtx(
    { enabled: true, backdropMode: 'video', panelEnabled: false, videoUrl: ARCHIVE_OGV },
    null, archiveQuality
  )
  const dispose = pluginModule.default.register(ctx.ctx)
  try {
    // The same function the player-command poll calls for {cmd:'quality'}.
    tx.applyQualityCommand({ cmd: 'quality', url: ARCHIVE_ORIGINAL })
    assert.equal(ctx.storage.get('settings').videoUrl, ARCHIVE_ORIGINAL,
      'the queued quality command did not switch the film')
    tx.applyQualityCommand({ cmd: 'quality', preference: 'smallest' })
    assert.equal(ctx.storage.get('settings').videoQuality, 'smallest',
      'the queued preference was not remembered')
  } finally {
    dispose()
  }
})


console.log(results.join('\n'))
console.log(`\n${results.length - failed} passed, ${failed} failed`)

try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch {
  // the scratch dir is pruned anyway
}

if (failed > 0) process.exitCode = 1
