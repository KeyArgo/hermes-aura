/**
 * Contract test for the Aura desktop half (desktop/plugin.js).
 *
 * This does NOT run the plugin inside Hermes. It proves the things a headless
 * Node process can prove, and nothing it cannot:
 *
 *   1. the file is plain ESM that Node can parse (JSX syntax would fail here),
 *   2. its default export is { id, name, register },
 *   3. register() contributes the expected areas and returns a disposer that
 *      removes every contribution, clears the timers, clears the accent
 *      override and restores the theme it replaced,
 *   4. the stage returns to chat, with no status-bar contribution,
 *   5. the polling interval is never faster than 4 Hz,
 *   6. the static SDK rules hold: no eval / new Function / JSX / dynamic
 *      import, no imports outside the three allowed specifiers, no
 *      document.querySelector('[data-slot=...]'), no document.body observer,
 *      no console output.
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
  const storage = new Map()
  if (settings) storage.set('settings', settings)

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
    addEventListener() {
      return () => {}
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
          enabled: true
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
        return { ok: true }
      }
      throw new Error(`unexpected route ${route}`)
    }
  }

  return { ctx, contributions, timers, controls, disposers, requests, storage }
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
// outside a renderer; the test invokes the theme probe and stage.
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

// The plugin reads document/getComputedStyle for the theme accent, the
// background-window check and the imperatively mounted backdrop; a minimal
// stand-in keeps the import headless while still recording backdrop mounts.
const bodyChildren = []
const headChildren = []
const createdElements = []
function makeChildList(children) {
  return {
    children,
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
  documentElement: {},
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

const backdropFrames = () => bodyChildren.filter(node => node.tagName === 'IFRAME')
const glassStyles = () => headChildren.filter(node => node.tagName === 'STYLE' && node.attributes.id === 'aura-glass')

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

record('contributes the stage route /aura', () => {
  const route = a.contributions.find(c => c.area === 'routes')
  assert.ok(route, 'no routes contribution')
  assert.deepEqual(route.data, { path: '/aura' })
  assert.equal(typeof route.render, 'function')
})

record('contributes the sidebar nav row', () => {
  const nav = a.contributions.find(c => c.area === 'sidebar.nav')
  assert.ok(nav, 'no sidebar.nav contribution')
  assert.equal(nav.data.path, '/aura')
  assert.equal(nav.data.label, 'Aura')
  assert.equal(nav.data.codicon, 'pulse')
})

record('contributes the palette command', () => {
  const palette = a.contributions.find(c => c.area === 'palette')
  assert.ok(palette, 'no palette contribution')
  assert.equal(palette.data.label, 'Aura: Open stage')
  assert.equal(typeof palette.data.run, 'function')
})

record('does not occupy the status bar', () => {
  assert.ok(!a.contributions.some(c => c.area.startsWith('statusBar.')))
})

record('stage offers a way back to the current chat', () => {
  const stage = renderContribution(a.contributions.find(c => c.area === 'routes'))
  let back = null
  walk(stage, node => { if (node.props && node.props['aria-label'] === 'Back to chat') back = node })
  assert.ok(back, 'no Back to chat button')
  back.props.onClick()
  assert.equal(sdk.calls.navigations.at(-1), '/chat%2F123')
  const saved = sdk.host.state.focusedStoredSessionId
  try {
    sdk.host.state.focusedStoredSessionId = { get: () => null }
    back.props.onClick()
    assert.equal(sdk.calls.navigations.at(-1), '/')
  } finally {
    sdk.host.state.focusedStoredSessionId = saved
  }
})

record('contributes the compact right-hand pane', () => {
  const pane = a.contributions.find(c => c.area === 'panes')
  assert.ok(pane, 'no panes contribution')
  assert.equal(pane.data.placement, 'right')
  assert.deepEqual(pane.data.dock, { pane: 'workspace', pos: 'right' })
  assert.equal(pane.data.width, '320px')
  assert.equal(typeof pane.render, 'function')
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

await recordAsync('backdrop mounts only when Aura is enabled, the theme is aura-live and status is ok', async () => {
  await sleep(30)
  assert.equal(backdropFrames().length, 0, 'backdrop mounted without the aura-live theme')
  const probe = a.contributions.find(c => c.area === 'titleBar.center')
  sdk.themeState.name = 'aura-live'
  renderContribution(probe)
  await sleep(20)
  assert.equal(backdropFrames().length, 1, 'expected exactly one backdrop iframe')
  const frame = backdropFrames()[0]
  assert.match(frame.src, /[?&]overlay=1(?:&|$)/)
  assert.equal(frame.style.position, 'fixed')
  assert.equal(frame.style.inset, '0')
  assert.equal(frame.style.width, '100vw')
  assert.equal(frame.style.height, '100vh')
  assert.equal(frame.style.border, '0')
  assert.equal(frame.style.pointerEvents, 'none')
  assert.equal(frame.style.zIndex, '-1')
  // Visibility is the backdrop's own opacity (default 0.35).
  assert.equal(frame.style.opacity, '0.35')
  assert.equal(frame.style.mixBlendMode, undefined, 'backdrop must not blend over the UI')
  assert.equal(frame.style.background, 'transparent')
  assert.equal(frame.attributes['aria-hidden'], 'true')
  assert.equal(frame.attributes.tabindex, '-1')
  assert.equal(frame.attributes.title, 'Aura backdrop')
  assert.equal(frame.attributes.sandbox, 'allow-scripts allow-same-origin allow-forms allow-downloads')
  assert.equal(frame.attributes.referrerpolicy, 'no-referrer')
  assert.equal(frame.attributes.allow, 'autoplay; fullscreen')
})

await recordAsync('glass style is injected exactly once with translucent theme variables', async () => {
  const probe = a.contributions.find(c => c.area === 'titleBar.center')
  renderContribution(probe)
  a.timers.find(t => t.ms === 250).fn()
  await sleep(30)
  assert.equal(glassStyles().length, 1, 'expected exactly one aura-glass style')
  const css = glassStyles()[0].textContent
  // The theme's own background is painted once on <html>; everything above it is clear.
  assert.match(css, /html \{ background: rgb\(11, 10, 20\) !important; \}/)
  assert.match(css, /body, #root, #app \{ background: transparent !important; \}/)
  // Big areas go fully clear so stacked panels cannot compound to near-solid.
  for (const name of ['--background', '--ui-bg-chrome', '--ui-bg-sidebar', '--ui-chat-surface-background']) {
    assert.match(css, new RegExp(name.replace(/[-]/g, '\\-') + ': transparent !important;'), `${name} not cleared`)
  }
  // --ui-base is the TEXT colour: glass must never touch it.
  assert.doesNotMatch(css, /--ui-base/)
  // Floating surfaces stay 90% solid for readability.
  assert.match(css, /--card: color-mix\(in srgb, rgb\(34, 29, 61\) 90%, transparent\) !important;/)
  assert.equal(backdropFrames().length, 1)
})

await recordAsync('background visibility defaults to 35 percent and clamps to 5..90', async () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let visibility = null
  walk(tree, node => {
    if (!visibility && node.type === 'input' && node.props && node.props['aria-label'] === 'Background visibility') visibility = node
  })
  assert.ok(visibility, 'no Background visibility slider rendered')
  assert.equal(visibility.props.min, 5)
  assert.equal(visibility.props.max, 90)
  assert.equal(visibility.props.value, 35)
  assert.equal(backdropFrames()[0].style.opacity, '0.35')

  visibility.props.onChange({ target: { value: '100' } })
  await sleep(10)
  assert.equal(backdropFrames()[0].style.opacity, '0.9', 'visibility was not clamped to 0.9')

  visibility.props.onChange({ target: { value: '0' } })
  await sleep(10)
  assert.equal(backdropFrames()[0].style.opacity, '0.05', 'visibility was not clamped to 0.05')

  visibility.props.onChange({ target: { value: '18' } })
  await sleep(10)
})

await recordAsync('changing away from aura-live removes the backdrop and glass style', async () => {
  const probe = a.contributions.find(c => c.area === 'titleBar.center')
  sdk.themeState.name = 'nous'
  renderContribution(probe)
  await sleep(10)
  assert.equal(backdropFrames().length, 0, 'backdrop survived a theme change')
  assert.equal(glassStyles().length, 0, 'glass style survived a theme change')

  sdk.themeState.name = 'aura-live'
  renderContribution(probe)
  await sleep(10)
  assert.equal(backdropFrames().length, 1, 'backdrop did not return with the aura-live theme')
  assert.equal(glassStyles().length, 1)
})

await recordAsync('disabling Aura removes the backdrop and enabling restores it', async () => {
  const settings = a.contributions.find(c => c.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let enabledSwitch = null
  walk(tree, node => {
    if (!enabledSwitch && node.props && node.props['aria-label'] === 'Aura enabled') enabledSwitch = node
  })
  assert.ok(enabledSwitch, 'no Aura enabled switch rendered')
  enabledSwitch.props.onCheckedChange(false)
  await sleep(20)
  assert.equal(backdropFrames().length, 0, 'backdrop survived disabling Aura')
  assert.equal(glassStyles().length, 0, 'glass style survived disabling Aura')
  enabledSwitch.props.onCheckedChange(true)
  await sleep(40)
  assert.equal(backdropFrames().length, 1, 'backdrop did not return when Aura was re-enabled')
  assert.equal(glassStyles().length, 1)
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
    const stage = renderContribution(a.contributions.find(c => c.area === 'routes'))
    let error = ''
    walk(stage, node => { if (node.props && node.props.live) error = node.props.live.error })
    assert.match(error, /timed out/i)
    assert.doesNotMatch(error, /secret|token/)
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
      const stage = renderContribution(a.contributions.find(c => c.area === 'routes'))
      let error = ''
    walk(stage, node => { if (node.props && node.props.live) error = node.props.live.error })
      assert.match(error, expected)
      assert.doesNotMatch(error, /secret|token/)
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

record('disposer removes every contribution, clears timers, accent and theme', () => {
  const themeCallsBefore = sdk.calls.themes.length
  disposeA()
  assert.equal(a.contributions.length, 0, 'contributions survived dispose')
  assert.ok(a.timers.every(t => t.cleared), 'a timer survived dispose')
  assert.equal(sdk.calls.accent.at(-1), null, 'accent override survived dispose')
  assert.equal(sdk.calls.themes.length, themeCallsBefore, 'theme switched on a plugin that never opted in')
  assert.equal(backdropFrames().length, 0, 'backdrop iframe survived dispose')
  assert.equal(glassStyles().length, 0, 'glass style survived dispose')
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

record('disabling restores the theme that was active before', () => {
  disposeB()
  assert.equal(sdk.calls.themes.at(-1), 'nous', 'previous theme was not restored')
  assert.equal(b.contributions.length, 0)
})

// ------------------------------------------------------------- scenario C
// Legacy storage: overlayOpacity migrates into glass once; a saved glass wins.

sdk.themeState.name = 'aura-live'
const c = makeCtx({ enabled: true, intensity: 0.5, overlayOpacity: 0.3 })
const disposeC = pluginModule.default.register(c.ctx)

await recordAsync('legacy overlayOpacity migrates into glass', async () => {
  const probe = c.contributions.find(x => x.area === 'titleBar.center')
  renderContribution(probe)
  await sleep(30)
  const settings = c.contributions.find(x => x.area === 'settings.plugins')
  const tree = renderContribution(settings)
  let visibility = null
  walk(tree, node => {
    if (!visibility && node.type === 'input' && node.props && node.props['aria-label'] === 'Background visibility') visibility = node
  })
  assert.ok(visibility, 'no Background visibility slider rendered')
  assert.equal(visibility.props.value, 30, 'overlayOpacity 0.3 was not read as glass 0.3')
  assert.equal(Object.prototype.hasOwnProperty.call(c.storage.get('settings'), 'overlay'), false)
})

record('a saved glass value wins over the legacy overlayOpacity key', () => {
  disposeC()
  sdk.themeState.name = 'aura-live'
  const d = makeCtx({ enabled: true, intensity: 0.5, glass: 0.5, overlayOpacity: 0.3 })
  const disposeD = pluginModule.default.register(d.ctx)
  try {
    const settings = d.contributions.find(x => x.area === 'settings.plugins')
    const tree = renderContribution(settings)
    let visibility = null
    walk(tree, node => {
      if (!visibility && node.type === 'input' && node.props && node.props['aria-label'] === 'Background visibility') visibility = node
    })
    assert.ok(visibility, 'no Background visibility slider rendered')
    assert.equal(visibility.props.value, 50, 'glass 0.5 did not win over overlayOpacity 0.3')
  } finally {
    disposeD()
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
