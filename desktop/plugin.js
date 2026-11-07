/**
 * Aura — desktop half of the Aura Hermes plugin.
 *
 * Aura listens to what this computer is already playing and turns it into a
 * MilkDrop-compatible stage plus an audio-reactive accent. This file is ONLY
 * the desktop half: capture, analysis and the visualizer page belong to the
 * Python/server and web halves. The desktop half reaches them through the one
 * sanctioned door, `ctx.rest('/status')` and `ctx.rest('/control')`
 * (dashboard/plugin_api.py), and hands the returned tokenised URL straight to
 * an iframe.
 *
 * What it contributes (Hermes Desktop plugin SDK only — no core edits):
 *   - a full-page stage at /aura (`ROUTES_AREA`) hosting the visualizer,
 *   - a sidebar row (`SIDEBAR_NAV_AREA`) and a palette command (`PALETTE_AREA`),
 *   - a compact right-hand pane (`panes`) so the stage can sit beside chat,
 *   - an optional `THEMES_AREA` theme ('aura-live') the user must opt into,
 *   - a settings page (`SETTINGS_PLUGINS_AREA`) with enable / reaction strength /
 *     background visibility / motion / accent-follow / theme controls.
 *
 * The SDK has no backdrop slot (see SPIKES.md S1), so selecting the Aura Live
 * theme mounts one click-through iframe behind the app and injects a single
 * glass stylesheet: panels become translucent versions of the ACTIVE theme's
 * own colours while the visualizer sits behind them. The accent is still
 * pulsed by retinting that theme's accent — never by imposing a hue.
 *
 * Plain ESM, loaded uncompiled: `jsx()` calls only, no JSX syntax, no eval,
 * no dynamic import. Imports are limited to @hermes/plugin-sdk, react and
 * react/jsx-runtime. Every contribution and timer returns a disposer, and
 * `register()` returns one disposer that stops polling, clears the accent
 * override, restores the user's previous theme and removes every contribution.
 */

import {
  $accentOverride,
  atom,
  Button,
  host,
  PALETTE_AREA,
  PANES_AREA,
  requestTheme,
  ROUTES_AREA,
  setAccentOverride,
  SETTINGS_PLUGINS_AREA,
  SIDEBAR_NAV_AREA,
  StatusDot,
  Switch,
  THEMES_AREA,
  TITLEBAR_AREAS,
  useTheme,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'aura'
const ROUTE = '/aura'
const THEME_NAME = 'aura-live'
// The contract says /api/state is cheap and safe at <= 4 Hz. One tick is one
// poll of /status (plus /state only while Aura is enabled), and the accent is
// re-applied at most once per tick, so the app never repaints faster than 4 Hz.
const POLL_MS = 250
const ACCENT_MIN_GAP_MS = 250
// Attention moods (approval/error) must not pulse faster than 2 Hz (CONTRACT §4).
const ATTENTION_MIN_GAP_MS = 500
const ACCENT_L_MIN = 0.34
const ACCENT_L_MAX = 0.78

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  intensity: 0.5,
  opacity: 0.75,
  behavior: 'balanced',
  moodReactive: true,
  accentPulse: true,
  autoPreset: true,
  themeOptIn: false,
  glass: 0.35,
  motion: 'both'
})

const GLASS_MIN = 0.05
const GLASS_MAX = 0.9

const BEHAVIORS = ['calm', 'balanced', 'intense']
const MOTIONS = ['designs', 'both', 'music']
const MOTION_LABELS = { designs: 'Designs only', both: 'Designs + music', music: 'Music only' }

const EMPTY_LIVE = Object.freeze({
  ok: false,
  port: null,
  url: '',
  capture: '',
  enabled: false,
  error: '',
  mood: '',
  at: 0
})

// ------------------------------------------------------------------ utilities

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))

const clamp01 = value => {
  const n = Number(value)
  return Number.isFinite(n) ? clamp(n, 0, 1) : 0
}

const clampGlass = value => {
  const n = Number(value)
  return Number.isFinite(n) ? clamp(n, GLASS_MIN, GLASS_MAX) : DEFAULT_SETTINGS.glass
}

