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
    behavior: settings && typeof settings.behavior === 'string' ? settings.behavior : 'balanced',
    intensity: settings && Number.isFinite(settings.intensity) ? settings.intensity : 0.5,
    opacity: settings && Number.isFinite(settings.opacity) ? settings.opacity : 0.35,
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

fs.writeFileSync(pluginCopy, rewritten + '\nexport const wiringTest = { sync: typeof syncPlayerOwnership === "function" ? syncPlayerOwnership : null, urlBinding: typeof pageUrlInputBinding === "function" ? pageUrlInputBinding : null, setWindow: typeof setDesktopWindow === "function" ? setDesktopWindow : null, video: $video, settings: $settings };\n')

fs.writeFileSync(
  sdkStub,
  `// Stub of @hermes/plugin-sdk: records the calls the plugin makes.
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
    createdElements.push(node)
    return node
  },
  addEventListener() {},
  removeEventListener() {}
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
  // A pane is laid out by the app; anything we would have to pin ourselves is
  // exactly what broke the layout before.
  assert.ok(!('position' in pane.data), 'pane must not set its own position')
})

record('the Right panel offers every Aura setting in a collapsible drawer', () => {
  const pane = a.contributions.find(c => c.area === 'panes')
  let tree = renderContribution(pane)
  assert.equal(tree.props.style.overflowY, 'auto', 'the pane must scroll when content is taller than the window')
  assert.ok(texts(tree).includes('Aura settings'), 'the settings drawer title is missing')
  assert.equal(texts(tree).includes('Aura enabled'), false, 'the settings drawer must start collapsed')
  let toggle = null
  walk(tree, node => {
    if (!toggle && node.props && node.props['aria-label'] === 'Expand Aura settings') toggle = node
  })
  assert.ok(toggle, 'the settings drawer has no expand control')
  toggle.props.onClick()
  assert.equal(a.storage.get('settings').panelSettingsOpen, true, 'opening the drawer was not remembered')
  tree = renderContribution(a.contributions.find(c => c.area === 'panes'))
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
  assert.equal(a.storage.get('settings').panelSettingsOpen, false, 'closing the drawer was not remembered')
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

await recordAsync('the Aura Live theme alone also shows the backdrop, and leaving it removes it', async () => {
  // Intended behaviour: the active aura-live theme mounts the backdrop even
  // with windowVisual off (same condition as syncBackdrop).
  const probe = a.contributions.find(c => c.area === 'titleBar.center')
  sdk.themeState.name = 'aura-live'
  renderContribution(probe)
  a.timers.find(t => t.ms === 250).fn()
  await sleep(30)
  assert.equal(hostStyles().length, 1, 'the Aura Live theme did not mount the glass style')
  assert.equal(hostIframes().length, 1, 'the Aura Live theme did not mount the backdrop')
  assert.equal(hostIframes()[0].style.pointerEvents, 'none')
  assert.equal(hostIframes()[0].style.zIndex, '-1')
  sdk.themeState.name = 'nous'
  renderContribution(probe)
  a.timers.find(t => t.ms === 250).fn()
  await sleep(30)
  assert.equal(glassStyles().length, 0, 'switching away from Aura Live left the #aura-glass style behind')
  assert.equal(hostStyles().length, 0, 'switching away from Aura Live left a stylesheet behind')
  assert.equal(hostIframes().length, 0, 'switching away from Aura Live left the backdrop behind')
  assert.equal(hostHasNegativeZ(), false, 'a host node keeps a negative z-index')
  assert.deepEqual(Object.keys(documentElement.style), [], 'host html/root style was mutated')
  assert.deepEqual(Object.keys(document.body.style), [], 'host body style was mutated')
})

await recordAsync('whole-window visual is opt-in and restores the host when switched off', async () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let toggle = null
  walk(tree, node => {
    if (!toggle && node.props && node.props['aria-label'] === 'Visual behind the app') toggle = node
  })
  assert.ok(toggle, 'whole-window visual switch missing')
  assert.equal(toggle.props.checked, false)
  toggle.props.onCheckedChange(true)
  await sleep(30)
  assert.equal(hostStyles().length, 1)
  assert.equal(hostIframes().length, 1)
  assert.equal(hostIframes()[0].style.pointerEvents, 'none')
  toggle.props.onCheckedChange(false)
  await sleep(30)
  assert.equal(glassStyles().length, 0, 'the #aura-glass style survived the switch-off')
  assert.equal(hostStyles().length, 0)
  assert.equal(hostIframes().length, 0)
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

await recordAsync('disposer removes every contribution, clears timers/listeners, accent, glass and theme', async () => {
  // Mount an effect first so the clean-up assertions are not vacuous.
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const switches = findSettingsSwitches(renderContribution(settings))
  switches.visual.props.onCheckedChange(true)
  await sleep(30)
  assert.equal(glassStyles().length, 1, 'the window visual did not mount its glass style')
  assert.equal(hostIframes().length, 1, 'the window visual did not mount its backdrop')
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

await recordAsync('Restore my theme turns off effects, restores the previous theme and persists', async () => {
  const settings = b.contributions.find(c => c.area === 'settings.plugins')
  // Mount an effect first so the clean-up assertions are not vacuous.
  const switches = findSettingsSwitches(renderContribution(settings))
  switches.visual.props.onCheckedChange(true)
  await sleep(30)
  assert.equal(glassStyles().length, 1, 'the window visual did not mount its glass style')
  assert.equal(hostIframes().length, 1, 'the window visual did not mount its backdrop')
  const tree = renderContribution(settings)
  let restore = null
  walk(tree, node => {
    if (!restore && node.props && node.props['aria-label'] === 'Restore my theme') restore = node
  })
  assert.ok(restore, 'no Restore my theme control rendered')
  restore.props.onClick()
  await sleep(30)
  assert.equal(sdk.calls.themes.at(-1), 'nous', 'previous theme was not restored')
  assert.equal(sdk.calls.accent.at(-1), null, 'accent override was not cleared')
  assert.deepEqual(b.controls.at(-1), { accent_pulse: false })
  const saved = b.storage.get('settings')
  assert.equal(saved.accentPulse, false, 'accent pulse was not turned off')
  assert.equal(saved.themeOptIn, false, 'theme opt-in was not turned off')
  assert.equal(saved.windowVisual, false, 'the window visual was not turned off')
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

// ------------------------------------------------- a skin change keeps the visual
// Changing the app's own theme used to switch "Visual behind the app" off in
// silence, so the visualiser vanished and the switch had to be found again. The
// glass is measured from the theme's colours, so it is re-measured instead.

sdk.themeState.name = 'nous'
const skin = makeCtx({ enabled: true, backdropMode: 'aura', windowVisual: true, themeOptIn: false, panelEnabled: false })
const disposeSkin = pluginModule.default.register(skin.ctx)
const probeSkin = skin.contributions.find(c => c.area === 'titleBar.center')

await recordAsync('changing the app theme keeps "Visual behind the app" on', async () => {
  renderContribution(probeSkin)          // first report: the user's theme
  skin.timers.filter(t => t.ms === 250).forEach(t => t.fn())
  await sleep(40)
  assert.equal(skin.storage.get('settings').windowVisual, true, 'the visual was not on to begin with')
  sdk.themeState.name = 'midnight'       // the user picks another skin
  renderContribution(probeSkin)
  skin.timers.filter(t => t.ms === 250).forEach(t => t.fn())
  await sleep(40)
  assert.equal(skin.storage.get('settings').windowVisual, true,
    'a theme change switched "Visual behind the app" off')
  assert.ok(hostIframes().length >= 1, 'the visual is gone after a theme change')
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

  // Desktop defaults for a new user: agent_music, balanced, 0.35 opacity,
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
  assert.equal(behavior.props.value, 'balanced', 'behaviour default is not balanced')
  const opacity = (() => {
    let found = null
    walk(tree, node => {
      if (!found && node.type === 'input' && node.props && node.props['aria-label'] === 'Visual opacity') found = node
    })
    return found
  })()
  assert.equal(opacity.props.value, 35, 'opacity default is not 0.35')
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
  assert.equal(intensity.props.value, 0.5, 'intensity default is not 0.5')
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

await recordAsync('gentle motion flips the web half through the backdrop URL', async () => {
  const settingsPage = f.contributions.find(c => c.area === 'settings.plugins')
  const pageTree = renderContribution(settingsPage)
  const visual = findByAria(pageTree, 'Visual behind the app')
  assert.ok(visual, 'windowVisual switch missing')
  visual.props.onCheckedChange(true)
  await sleep(30)
  assert.equal(hostIframes().length, 1, 'the window visual did not mount its backdrop')
  assert.match(hostIframes()[0].src, /overlay=1/, 'backdrop src lost the overlay flag')
  assert.match(hostIframes()[0].src, /reduced-motion=1/, 'gentle motion lost its force-switch')
  findByAria(quickTree(), 'Gentle motion (motion-sensitive)').props.onCheckedChange(false)
  await sleep(30)
  assert.doesNotMatch(hostIframes()[0].src, /reduced-motion/, 'the force-switch stayed after gentle off')
  visual.props.onCheckedChange(false)
  await sleep(30)
  assert.equal(hostIframes().length, 0, 'the backdrop survived the switch-off')
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

await recordAsync('Only while active: nothing is mounted before 300 ms of sustained activity', async () => {
  assert.equal(hostIframes().length, 0, 'mounted the backdrop before the fade-in delay')
  assert.equal(glassStyles().length, 0, 'mounted the glass before the fade-in delay')
  assert.ok(
    g.timers.some(t => t.kind === 'timeout' && t.ms === 300 && !t.cleared && !t.fired),
    'no 300 ms fade-in delay timer'
  )
})

await recordAsync('Only while active: fades in after sustained activity and mounts the glass', async () => {
  await fireTimer(g, 300)
  assert.equal(hostIframes().length, 1, 'the backdrop did not mount after the fade-in delay')
  assert.equal(glassStyles().length, 1, 'the #aura-glass style did not mount with the backdrop')
  assert.equal(hostIframes()[0].style.opacity, '0', 'the fade-in did not start at zero')
  for (let i = 0; i < 6; i += 1) await fireTimer(g, 250)
  assert.equal(hostIframes()[0].style.opacity, '1', 'the fade-in did not reach full opacity')
})

await recordAsync('Only while active: short idle gaps stay inside the hysteresis window', async () => {
  setMoving(g, false)
  await firePoll(g)
  const idleTimer = g.timers.find(t => t.kind === 'timeout' && t.ms === 2500 && !t.cleared && !t.fired)
  assert.ok(idleTimer, 'no 2.5 s fade-out timer after idle')
  setMoving(g, true)
  await firePoll(g)
  assert.equal(idleTimer.cleared, true, 'resumed activity did not cancel the fade-out timer')
  assert.equal(hostIframes().length, 1, 'a short idle gap removed the backdrop (flicker)')
  assert.equal(hostIframes()[0].style.opacity, '1', 'a short idle gap dimmed the backdrop')
})

await recordAsync('Only while active: fades out after 2.5 s idle and removes the glass entirely', async () => {
  setMoving(g, false)
  await firePoll(g)
  await fireTimer(g, 2500)
  assert.equal(hostIframes().length, 1, 'the backdrop vanished before the fade-out ramp')
  for (let i = 0; i < 6; i += 1) await fireTimer(g, 250)
  assert.equal(hostIframes().length, 0, 'the backdrop survived the completed fade-out')
  assert.equal(glassStyles().length, 0, 'the #aura-glass style survived the completed fade-out')
  assert.equal(hostStyles().length, 0, 'a host stylesheet survived the completed fade-out')
})

await recordAsync('reduced motion caps the fade ramp at 200 ms', async () => {
  g.serverSettings.reduced_motion = true
  setMoving(g, true)
  await firePoll(g)
  await fireTimer(g, 300)
  assert.equal(hostIframes().length, 1, 'the backdrop did not mount under reduced motion')
  assert.ok(
    g.timers.some(t => t.kind === 'timeout' && t.ms === 200 && !t.cleared && !t.fired),
    'the fade-in ramp is not capped at 200 ms under reduced motion'
  )
  await fireTimer(g, 200)
  assert.equal(hostIframes()[0].style.opacity, '1', 'the reduced-motion fade-in did not complete')
  setMoving(g, false)
  await firePoll(g)
  await fireTimer(g, 2500)
  assert.ok(
    g.timers.some(t => t.kind === 'timeout' && t.ms === 200 && !t.cleared && !t.fired),
    'the fade-out ramp is not capped at 200 ms under reduced motion'
  )
  await fireTimer(g, 200)
  assert.equal(hostIframes().length, 0, 'the reduced-motion fade-out left the backdrop behind')
  assert.equal(glassStyles().length, 0, 'the reduced-motion fade-out left the glass behind')
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
  // Tray-only life: no docked panel, so the floating strip is the surface.
  panelEnabled: false,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
})
pluginModule.default.register(v.ctx)
// Drive one poll tick: the strip mounts from the poll, exactly like the app.
v.timers.find(t => t.ms === 250).fn()
await sleep(80)


await recordAsync('video mode mounts the two-row control strip with grip, scrub and close', async () => {
  const bar = bodyChildren.find(node => node.attributes && node.attributes.role === 'toolbar')
  assert.ok(bar, 'the video control strip never mounted')
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
  // Two visible rows: the film line over a centred transport row. A third,
  // "Send to", belongs to the watch window and stays hidden without one.
  const visibleRows = bar.children.filter(row => row.style.display !== 'none')
  assert.equal(visibleRows.length, 2, 'the strip is not drawn as two rows')
  const transport = bar.children[1]
  const transportText = (transport.children || []).map(child => child.textContent || '').join('')
  for (const glyph of ['⏮', '⏪', '▶', '⏩', '⏭']) {
    assert.ok(transportText.includes(glyph), `transport row is missing ${glyph}`)
  }
  assert.equal(transport.style.justifyContent, 'center', 'the transport row is not centred')
  assert.equal(bar.style.flexDirection, 'column', 'the strip is not stacked')
  assert.equal(bar.style.width, '340px', 'the strip lost its half-width shape')
  assert.equal(bar.style.opacity, '1', 'the strip must start visible')
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
  themeOptIn: false,
  panelEnabled: true,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
})
pluginModule.default.register(paneOnly.ctx)
paneOnly.timers.find(t => t.ms === 250).fn()
await sleep(80)

await recordAsync('the docked pane alone mounts the film', () => {
  assert.ok(hostIframes().length >= 1, 'nothing mounted with the default settings: the pane would be empty')
  // Opacity is not asserted here: the pane's placement depends on a real
  // getBoundingClientRect, which the fake DOM does not provide, so the frame
  // falls back to the backdrop branch in this harness. `backdropOpacity()`
  // returns 1 whenever the pane is showing — verified in the app, not here.
})

// ------------------------------------- surfaces without the Right panel
// The Right panel is the film's box and most people keep it closed. Drawing behind
// the window stays opt-in ("Visual behind the app"); with that on, the visualiser
// and a loaded film fill the window whether or not the panel is open. The panel's
// own exception is for the film only: it used to mount the visualiser too, so the
// visualiser seemed to need the panel, and vanished when the panel was closed.

const frameSrc = node => String(node.src || (node.attributes && node.attributes.src) || '')
const tick = scenario => scenario.timers.filter(t => t.ms === 250).forEach(t => t.fn())

// The plugin keeps ONE frame for the module and re-points it, and earlier
// scenarios may leave theirs mounted, so classify the frames by what they show
// instead of counting new elements.
async function surfaceScenario(settings) {
  const scenario = makeCtx({ themeOptIn: false, windowVisual: false, ...settings })
  const dispose = pluginModule.default.register(scenario.ctx)
  tick(scenario)
  await sleep(80)
  tick(scenario)
  await sleep(40)
  const all = hostIframes()
  const films = all.filter(node => frameSrc(node).includes('/player.html'))
  const visuals = all.filter(node => frameSrc(node) && !frameSrc(node).includes('/player.html'))
  return { films, visuals, all, dispose }
}

await recordAsync('with the Right panel closed, the opted-in visualiser fills the window', async () => {
  const { visuals, films, dispose } = await surfaceScenario({
    enabled: true, backdropMode: 'aura', panelEnabled: false, windowVisual: true
  })
  try {
    assert.equal(visuals.length, 1, 'no visualiser mounted with the Right panel closed')
    assert.equal(films.length, 0, 'a film player is mounted in visualiser mode')
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

await recordAsync('with the Right panel closed, an opted-in film fills the window behind the app', async () => {
  const { films, visuals, dispose } = await surfaceScenario({
    enabled: true, backdropMode: 'video', panelEnabled: false, windowVisual: true,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', videoOpacity: 0.75, videoOpacityAuto: false
  })
  try {
    assert.equal(films.length, 1, 'no film mounted with the Right panel closed')
    assert.equal(visuals.length, 0, 'a visualiser is mounted in video mode')
    assert.equal(String(films[0].style.opacity), '0.75', 'the full-window film lost the see-through setting')
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

await recordAsync('the "Visual behind the app" switch is on the settings page in video mode too', async () => {
  // In video mode it is the switch that lets the film fill the window with the
  // Right panel closed, so hiding it with the visualiser-only controls left no way
  // to turn it on from the mode that needs it.
  const scenario = makeCtx({ enabled: true, backdropMode: 'video', panelEnabled: false,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' })
  const dispose = pluginModule.default.register(scenario.ctx)
  try {
    await sleep(40)
    const page = scenario.contributions.find(c => c.area === 'settings.plugins')
    assert.ok(page, 'no settings page')
    assert.ok(findSwitch(renderContribution(page), 'Visual behind the app'),
      'video mode hides the switch the full-window film depends on')
  } finally {
    dispose()
  }
})

await recordAsync('Aura adds no blur of its own over a film behind the app', async () => {
  // Film strength is the readability control (low = hazy film, readable chat);
  // the host already frosts its own surfaces, so a second blur from Aura only
  // smears the film. Guard against it coming back.
  const { films, dispose } = await surfaceScenario({
    enabled: true, backdropMode: 'video', panelEnabled: false, windowVisual: true,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
  })
  try {
    assert.equal(films.length, 1, 'no film behind the app')
    assert.ok(!/blur\(/.test(String(films[0].style.filter || '')), `Aura blurs the film (filter: ${films[0].style.filter})`)
    const glass = glassStyles()
    assert.ok(!glass.some(node => /backdrop-filter/.test(String(node.textContent || ''))),
      'Aura rewrites the host frost')
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

await recordAsync('the quick menu offers Watch in, and Film strength only acts on a film behind the chat', async () => {
  // With the Right panel open the film plays in it at full strength, so the
  // strength presets cannot change anything: grey them out and offer the move.
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
    assert.ok(findByAria(inPanel.tree, 'Watch the film behind the chat (quick menu)'), 'the quick menu has no Behind chat choice')
    assert.ok(findByAria(inPanel.tree, 'Watch the film in the Right panel (quick menu)'), 'the quick menu has no Panel choice')
    assert.equal(findByAria(inPanel.tree, '50% video strength').props.disabled, true,
      'Film strength looks live while the film plays in the Right panel at full strength')
  } finally {
    inPanel.dispose()
  }
  const behind = await menuFor(true)
  try {
    assert.ok(!findByAria(behind.tree, '50% video strength').props.disabled, 'Film strength is greyed out for a film behind the chat')
  } finally {
    behind.dispose()
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
  // The presets set how solid the film is; labelled "transparency" they read
  // backwards, so 25% looked like a nearly clear film when it is mostly gone.
  const scenario = makeCtx({ enabled: true, backdropMode: 'video', videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' })
  const dispose = pluginModule.default.register(scenario.ctx)
  try {
    await sleep(20)
    const tree = renderContribution(scenario.contributions.find(c => c.id === 'quick-menu'))
    assert.ok(findByAria(tree, '25% video strength'), 'the film presets are not labelled as film strength')
    assert.equal(findByAria(tree, '25% video transparency'), null, 'a film preset is still labelled as transparency')
    // The watch window always has its strip; a switch to hide it stranded the window.
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
    assert.equal(films.length, 1, 'the pane film did not mount')
    assert.equal(glassStyles().length, 0, 'the app surfaces were cleared with nothing behind them')
  } finally {
    dispose()
  }
})

await recordAsync('a film in the Right panel is always full strength', async () => {
  // See-through is for the film behind the app. Inside its own box a 75% film is
  // a dim player, and the 250 ms tick used to pull it back to 75% after mount set
  // it to 100%, so the picture visibly pulsed.
  const { films, dispose } = await surfaceScenario({
    enabled: true, backdropMode: 'video', panelEnabled: true,
    videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', videoOpacity: 0.75, videoOpacityAuto: false
  })
  try {
    assert.equal(films.length, 1, 'the pane film did not mount')
    assert.equal(String(films[0].style.opacity), '1', 'the pane film follows the see-through setting')
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

await recordAsync('the quick menu offers the Right panel and Visual behind the app in both modes', async () => {
  // Hiding and bringing back the Right panel, and the full-window switch, are
  // the two layout controls people reach for in either mode.
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
      assert.ok(findByAria(tree, 'Visual behind the app (quick menu)'),
        `${backdropMode} mode: the quick menu has no Visual behind the app switch`)
    } finally {
      dispose()
    }
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
  assert.ok(pageAria(tree, 'Visual behind the app'),
    'the film page hides the switch the full-window film depends on')
  assert.match(body, /Aura setup/, 'the page has no setup section')
  assert.match(body, /Big Buck Bunny/, 'the page does not offer the starter sources')
  assert.match(body, /Winamp-style player for Hermes/, 'the REVamp card is missing')
  const link = pageAria(tree, 'REVamp marketplace page')
  assert.ok(link, 'the REVamp marketplace link is missing')
  assert.equal(link.type, 'a', 'the marketplace page must be a link')
  assert.equal(link.props.href, 'https://hermes-agent.nousresearch.com/marketplace/revamp')
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

await recordAsync('the page stage takes the one player, and gives it back on leave', async () => {
  const before = hostIframes().length
  const tree = pageTree()
  let stageRef = null
  walk(tree, node => {
    if (!stageRef && node.props && typeof node.props.ref === 'function') stageRef = node.props.ref
  })
  assert.equal(typeof stageRef, 'function', 'the page has no stage ref')
  const stageNode = { getBoundingClientRect: () => ({ left: 40, top: 60, width: 800, height: 450 }) }
  stageRef(stageNode)
  const placed = hostIframes().filter(frame => frame.style.width === '800px')
  assert.equal(placed.length, 1, 'the film did not move into the page stage')
  assert.equal(placed[0].style.left, '40px')
  assert.equal(placed[0].style.top, '60px')
  assert.equal(placed[0].style.height, '450px')
  assert.equal(placed[0].style.zIndex, '1', 'the page film must sit above the page, not behind the app')
  assert.ok(hostIframes().length <= before + 1, 'the page created a second player')
  // Pop out on the page pops the film out now (owner ask), Bring back returns it.
  const pop = pageAria(pageTree(), 'Pop out')
  assert.ok(pop, 'the page has no Pop out button')
  pop.props.onClick()
  assert.equal(
    hostIframes().some(frame => frame.style.width === '800px'),
    false,
    'Pop out left the film on the page'
  )
  const back = pageAria(pageTree(), 'Bring back')
  assert.ok(back, 'a popped-out film offers no Bring back')
  back.props.onClick()
  assert.equal(
    hostIframes().filter(frame => frame.style.width === '800px').length,
    1,
    'Bring back did not return the film to the page'
  )
  stageRef(null)
  assert.equal(
    hostIframes().some(frame => frame.style.width === '800px'),
    false,
    'the film stayed glued to a page that is no longer open'
  )
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
  for (const label of ['Reacts to', 'Style', 'Intensity', 'Visual strength', 'Gentle motion (motion-sensitive)', 'Show']) {
    assert.equal(findByAria(tree, label), null, `${label} is still rendered in video mode`)
  }
  // The video's own transparency stays usable.
  const preset = findByAria(tree, '50% video strength')
  assert.ok(preset, 'the film strength presets vanished')
  assert.ok(!preset.props.disabled, 'film strength must stay active in video mode')
  assert.ok(findByAria(tree, 'Video volume'), 'the volume slider vanished')
  assert.equal(s.storage.get('settings').showWhen, 'active', 'showWhen was rewritten by hiding')
})

record('Settings hides the Aura-visual rows in video mode and offers the same switch', () => {
  const tree = sSettings()
  for (const label of ['Behaviour profile', 'Reaction strength', 'Visual opacity', 'Gentle motion (motion-sensitive)', 'Show']) {
    assert.equal(findByAria(tree, label), null, `Settings still renders ${label} in video mode`)
  }
  assert.ok(findByAria(tree, 'Aura mode'), 'Settings has no mode switch')
  // Film strength presets are still live.
  assert.ok(!findByAria(tree, '25% video strength').props.disabled,
    'film strength was hidden with the Aura controls')
  assert.equal(s.storage.get('settings').showWhen, 'active', 'Settings rewrote showWhen')
})

await recordAsync('a playing film is never faded out by "Only while active"', async () => {
  s.timers.find(t => t.ms === 250).fn()
  await sleep(60)
  const frames = hostIframes()
  assert.equal(frames.length, 1, 'the film is not mounted in video mode with Show=active')
  assert.notEqual(frames[0].style.opacity, '0', 'the film was faded to nothing by the active mode')
  // Idle audio/mood: the active state machine must not schedule a fade-out.
  s.serverFrame.mood = 'idle'
  s.serverFrame.silence = true
  s.serverFrame.level = 0
  s.timers.find(t => t.ms === 250).fn()
  await sleep(60)
  assert.equal(
    s.timers.some(t => t.kind === 'timeout' && t.ms === 2500 && !t.cleared && !t.fired),
    false,
    'a fade-out timer was scheduled for a playing film'
  )
  assert.equal(hostIframes().length, 1, 'the playing film was removed while idle')
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

record('a backdrop frame that takes focus gives the keyboard straight back', () => {
  // YouTube's player calls window.focus() when it starts. Without this guard the
  // iframe keeps the keyboard and the composer silently stops accepting text
  // ("Aura has a keyboard bug that keeps me from typing into hermes").
  const frame = { blurred: false, blur() { this.blurred = true } }
  tx.setBackdropForTest(frame)
  const composer = { focused: false, isConnected: true, focus() { this.focused = true } }

  // A field the user actually typed in is remembered...
  tx.rememberCaret({ target: composer })
  // ...and the frame grabbing focus does not win.
  tx.releaseBackdropFocus({ target: frame })

  assert.equal(frame.blurred, true, 'the film frame kept focus')
  assert.equal(composer.focused, true, 'the caret was not handed back to the user')

  // A focus event on anything else is none of our business.
  const other = { blurred: false, blur() { this.blurred = true } }
  tx.releaseBackdropFocus({ target: other })
  assert.equal(other.blurred, false, 'the guard blurred an unrelated element')
  tx.setBackdropForTest(null)
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

await recordAsync('page Pop out opens the OS window and unavailable browsers use the in-app window', async () => {
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
  const route = x.contributions.find(c => c.area === 'routes')
  const tree = renderDeep(renderContribution(route))
  pageAria(tree, 'Pop out').props.onClick()
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

// --------------------------------------------------------------- reporting

console.log(results.join('\n'))
console.log(`\n${results.length - failed} passed, ${failed} failed`)

try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch {
  // the scratch dir is pruned anyway
}

if (failed > 0) process.exitCode = 1
