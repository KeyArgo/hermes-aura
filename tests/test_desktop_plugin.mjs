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
 *   4. the polling interval is never faster than 4 Hz,
 *   5. the static SDK rules hold: no eval / new Function / JSX / dynamic
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

  return { ctx, contributions, timers, controls, disposers }
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
  navigate: route => { calls.navigations.push(route) },
  notify: message => { calls.notifications.push(message) }
}

export const useValue = store => store.get()

export const useTheme = () => ({
  themeName: 'nous',
  theme: { name: 'nous', colors: { accent: '#8b7cff', primary: '#8b7cff', ring: '#8b7cff' } },
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
// outside a renderer; the test only invokes the theme probe and the chip.
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
// background-window check; a minimal stand-in keeps the import headless.
globalThis.document = {
  hidden: false,
  visibilityState: 'visible',
  documentElement: {},
  addEventListener() {},
  removeEventListener() {}
}
globalThis.getComputedStyle = () => ({
  getPropertyValue: name => (name === '--ui-accent' ? '#8b7cff' : '')
})

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

record('contributes the status-bar chip', () => {
  const chip = a.contributions.find(c => c.area === 'statusBar.right')
  assert.ok(chip, 'no statusBar.right contribution')
  assert.equal(typeof chip.render, 'function')
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

await recordAsync('status-bar chip toggles Aura off and opens the stage', async () => {
  const chip = a.contributions.find(c => c.area === 'statusBar.right')
  const button = renderContribution(chip)
  assert.equal(typeof button.props.onClick, 'function', 'chip has no onClick')
  button.props.onClick()
  await sleep(30)
  assert.deepEqual(a.controls.at(-1), { enabled: false })
  assert.ok(sdk.calls.navigations.includes('/aura'), 'did not navigate to /aura')
})

record('disposer removes every contribution, clears timers, accent and theme', () => {
  const themeCallsBefore = sdk.calls.themes.length
  disposeA()
  assert.equal(a.contributions.length, 0, 'contributions survived dispose')
  assert.ok(a.timers.every(t => t.cleared), 'a timer survived dispose')
  assert.equal(sdk.calls.accent.at(-1), null, 'accent override survived dispose')
  assert.equal(sdk.calls.themes.length, themeCallsBefore, 'theme switched on a plugin that never opted in')
  assert.doesNotThrow(() => disposeA(), 'dispose is not idempotent')
})

// ------------------------------------------------------------- scenario B

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

// --------------------------------------------------------------- reporting

console.log(results.join('\n'))
console.log(`\n${results.length - failed} passed, ${failed} failed`)

try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch {
  // the scratch dir is pruned anyway
}

if (failed > 0) process.exitCode = 1