/** Normalise #rgb/#rrggbb/#rrggbbaa to a lowercase #rrggbb, or null. */
function normalizeHex(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  const short = /^#([0-9a-f]{3})$/i.exec(raw)
  if (short) {
    const [r, g, b] = short[1].split('')
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(raw)
  return long ? `#${long[1]}`.toLowerCase() : null
}

function hexToHsl(hex) {
  const clean = normalizeHex(hex)
  if (!clean) return null
  const r = parseInt(clean.slice(1, 3), 16) / 255
  const g = parseInt(clean.slice(3, 5), 16) / 255
  const b = parseInt(clean.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
  else if (max === g) h = ((b - r) / d + 2) * 60
  else h = ((r - g) / d + 4) * 60
  return { h, s, l }
}

function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360
  const sat = clamp(s, 0, 1)
  const lum = clamp(l, 0, 1)
  const c = (1 - Math.abs(2 * lum - 1)) * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = lum - c / 2
  let rgb
  if (hue < 60) rgb = [c, x, 0]
  else if (hue < 120) rgb = [x, c, 0]
  else if (hue < 180) rgb = [0, c, x]
  else if (hue < 240) rgb = [0, x, c]
  else if (hue < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  const toHex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`
}

// The renderer always has a document; a headless import (the contract test)
// does not, so every DOM touch is guarded.
const doc = typeof document !== 'undefined' ? document : null

/** Read the theme's published accent token. Never queries app markup. */
function readCssAccent() {
  if (!doc || typeof getComputedStyle !== 'function') return null
  try {
    return normalizeHex(getComputedStyle(doc.documentElement).getPropertyValue('--ui-accent'))
  } catch {
    return null
  }
}

function accentOf(theme) {
  const colors = theme && theme.colors
  if (!colors || typeof colors !== 'object') return ''
  return normalizeHex(colors.accent) || normalizeHex(colors.primary) || normalizeHex(colors.ring) || ''
}

// ------------------------------------------------------------- module state
// Reset by register() so a hot reload starts from a clean slate.

let ctxRef = null
let disposed = false
let pollDisposer = null
let polling = false
let liveFrame = null // latest /state frame — hot path, deliberately not an atom
let liveKey = ''
let backdropEl = null
let backdropUrl = ''
let glassStyleEl = null
let overrideActive = false
let lastAccentHex = null
let lastAccentAt = 0
let prevTheme = null
let themeInfo = { name: '', accent: '' }
let knownTheme = ''
const disposers = []

const $settings = atom({ ...DEFAULT_SETTINGS })
const $live = atom({ ...EMPTY_LIVE })
const $themeApplied = atom(false)

// --------------------------------------------------------------- persistence

function readSettings(ctx) {
  const out = { ...DEFAULT_SETTINGS }
  let raw = null
  try {
    raw = ctx.storage.get('settings', null)
  } catch {
    raw = null
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
    if (Number.isFinite(raw.intensity)) out.intensity = clamp01(raw.intensity)
    if (Number.isFinite(raw.opacity)) out.opacity = clamp01(raw.opacity)
    if (typeof raw.behavior === 'string' && BEHAVIORS.includes(raw.behavior)) out.behavior = raw.behavior
    if (typeof raw.moodReactive === 'boolean') out.moodReactive = raw.moodReactive
    if (typeof raw.accentPulse === 'boolean') out.accentPulse = raw.accentPulse
    // Legacy key from before accent_pulse existed: honour it, never write it.
    else if (typeof raw.followAudio === 'boolean') out.accentPulse = raw.followAudio
    if (typeof raw.autoPreset === 'boolean') out.autoPreset = raw.autoPreset
    if (typeof raw.themeOptIn === 'boolean') out.themeOptIn = raw.themeOptIn
    if (typeof raw.motion === 'string' && MOTIONS.includes(raw.motion)) out.motion = raw.motion
    // Migrate the old overlay strength once: a saved `glass` always wins, and
    // the legacy key is never written back.
    if (Number.isFinite(raw.glass)) out.glass = clampGlass(raw.glass)
    else if (Number.isFinite(raw.overlayOpacity)) out.glass = clampGlass(raw.overlayOpacity)
  }
  return out
}

function writeSettings(patch) {
  const next = { ...$settings.get(), ...patch }
  $settings.set(next)
  try {
    ctxRef?.storage.set('settings', next)
  } catch {
    // Persistence is best-effort; the live value still applies.
  }
  return next
}

function setLive(patch) {
  const next = { ...$live.get(), ...patch }
  $live.set(next)
  return next
}

function setError(message) {
  setLive({ error: typeof message === 'string' ? message : '' })
}

// ------------------------------------------------------------- backdrop theme
// The active `aura-live` theme turns the visualizer into the app's backdrop:
// one click-through iframe behind every panel (z-index -1). Panels stay opaque
// enough to read because glass rewrites their surface variables to translucent
// versions of the theme's own colours.

function backdropSrc(url) {
  if (!url) return ''
  const separator = url.indexOf('?') === -1 ? '?' : '&'
  return `${url}${separator}overlay=1`
}

// Background-only tokens (never ink: `--ui-base` is the text colour). Big
// areas get the full glass; floating surfaces stay more solid so menus,
// cards and bubbles remain readable over the visuals.
const GLASS_AREAS = [
  '--background',
  '--sidebar',
  '--ui-bg-chrome',
  '--ui-bg-sidebar',
  '--ui-bg-editor',
  '--ui-bg-tertiary',
  '--ui-chat-surface-background',
  '--ui-sidebar-surface-background',
  '--ui-editor-surface-background',
  '--ui-terminal-surface-background',
  '--ui-surface-background'
]
const GLASS_FLOATING = [
  '--muted',
  '--card',
  '--popover',
  '--ui-bg-card',
  '--ui-bg-elevated',
  '--ui-widget-surface-background',
  '--ui-chat-bubble-background'
]

/** The browser-resolved colour of a token (handles var(), color-mix(), oklch()). */
function resolvedColor(name) {
  if (!doc || !doc.body || typeof getComputedStyle !== 'function') return ''
  let probe = null
  try {
    probe = doc.createElement('div')
    probe.style.position = 'absolute'
    probe.style.width = '0'
    probe.style.height = '0'
    probe.style.visibility = 'hidden'
    probe.style.backgroundColor = `var(${name})`
    doc.body.appendChild(probe)
    const value = String(getComputedStyle(probe).backgroundColor || '').trim()
    return value && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent' ? value : ''
  } catch {
    return ''
  } finally {
    try {
      if (probe) probe.remove()
    } catch {
      // detached already
    }
  }
}

// Panels stack (window bg under chrome under chat surface), so translucency
// per layer compounds to near-solid. Instead the big areas go fully clear and
// visibility is set in ONE place: the backdrop's opacity over the theme's own
// solid background, painted on <html>. Floating surfaces stay mostly solid.
function glassCss() {
  const base = resolvedColor('--background')
  let declarations = ''
  for (const name of GLASS_AREAS) declarations += `${name}: transparent !important;`
  for (const name of GLASS_FLOATING) {
    const color = resolvedColor(name)
    // !important: the theme writes these inline on <html>; a plain rule loses.
    if (color) declarations += `${name}: color-mix(in srgb, ${color} 90%, transparent) !important;`
  }
  return [
    base ? `html { background: ${base} !important; }` : '',
    'body, #root, #app { background: transparent !important; }',
    `:root { ${declarations} }`
  ].filter(Boolean).join('\n')
}

function applyGlassStyle(glass) {
  if (!doc || !doc.head || typeof doc.head.appendChild !== 'function') return
  // Measure the theme's own colours, not the previous glass.
  if (glassStyleEl) removeGlassStyle()
  if (!glassStyleEl) {
    glassStyleEl = doc.createElement('style')
    glassStyleEl.setAttribute('id', 'aura-glass')
    doc.head.appendChild(glassStyleEl)
  }
  glassStyleEl.textContent = glassCss()
  if (backdropEl) backdropEl.style.opacity = String(clampGlass(glass))
}

function removeGlassStyle() {
  if (!glassStyleEl) return
  try {
    glassStyleEl.remove()
  } catch {
    try {
      if (glassStyleEl.parentNode) glassStyleEl.parentNode.removeChild(glassStyleEl)
    } catch {
      // detached already
    }
  }
  glassStyleEl = null
}

function removeBackdrop() {
  if (backdropEl) {
    try {
      backdropEl.remove()
    } catch {
      try {
        if (backdropEl.parentNode) backdropEl.parentNode.removeChild(backdropEl)
      } catch {
        // detached already
      }
    }
  }
  backdropEl = null
  backdropUrl = ''
  removeGlassStyle()
}

/** Keep exactly one backdrop mounted, in sync with the theme and live status. */
function syncBackdrop() {
  const settings = $settings.get()
  const live = $live.get()
  const url = live.ok && typeof live.url === 'string' && /^https?:\/\//.test(live.url) ? live.url : ''
  // The server's enabled flag is the truth (the pane uses it too); the local
  // copy can be stale, which silently kept the backdrop away.
  const enabled = live.ok ? live.enabled === true : settings.enabled
  const wanted = Boolean(doc && enabled && knownTheme === THEME_NAME && url)
  if (!wanted) {
    removeBackdrop()
    return
  }

  const src = backdropSrc(url)
  if (!backdropEl) {
    if (!doc.body || typeof doc.body.appendChild !== 'function') return
    backdropEl = doc.createElement('iframe')
    backdropEl.setAttribute('aria-hidden', 'true')
    backdropEl.setAttribute('tabindex', '-1')
    backdropEl.setAttribute('title', 'Aura backdrop')
    // Same sandbox/referrer/allow contract as StageFrame.
    backdropEl.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads')
    backdropEl.setAttribute('referrerpolicy', 'no-referrer')
    backdropEl.setAttribute('allow', 'autoplay; fullscreen')
    backdropEl.setAttribute('allowfullscreen', '')
    const style = backdropEl.style
    style.position = 'fixed'
    style.inset = '0'
    style.width = '100vw'
    style.height = '100vh'
    style.border = '0'
    style.pointerEvents = 'none'
    style.zIndex = '-1'
    style.opacity = String(clampGlass(settings.glass))
    style.background = 'transparent'
    backdropUrl = src
    backdropEl.src = src
  } else if (backdropUrl !== src) {
    backdropUrl = src
    backdropEl.src = src
  }
  if (backdropEl.parentNode !== doc.body) doc.body.appendChild(backdropEl)
  applyGlassStyle(settings.glass)
}

// ------------------------------------------------------------- server control

/**
 * Push a change to the Python half. Every ctx.rest call is wrapped: a dead
 * server degrades to a status message, never to a thrown error.
 */
async function pushControl(patch) {
  if (!ctxRef || disposed) return false
  try {
    await ctxRef.rest('/control', { method: 'POST', body: patch, timeoutMs: 5000 })
    return true
  } catch {
    setError('Aura could not apply that change — the local server is not answering.')
    return false
  }
}

async function poll() {
  if (!ctxRef || disposed || polling) return
  polling = true
  try {
    let status = null
    let error = ''
    try {
      status = await ctxRef.rest('/status', { timeoutMs: 10000 })
    } catch (cause) {
      const detail = String(cause && cause.message || '')
      if (/timed?\s*out/i.test(detail)) {
        error = 'The Aura status request timed out while connecting to Hermes.'
      } else if (/profile_scope_mismatch/i.test(detail)) {
        error = 'Hermes rejected the Aura request for the selected profile.'
      } else if (/ticket bootstrap/i.test(detail)) {
        error = 'Hermes could not establish the local gateway connection.'
      } else if (/\b(?:401|403)\b/.test(detail)) {
        error = 'Hermes could not authorize the Aura status request.'
      } else {
        error = 'Hermes could not complete the Aura status request.'
      }
    }

    const ok = Boolean(status && status.ok === true)
    const enabled = ok ? status.enabled === true : $settings.get().enabled
    let frame = null
    if (ok) {
      try {
        frame = await ctxRef.rest('/state', { timeoutMs: 3000 })
      } catch {
        frame = null
      }
    }

    const capture = ok && typeof status.capture === 'string' ? status.capture : ''
    const url = ok && typeof status.url === 'string' && /^https?:\/\//.test(status.url) ? status.url : ''
    const port = ok && Number.isFinite(status.port) ? status.port : null
    const mood = frame && typeof frame.mood === 'string' ? frame.mood : ''
    if (!ok && !error) error = 'Aura’s local server is starting…'

    liveFrame = frame
    const key = [ok, port, capture, enabled, url, error, mood].join('|')
    if (key !== liveKey) {
      liveKey = key
      $live.set({
        ok,
        port,
        url,
        capture,
        enabled,
        error,
        mood,
        at: Date.now()
      })
    }
    syncBackdrop()
    accentStep(Date.now())
  } finally {
    polling = false
  }
}

// ------------------------------------------------------------- accent pulse

/**
 * The base colour is the user's own: an existing accent override if one is
 * set, else the ACTIVE theme's accent (reported by ThemeProbe), else the
 * theme's published --ui-accent token. If none resolves we leave appearance
 * untouched rather than inventing a hue.
 */
function baseAccentHex() {
  const override = $accentOverride.get()
  const fromOverride = normalizeHex(override)
  if (fromOverride) return fromOverride
  const fromTheme = normalizeHex(themeInfo.accent)
  if (fromTheme) return fromTheme
  return readCssAccent()
}

/**
 * Shift ONLY lightness/saturation of the user's accent inside a readable band.
 * The hue is never replaced, so the pulse composes with whatever skin is active.
 */
function pulseHex(base, level, intensity) {
  const hsl = hexToHsl(base)
  if (!hsl) return null
  const swing = 0.2 * clamp01(intensity)
  const lightness = clamp(hsl.l + (clamp01(level) - 0.42) * swing, ACCENT_L_MIN, ACCENT_L_MAX)
  const saturation = clamp(hsl.s * (0.85 + 0.3 * clamp01(level)), 0.18, 0.95)
  return hslToHex(hsl.h, saturation, lightness)
}

function clearAccent(force = false) {
  if (!overrideActive && !force) return
  overrideActive = false
  lastAccentHex = null
  lastAccentAt = 0
  setAccentOverride(null)
}

function accentStep(now) {
  if (disposed) return
  const settings = $settings.get()
  const live = $live.get()
  if (!live.ok || !live.enabled || !settings.accentPulse || settings.intensity <= 0) {
    clearAccent()
    return
  }
  if (doc && doc.hidden) return // background window: no repaint work
  const frame = liveFrame || {}
  // The agent can change intensity through /control too: honour the lower of
  // the two so a "quiet the room" request is not overridden by the slider.
  const serverIntensity = Number.isFinite(frame.intensity) ? clamp01(frame.intensity) : null
  const intensity = serverIntensity === null ? settings.intensity : Math.min(settings.intensity, serverIntensity)
  if (intensity <= 0) {
    clearAccent()
    return
  }
  const attention = frame.mood === 'approval' || frame.mood === 'error'
  const minGap = attention ? ATTENTION_MIN_GAP_MS : ACCENT_MIN_GAP_MS
  if (now - lastAccentAt < minGap) return
  const base = baseAccentHex()
  if (!base) return
  const next = pulseHex(base, clamp01(frame.level), intensity)
  if (!next || next === lastAccentHex) return
  lastAccentHex = next
  lastAccentAt = now
  overrideActive = true
  setAccentOverride(next)
}

// ------------------------------------------------------------------- themes

function applyThemeIfOptedIn() {
  if (disposed || !ctxRef || $themeApplied.get()) return Boolean($themeApplied.get())
  const before = themeInfo.name
  if (!before) return false // the probe has not mounted yet; it retries
  if (!requestTheme(THEME_NAME)) return false // refused rather than coerced
  prevTheme = before
  $themeApplied.set(true)
  return true
}

function restoreTheme() {
  if (!$themeApplied.get()) return
  $themeApplied.set(false)
  const back = prevTheme
  prevTheme = null
  if (back) requestTheme(back)
}

/** The probe reports the active skin. A user skin change drops our retint so
 *  the pulse re-derives from the new accent instead of carrying the old hue. */
function onThemeName(name) {
  if (typeof name !== 'string' || !name || name === knownTheme) return
  const first = !knownTheme
  knownTheme = name
  if (!first && overrideActive) {
    clearAccent(true)
  }
  syncBackdrop()
  if ($settings.get().themeOptIn && !$themeApplied.get()) applyThemeIfOptedIn()
}

function setThemeOptIn(on) {
  writeSettings({ themeOptIn: Boolean(on) })
  if (on) applyThemeIfOptedIn()
  else restoreTheme()
}

// ------------------------------------------------------------- enable switch

async function setEnabled(next) {
  if (!ctxRef || disposed) return
  const enabled = Boolean(next)
  writeSettings({ enabled })
  if (!enabled) {
    clearAccent(true)
    restoreTheme()
  } else if ($settings.get().themeOptIn) {
    applyThemeIfOptedIn()
  }
  syncBackdrop()
  const ok = await pushControl({ enabled })
  if (ok) {
    setLive({ enabled, error: '' })
    void poll()
  }
}

async function setOpacity(next) {
  if (!ctxRef || disposed) return
  const opacity = clamp01(next)
  writeSettings({ opacity })
  await pushControl({ opacity })
}

async function setGlass(next) {
  if (!ctxRef || disposed) return
  writeSettings({ glass: clampGlass(next) })
  syncBackdrop()
}

async function setMotion(next) {
  if (!ctxRef || disposed) return
  const motion = MOTIONS.includes(next) ? next : 'both'
  writeSettings({ motion })
  await pushControl({ motion })
}

async function setBehavior(next) {
  if (!ctxRef || disposed) return
  const behavior = BEHAVIORS.includes(next) ? next : 'balanced'
  writeSettings({ behavior })
  await pushControl({ behavior })
}

async function setMoodReactive(next) {
  if (!ctxRef || disposed) return
  const moodReactive = Boolean(next)
  writeSettings({ moodReactive })
  if (!moodReactive) {
    // No stale mood-derived accent survives the switch-off.
    clearAccent(true)
  }
  await pushControl({ mood_reactive: moodReactive })
  if (moodReactive) void poll()
}

async function setAccentPulse(next) {
  if (!ctxRef || disposed) return
  const accentPulse = Boolean(next)
  writeSettings({ accentPulse })
  if (!accentPulse) {
    // HARD RULE: the accent pulse must stop through setAccentOverride(null).
    clearAccent(true)
  } else {
    accentStep(Date.now())
  }
  await pushControl({ accent_pulse: accentPulse })
}

async function setAutoPreset(next) {
  if (!ctxRef || disposed) return
  const autoPreset = Boolean(next)
  writeSettings({ autoPreset })
  await pushControl({ auto_preset: autoPreset })
}

// ---------------------------------------------------------------------- UI

function ThemeProbe() {
  const active = useTheme()
  const name = active && typeof active.themeName === 'string' ? active.themeName : ''
  const accent = accentOf(active && active.theme)
  if (name) themeInfo.name = name
  if (accent) themeInfo.accent = accent
  useEffect(() => {
    onThemeName(name)
  }, [name])
  return null
}

function StageFrame({ url }) {
  return jsx('iframe', {
    src: url,
    title: 'Aura visualizer',
    // Same-origin is required: the page talks to its own 127.0.0.1 origin
    // (WebSocket token + fetch) and the server sends no CORS headers.
    sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads',
    referrerPolicy: 'no-referrer',
    allow: 'autoplay; fullscreen',
    allowFullScreen: true,
    style: {
      flex: 1,
      width: '100%',
      height: '100%',
      minWidth: 0,
      minHeight: 0,
      border: 0,
      display: 'block',
      background: 'var(--ui-bg)'
    }
  })
}

function StageMessage({ live, onRetry, busy }) {
  const reason = live.error || (live.ok ? 'Aura is warming up…' : 'Aura’s local server is not running.')
  return jsxs('div', {
    style: {
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      padding: 24,
      textAlign: 'center'
    },
    children: [
      jsx('div', {
        key: 'title',
        style: { fontSize: 13, color: 'var(--ui-text-primary)' },
        children: 'The Aura stage is not available yet.'
      }),
      jsx('div', {
        key: 'reason',
        style: { fontSize: 12, color: 'var(--ui-text-secondary)', maxWidth: 420 },
        children: reason
      }),
      jsx('div', {
        key: 'hint',
        style: { fontSize: 11, color: 'var(--ui-text-tertiary)', maxWidth: 460 },
        children:
          'Try again. If this continues, check the Hermes desktop log for the Aura status request.'
      }),
      jsx(Button, {
        key: 'retry',
        size: 'sm',
        variant: 'outline',
        disabled: busy,
        onClick: onRetry,
        children: busy ? 'Checking…' : 'Retry'
      })
    ]
  })
}

function Stage({ compact = false }) {
  const live = useValue($live)
  const [busy, setBusy] = useState(false)
  const ready = live.ok && typeof live.url === 'string' && live.url.length > 0
  const retry = () => {
    setBusy(true)
    void poll().finally(() => setBusy(false))
  }

  const body = ready
    ? jsx(StageFrame, { url: live.url })
    : jsx(StageMessage, { live, onRetry: retry, busy })

  if (!compact) {
    return jsxs('div', {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden'
      },
      children: [
        jsx('div', {
          key: 'toolbar',
          style: { display: 'flex', alignItems: 'center', padding: '6px 10px', flex: 'none', borderBottom: '1px solid var(--ui-stroke-secondary)' },
          children: jsx(Button, {
            variant: 'ghost',
            size: 'sm',
            'aria-label': 'Back to chat',
            onClick: () => {
              const focused = host.state && host.state.focusedStoredSessionId
              const id = focused && typeof focused.get === 'function' ? focused.get() : null
              host.navigate(id ? `/${encodeURIComponent(id)}` : '/')
            },
            children: '← Back to chat'
          })
        }),
        body
      ]
    })
  }

  const capture = live.capture && live.capture !== 'none' ? live.capture : ''
  const state = live.ok ? (live.enabled ? 'on' : 'off') : 'offline'
  return jsxs('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      minWidth: 0,
      minHeight: 0,
      overflow: 'hidden'
    },
    children: [
      jsxs('div', {
        key: 'head',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          flex: 'none',
          borderBottom: '1px solid var(--ui-stroke-secondary)'
        },
        children: [
          jsx(StatusDot, { key: 'dot', tone: live.ok ? (live.enabled ? 'good' : 'muted') : 'warn' }),
          jsx('span', {
            key: 'name',
            style: { fontSize: 12, color: 'var(--ui-text-primary)' },
            children: 'Aura'
          }),
          jsx('span', {
            key: 'state',
            style: { fontSize: 11, color: 'var(--ui-text-tertiary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            children: capture ? `${state} · ${capture}` : state
          }),
          jsx(Button, {
            key: 'open',
            variant: 'ghost',
            size: 'micro',
            title: 'Open the full Aura stage',
            onClick: () => {
              try {
                host.navigate(ROUTE)
              } catch {
                // ignore
              }
            },
            children: 'Open'
          })
        ]
      }),
      jsx('div', { key: 'body', style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }, children: body })
    ]
  })
}

function AuraSettings() {
  const settings = useValue($settings)
  const live = useValue($live)
  const applied = useValue($themeApplied)

  const serverLine = live.ok
    ? `Server reachable on 127.0.0.1${live.port ? `:${live.port}` : ''}${live.capture ? ` · capture: ${live.capture}` : ''}`
    : live.error || 'Server not reachable.'

  const row = (label, hint, control) =>
    jsxs('div', {
      style: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' },
      children: [
        jsxs('div', {
          key: 'label',
          style: { flex: 1, minWidth: 0 },
          children: [
            jsx('div', { key: 'title', style: { fontSize: 12, color: 'var(--ui-text-primary)' }, children: label }),
            jsx('div', { key: 'hint', style: { fontSize: 11, color: 'var(--ui-text-tertiary)' }, children: hint })
          ]
        }),
        jsx('div', { key: 'control', style: { flex: 'none', display: 'flex', alignItems: 'center' }, children: control })
      ]
    })

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 2, padding: '12px 4px', maxWidth: 640 },
    children: [
      jsx('h3', { key: 'title', style: { margin: 0, fontSize: 13, color: 'var(--ui-text-primary)' }, children: 'Aura' }),
      jsx('div', {
        key: 'server',
        style: { fontSize: 11, color: 'var(--ui-text-tertiary)', paddingBottom: 6 },
        children: serverLine
      }),
      jsx('div', {
        key: 'enabled',
        children: row(
          'Aura enabled',
          'Listens to system audio and drives the stage, the pane and the accent.',
          jsx(Switch, {
            checked: settings.enabled,
            'aria-label': 'Aura enabled',
            onCheckedChange: value => {
              void setEnabled(value)
            }
          })
        )
      }),
      jsx('div', {
        key: 'intensity',
        children: row(
          'Reaction strength',
          'How strongly audio and mood move the stage and the accent. 0 returns your theme’s own accent.',
          jsx('input', {
            type: 'range',
            min: 0,
            max: 1,
            step: 0.05,
            value: settings.intensity,
            disabled: settings.motion === 'designs',
            'aria-label': 'Reaction strength',
            style: { width: 160, accentColor: 'var(--ui-accent)' },
            onChange: event => {
              const intensity = clamp01(event && event.target ? event.target.value : 0)
              writeSettings({ intensity })
              if (intensity <= 0) clearAccent(true)
              else accentStep(Date.now())
              void pushControl({ intensity })
            }
          })
        )
      }),
      jsx('div', {
        key: 'opacity',
        children: row(
          'Visual opacity',
          'Dims the stage and its scrim together; chat text and controls stay fully legible.',
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: 8 },
            children: [
              jsx('input', {
                key: 'slider',
                type: 'range',
                min: 0,
                max: 100,
                step: 1,
                value: Math.round(settings.opacity * 100),
                'aria-label': 'Visual opacity',
                style: { width: 140, accentColor: 'var(--ui-accent)' },
                onChange: event => {
                  const raw = Number(event && event.target ? event.target.value : 75)
                  const opacity = clamp01(raw / 100)
                  void setOpacity(opacity)
                }
              }),
              jsx('span', {
                key: 'out',
                style: { fontSize: 11, color: 'var(--ui-text-tertiary)', minWidth: 32, fontVariantNumeric: 'tabular-nums' },
                children: `${Math.round(settings.opacity * 100)}%`
              })
            ]
          })
        )
      }),
      jsx('div', {
        key: 'glass',
        children: row(
          'Background visibility',
          'How much the Aura visuals show through the frosted panels. Lower keeps text crisp.',
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: 8 },
            children: [
              jsx('input', {
                key: 'slider',
                type: 'range',
                min: 5,
                max: 90,
                step: 1,
                value: Math.round(settings.glass * 100),
                'aria-label': 'Background visibility',
                style: { width: 140, accentColor: 'var(--ui-accent)' },
                onChange: event => {
                  const raw = Number(event && event.target ? event.target.value : 35)
                  void setGlass(raw / 100)
                }
              }),
              jsx('span', {
                key: 'out',
                style: { fontSize: 11, color: 'var(--ui-text-tertiary)', minWidth: 32, fontVariantNumeric: 'tabular-nums' },
                children: `${Math.round(settings.glass * 100)}%`
              })
            ]
          })
        )
      }),
      jsx('div', {
        key: 'motion',
        children: row(
          'Motion source',
          'Designs only always animates; Designs + music follows playback and rests on designs; Music only settles in silence.',
          jsx('select', {
            value: settings.motion,
            'aria-label': 'Motion source',
            style: {
              font: 'inherit',
              fontSize: 11,
              color: 'var(--ui-text-primary)',
              background: 'var(--ui-bg)',
              border: '1px solid var(--ui-stroke-secondary)',
              borderRadius: 6,
              padding: '3px 6px'
            },
            onChange: event => {
              const value = event && event.target ? String(event.target.value) : 'both'
              void setMotion(value)
            },
            children: MOTIONS.map(name =>
              jsx('option', { key: name, value: name, children: MOTION_LABELS[name] })
            )
          })
        )
      }),
      jsx('div', {
        key: 'behavior',
        children: row(
          'Behaviour profile',
          'calm: lower ceiling, no strobe, no hard pulses. intense: faster pulse, stronger mood shifts.',
          jsx('select', {
            value: settings.behavior,
            'aria-label': 'Behaviour profile',
            style: {
              font: 'inherit',
              fontSize: 11,
              color: 'var(--ui-text-primary)',
              background: 'var(--ui-bg)',
              border: '1px solid var(--ui-stroke-secondary)',
              borderRadius: 6,
              padding: '3px 6px'
            },
            onChange: event => {
              const value = event && event.target ? String(event.target.value) : 'balanced'
              void setBehavior(value)
            },
            children: BEHAVIORS.map(name =>
              jsx('option', { key: name, value: name, children: name })
            )
          })
        )
      }),
      jsx('div', {
        key: 'mood',
        children: row(
          'React to agent mood',
          'Lets thinking, tool, approval and error change the stage. Off drops any held mood.',
          jsx(Switch, {
            checked: settings.moodReactive,
            'aria-label': 'React to agent mood',
            onCheckedChange: value => {
              void setMoodReactive(value)
            }
          })
        )
      }),
      jsx('div', {
        key: 'accent',
        children: row(
          'Accent pulse',
          'Pulses the accent of the theme you are using; the hue is never replaced.',
          jsx(Switch, {
            checked: settings.accentPulse,
            'aria-label': 'Accent pulse',
            onCheckedChange: value => {
              void setAccentPulse(value)
            }
          })
        )
      }),
      jsx('div', {
        key: 'autoPreset',
        children: row(
          'Automatic presets',
          'Lets preset rotation follow the music and mood. Off keeps the current preset.',
          jsx(Switch, {
            checked: settings.autoPreset,
            'aria-label': 'Automatic presets',
            onCheckedChange: value => {
              void setAutoPreset(value)
            }
          })
        )
      }),
      jsx('div', {
        key: 'theme',
        children: row(
          'Use Aura theme',
          applied
            ? 'Aura Live is active. Turning this off restores the theme you had before.'
            : 'Optional deep-stage palette. Your current theme is restored when you turn it off.',
          jsx(Switch, {
            checked: settings.themeOptIn,
            'aria-label': 'Use Aura theme',
            onCheckedChange: value => setThemeOptIn(value)
          })
        )
      })
    ]
  })
}

// --------------------------------------------------------------- theme data
// A contributed DesktopTheme must carry literal colours (the SDK has no token
// resolution inside `data`), so this is the one place hex values are correct.
const AURA_THEME = {
  name: THEME_NAME,
  label: 'Aura Live',
  description: 'Deep-stage palette with an electric accent, for Aura’s visualizer page.',
  colors: {
    background: '#f7f5ff',
    foreground: '#1a1730',
    card: '#ffffff',
    cardForeground: '#1a1730',
    muted: '#ece8fb',
    mutedForeground: '#6b6484',
    popover: '#ffffff',
    popoverForeground: '#1a1730',
    primary: '#6f57f0',
    primaryForeground: '#ffffff',
    secondary: '#e7e1fa',
    secondaryForeground: '#241f45',
    accent: '#7f66ff',
    accentForeground: '#ffffff',
    border: '#d8d2ee',
    input: '#ffffff',
    ring: '#6f57f0',
    destructive: '#d93a5c',
    destructiveForeground: '#ffffff'
  },
  darkColors: {
    background: '#0b0a14',
    foreground: '#e9e6f7',
    card: '#12101f',
    cardForeground: '#e9e6f7',
    muted: '#1a1730',
    mutedForeground: '#a8a2c4',
    popover: '#141126',
    popoverForeground: '#e9e6f7',
    primary: '#8f7bff',
    primaryForeground: '#0b0a14',
    secondary: '#221d3d',
    secondaryForeground: '#d9d3f2',
    accent: '#b7a4ff',
    accentForeground: '#0b0a14',
    border: '#2a2444',
    input: '#221d3d',
    ring: '#8f7bff',
    destructive: '#ff5f7e',
    destructiveForeground: '#0b0a14'
  },
  typography: {
    fontSans: 'Inter, system-ui, sans-serif',
    fontMono: 'ui-monospace, SFMono-Regular, Menlo, monospace'
  }
}

// --------------------------------------------------------------- teardown

/** Instance guard: a hot reload registers a new instance, and a late call to
 *  the OLD disposer must not tear down the new one. */
let instanceSeq = 0

function teardown() {
  if (pollDisposer) {
    try {
      pollDisposer()
    } catch {
      // already cleared
    }
    pollDisposer = null
  }
  clearAccent(true)
  restoreTheme()
  removeBackdrop()
  while (disposers.length) {
    const off = disposers.pop()
    try {
      off()
    } catch {
      // one broken disposer must not strand the rest
    }
  }
  ctxRef = null
  liveFrame = null
  liveKey = ''
  prevTheme = null
  themeInfo = { name: '', accent: '' }
  knownTheme = ''
  $settings.set({ ...DEFAULT_SETTINGS })
  $live.set({ ...EMPTY_LIVE })
  $themeApplied.set(false)
}

// ------------------------------------------------------------------- export

export default {
  id: ID,
  name: 'Aura',
  description:
    'Audio-reactive stage, accent pulse and optional theme for what this computer is playing. Local only: no recording, no account, no sound of its own.',
  register(ctx) {
    // Reset first: a hot reload must not inherit the previous instance's state.
    const mine = ++instanceSeq
    const dispose = () => {
      if (disposed || mine !== instanceSeq) return
      disposed = true
      teardown()
    }
    disposed = false
    // A hot reload must not inherit a stale backdrop from the previous instance.
    removeBackdrop()
    ctxRef = ctx
    polling = false
    pollDisposer = null
    liveFrame = null
    liveKey = ''
    overrideActive = false
    lastAccentHex = null
    lastAccentAt = 0
    prevTheme = null
    themeInfo = { name: '', accent: '' }
    knownTheme = ''
    disposers.length = 0
    $themeApplied.set(false)
    const settings = readSettings(ctx)
    $settings.set(settings)
    $live.set({ ...EMPTY_LIVE })

    const track = disposer => {
      if (typeof disposer === 'function') disposers.push(disposer)
    }

    track(
      ctx.register({
        id: 'stage',
        area: ROUTES_AREA,
        title: 'Aura',
        data: { path: ROUTE },
        render: () => jsx(Stage, {})
      })
    )

    track(
      ctx.register({
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        data: { path: ROUTE, label: 'Aura', codicon: 'pulse' }
      })
    )

    track(
      ctx.register({
        id: 'open-stage',
        area: PALETTE_AREA,
        data: {
          id: 'aura.open',
          label: 'Aura: Open stage',
          keywords: ['aura', 'visualizer', 'milkdrop', 'music', 'stage', 'audio'],
          run: () => {
            try {
              host.navigate(ROUTE)
            } catch {
              // ignore
            }
          }
        }
      })
    )

    track(
      ctx.register({
        id: 'pane',
        area: PANES_AREA,
        title: 'Aura',
        data: {
          placement: 'right',
          dock: { pane: 'workspace', pos: 'right' },
          width: '320px',
          minWidth: '240px'
        },
        render: () => jsx(Stage, { compact: true })
      })
    )

    // An invisible, permanently mounted probe: titlebar slots stay mounted
    // across navigation, so this is where the active theme is read (useTheme
    // is a hook) without reaching into app markup.
    track(
      ctx.register({
        id: 'theme-probe',
        area: TITLEBAR_AREAS.center,
        render: () => jsx(ThemeProbe, {})
      })
    )

    track(
      ctx.register({
        id: THEME_NAME,
        area: THEMES_AREA,
        data: AURA_THEME
      })
    )

    // Settings ▸ Plugins. Older hosts without registerSettingsPage get the
    // same page as a plain SETTINGS_PLUGINS_AREA contribution.
    if (typeof ctx.registerSettingsPage === 'function') {
      track(
        ctx.registerSettingsPage({
          id: 'settings',
          title: 'Aura',
          icon: 'pulse',
          render: () => jsx(AuraSettings, {})
        })
      )
    } else {
      track(
        ctx.register({
          id: 'settings',
          area: SETTINGS_PLUGINS_AREA,
          title: 'Aura',
          data: { children: [], icon: 'pulse' },
          render: () => jsx(AuraSettings, {})
        })
      )
    }

    // Polling is the only timer; the host owns it, so it cannot outlive the
    // plugin even if the returned disposer is never called.
    pollDisposer = ctx.setInterval(() => {
      void poll()
    }, POLL_MS)

    if (doc) {
      track(
        ctx.addEventListener(doc, 'visibilitychange', () => {
          if (!doc.hidden) void poll()
        })
      )
    }

    if (typeof ctx.onDispose === 'function') ctx.onDispose(dispose)

    void poll()
    if (settings.themeOptIn) applyThemeIfOptedIn()

    return dispose
  }
}
