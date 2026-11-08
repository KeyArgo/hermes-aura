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
 *   4. the stage era is gone: no /aura route, sidebar row, palette command,
 *      pane or status-bar contribution — the backdrop and Settings are it,
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
 *      hint (instead of drawing nothing) when Aura is off while it is on.
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
  // /control {enabled} actually applied, so off really stays off.
  let serverEnabled = settings && typeof settings.enabled === 'boolean' ? settings.enabled : true

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
      const record = { fn, ms, cleared: false }
      timers.push(record)
      return () => {
        record.cleared = true
      }
    },
    setTimeout(fn, ms) {
      const record = { fn, ms, cleared: false }
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
          capture: 'pipewire',
          enabled: serverEnabled
        }
      }
      if (route === '/state') {
        return {
          level: 0.55,
          bands: [0, 0, 0, 0, 0, 0, 0, 0],
          onset: false,
          centroid: 0.4,
          flatness: 0.2,
          silence: false,
          mood: 'thinking',
          intensity: 0.5,
          enabled: true
        }
      }
      if (route === '/control') {
        controls.push(options.body)
        if (options.body && typeof options.body.enabled === 'boolean') serverEnabled = options.body.enabled
        return { ok: true }
      }
      throw new Error(`unexpected route ${route}`)
    }
  }

  return { ctx, contributions, timers, controls, disposers, listeners, requests, storage }
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

fs.writeFileSync(pluginCopy, rewritten)

fs.writeFileSync(
  sdkStub,
  `// Stub of @hermes/plugin-sdk: records the calls the plugin makes.
export const calls = { accent: [], themes: [], navigations: [], notifications: [] }

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
  notify: message => { calls.notifications.push(message) }
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
  return {
    children,
    style: {},
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
      parentNode: null,
      src: '',
      textContent: '',
      setAttribute(name, value) {
        this.attributes[name] = String(value)
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
const hostStyles = () => headChildren.filter(node => node.tagName === 'STYLE')
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

record('does not contribute the stage route, sidebar row, palette command or pane', () => {
  for (const area of ['routes', 'sidebar.nav', 'palette', 'panes']) {
    assert.ok(
      !a.contributions.some(c => c.area === area),
      `a ${area} contribution survived the stage clean-up`
    )
  }
})

record('does not occupy the status bar', () => {
  assert.ok(!a.contributions.some(c => c.area.startsWith('statusBar.')))
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

record('contributes a permanently mounted theme probe', () => {
  const probe = a.contributions.find(c => c.area === 'titleBar.center')
  assert.ok(probe, 'no titleBar.center contribution')
  assert.equal(typeof probe.render, 'function')
})

record('polls at 250 ms or slower (never faster than 4 Hz)', () => {
  const interval = a.timers.find(t => t.ms && t.ms >= 250)
  assert.ok(interval, 'no polling interval >= 250 ms')
  assert.ok(a.timers.every(t => t.ms >= 250), 'a timer is faster than 250 ms')
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
    'Default — music, or gentle designs',
    'Music only',
    'Agent activity',
    'Agent + music'
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
})

record('dispose from the defaults scenario is clean', () => {
  disposeE()
  assert.equal(e.contributions.length, 0)
  assert.ok(e.timers.every(t => t.cleared))
  assert.ok(e.listeners.every(t => t.removed))
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
