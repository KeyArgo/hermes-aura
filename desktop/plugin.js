/**
 * Aura — desktop half of the Aura Hermes plugin.
 *
 * Aura listens to what this computer is already playing and turns it into a
 * MilkDrop-compatible window visual plus an audio-reactive accent. This file
 * is ONLY the desktop half: capture, analysis and the visualizer page belong
 * to the Python/server and web halves. The desktop half reaches them through
 * the one sanctioned door, `ctx.rest('/status')` and `ctx.rest('/control')`
 * (dashboard/plugin_api.py), and hands the returned tokenised URL straight to
 * an iframe.
 *
 * What it contributes (Hermes Desktop plugin SDK only — no core edits):
 *   - a settings page (`SETTINGS_PLUGINS_AREA`) with enable / reaction strength /
 *     motion / accent-follow / window visual / theme controls, and Restore my
 *     theme,
 *   - an optional `THEMES_AREA` theme ('aura-live') the user must opt into,
 *   - "Visual behind the app": one fixed, click-through backdrop iframe at
 *     z-index -1 plus a single `#aura-glass` stylesheet that clears the app's
 *     own big surfaces so the moving visual shows through. It appears only
 *     when Aura is enabled AND the user opted in (the windowVisual switch or
 *     the Aura Live theme) and a live URL exists. Turning the visual off,
 *     turning Aura off, Restore my theme and dispose remove both again. If
 *     the visual is switched on while Aura is off, Aura is enabled through
 *     the same door the "Aura enabled" switch uses.
 *   - a status-bar quick menu (`STATUSBAR_AREAS.right`): a small "A" glyph
 *     button (dim when Aura is off, accent when on, with a tiny dot that
 *     breathes only while the visual is actually moving) opens a host
 *     Popover carrying Aura on/off, "Reacts to", intensity, transparency
 *     (opacity), style (behaviour), "Gentle motion (motion-sensitive)" and
 *     an "All Aura settings" jump. Every control calls the SAME handler the
 *     settings page uses (writeSettings + pushControl); the Popover itself
 *     owns Escape/outside-click/focus, and no stylesheet or listener is
 *     added for it.
 *   - an invisible titlebar probe (`TITLEBAR_AREAS.center`) that reads the
 *     active theme (useTheme is a hook),
 *   - an opt-in, audio-reactive accent pulse via the sanctioned
 *     `setAccentOverride`.
 *
 * The old full-page stage and everything that opened it (the `/aura` route,
 * the sidebar row, the palette command and the compact pane) was removed: the
 * backdrop and the Settings page are the product.
 *
 * Host safety: the backdrop iframe and the `#aura-glass` style — mounted only
 * behind the opt-in above — are the only host DOM Aura touches; nothing is
 * injected while nothing is opted in, and the host `html`/`body`/root styles
 * are never written. All other appearance effects go through the SDK
 * (`setAccentOverride`, `requestTheme`). Accent pulse and the Aura Live theme
 * are opt-in and off by default.
 *
 * Plain ESM, loaded uncompiled: `jsx()` calls only, no JSX syntax, no eval,
 * no dynamic import. Imports are limited to @hermes/plugin-sdk, react and
 * react/jsx-runtime. Every contribution and timer returns a disposer, and
 * `register()` returns one disposer that stops polling, clears the accent
 * override, restores the user's previous theme, removes the backdrop and its
 * glass style, and removes every contribution.
 */

import {
  $accentOverride,
  atom,
  Button,
  host,
  Popover,
  PopoverContent,
  PopoverTrigger,
  requestTheme,
  setAccentOverride,
  SETTINGS_PLUGINS_AREA,
  STATUSBAR_AREAS,
  Switch,
  THEMES_AREA,
  TITLEBAR_AREAS,
  useTheme,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'aura'
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
  opacity: 0.35,
  behavior: 'balanced',
  moodReactive: true,
  accentPulse: false,
  autoPreset: true,
  themeOptIn: false,
  windowVisual: false,
  motion: 'agent_music',
  reducedMotion: false,
  showWhen: 'always'
})

// The plugin's own entry inside Settings ▸ Plugins (same shape the host's
// own plugin-settings palette commands use).
const SETTINGS_NAV_PATH = '/settings?tab=plugins&agent=aura'

// Breathing levels for the status-bar pulse dot, walked one step per poll
// tick (4 Hz): a gentle rise and fall while the visual is moving. Reduced
// motion freezes the dot at PULSE_REDUCED_OPACITY instead of cycling.
const PULSE_LEVELS = Object.freeze([0.18, 0.45, 0.8, 1, 0.8, 0.45])
const PULSE_REDUCED_OPACITY = 0.55
// Above this audio level, and not flagged silent, counts as "music playing".
const PULSE_MUSIC_LEVEL = 0.02

// "Show: Only while active" timing. The visual is mounted only after 300 ms
// of sustained activity, stays through short idle gaps (hysteresis so tool
// calls do not flicker), and fades out after 2.5 s idle. The opacity ramp is
// capped at 1.5 s, or 200 ms under reduced motion.
const SHOW_FADE_IN_DELAY_MS = 300
const SHOW_FADE_OUT_IDLE_MS = 2500
const SHOW_FADE_MS = 1500
const SHOW_FADE_REDUCED_MS = 200
const SHOW_FADE_STEP_MS = 250

const SHOW_WHEN_OPTIONS = ['always', 'active']
const SHOW_WHEN_LABELS = { always: 'Always', active: 'Only while active' }

const BEHAVIORS = ['calm', 'balanced', 'intense']
const BEHAVIOR_LABELS = { calm: 'Calm', balanced: 'Balanced', intense: 'Intense' }
// `designs` is accepted for configs saved before the agent modes existed, but
// it is no longer offered in the select. The four offered values are below.
const MOTIONS = ['designs', 'both', 'music', 'agent', 'agent_music']
const MOTION_OPTIONS = ['both', 'music', 'agent', 'agent_music']
const MOTION_LABELS = {
  designs: 'Designs only (legacy)',
  both: 'Music, or gentle designs',
  music: 'Music only',
  agent: 'Agent activity',
  agent_music: 'Agent + music (default)'
}

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

// "Only while active" fade state. showVisible means the backdrop/glass are
// allowed to exist; showOpacity is the local fade factor applied to the
// iframe. Timers are host-owned and every one is cancelled on reset/dispose.
let showVisible = false
let showOpacity = 0
let showTarget = 0
let showDelayTimer = null
let showIdleTimer = null
let showRampTimer = null
let showRampLeft = 0
let showRampDelta = 0
let showRampStepMs = SHOW_FADE_STEP_MS
let showEpoch = 0

const $settings = atom({ ...DEFAULT_SETTINGS })
const $live = atom({ ...EMPTY_LIVE })
const $themeApplied = atom(false)
// Quick-menu state: which way the host Popover is open (so dispose can close
// it) and the current pulse-dot opacity (recomputed by the poll ticker).
const $menuOpen = atom(false)
const $pulse = atom(0)
let pulseIndex = 0

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
    if (typeof raw.windowVisual === 'boolean') out.windowVisual = raw.windowVisual
    if (typeof raw.motion === 'string' && MOTIONS.includes(raw.motion)) out.motion = raw.motion
    if (typeof raw.reducedMotion === 'boolean') out.reducedMotion = raw.reducedMotion
    if (typeof raw.showWhen === 'string' && SHOW_WHEN_OPTIONS.includes(raw.showWhen)) out.showWhen = raw.showWhen
    // Legacy `glass` / `overlayOpacity` keys are ignored: the old host-glass
    // visibility slider is gone; windowVisual + the backdrop replace it.
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

// Optional whole-window MilkDrop backdrop, enabled only by the user.
// `reduced-motion=1` is the backdrop page's own force-switch (web/aura.js
// FORCE_REDUCED) and is also mirrored to the server's config through
// /control, so both halves agree on the motion-sensitivity setting.
function backdropSrc(url) {
  if (!url) return ''
  const params = ['overlay=1']
  if ($settings.get().reducedMotion) params.push('reduced-motion=1')
  const separator = url.indexOf('?') === -1 ? '?' : '&'
  return `${url}${separator}${params.join('&')}`
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

function applyGlassStyle() {
  if (!doc || !doc.head || typeof doc.head.appendChild !== 'function') return
  // Measure the theme's own colours, not the previous glass.
  if (glassStyleEl) removeGlassStyle()
  glassStyleEl = doc.createElement('style')
  glassStyleEl.setAttribute('id', 'aura-glass')
  doc.head.appendChild(glassStyleEl)
  glassStyleEl.textContent = glassCss()
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

function liveUrl() {
  const live = $live.get()
  return live.ok && typeof live.url === 'string' && /^https?:\/\//.test(live.url) ? live.url : ''
}

/** The opt-in gate for the backdrop, independent of the fade state. */
function showEligible() {
  const settings = $settings.get()
  const live = $live.get()
  const enabled = live.ok ? live.enabled === true : settings.enabled
  return Boolean(doc && enabled && (knownTheme === THEME_NAME || settings.windowVisual) && liveUrl())
}

// Host-owned timers: cancel through the disposer the SDK returns. A stale
// callback is also fenced by showEpoch, so an uncancellable host timer cannot
// resurrect an old fade.
function setShowTimer(fn, ms) {
  if (ctxRef && typeof ctxRef.setTimeout === 'function') {
    try {
      return ctxRef.setTimeout(fn, ms)
    } catch {
      // fall through to the global timer
    }
  }
  if (typeof setTimeout === 'function') {
    try {
      return setTimeout(fn, ms)
    } catch {
      return null
    }
  }
  return null
}

function clearShowTimer(handle) {
  if (!handle) return
  try {
    if (typeof handle === 'function') {
      handle()
      return
    }
    if (ctxRef && typeof ctxRef.clearTimeout === 'function') {
      ctxRef.clearTimeout(handle)
      return
    }
    if (typeof clearTimeout === 'function') clearTimeout(handle)
  } catch {
    // already cleared
  }
}

function cancelShowTimers() {
  if (showDelayTimer) {
    clearShowTimer(showDelayTimer)
    showDelayTimer = null
  }
  if (showIdleTimer) {
    clearShowTimer(showIdleTimer)
    showIdleTimer = null
  }
  if (showRampTimer) {
    clearShowTimer(showRampTimer)
    showRampTimer = null
  }
  showRampLeft = 0
}

/** Drop every fade timer and state. The caller decides whether the backdrop
 *  itself should stay (always mode) or go. */
function resetShow() {
  showEpoch += 1
  cancelShowTimers()
  showVisible = false
  showOpacity = 0
  showTarget = 0
}

function mountBackdrop(url, opacity) {
  const src = backdropSrc(url)
  if (!backdropEl) {
    if (!doc.body || typeof doc.body.appendChild !== 'function') return
    backdropEl = doc.createElement('iframe')
    backdropEl.setAttribute('aria-hidden', 'true')
    backdropEl.setAttribute('tabindex', '-1')
    backdropEl.setAttribute('title', 'Aura backdrop')
    // Sandboxed, click-through decoration: same-origin is required because
    // the page talks to its own 127.0.0.1 origin and the server sends no CORS
    // headers; pointer-events stay off so nothing can be clicked through it.
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
    style.background = 'transparent'
    backdropUrl = src
    backdropEl.src = src
  } else if (backdropUrl !== src) {
    backdropUrl = src
    backdropEl.src = src
  }
  backdropEl.style.opacity = String(clamp01(opacity))
  if (backdropEl.parentNode !== doc.body) doc.body.appendChild(backdropEl)
  if (!glassStyleEl) applyGlassStyle()
}

/** Keep exactly one backdrop mounted, in sync with the theme, live status and
 *  the "Show" mode. In "active" mode the fade state machine owns mounting. */
function syncBackdrop() {
  const settings = $settings.get()
  if (!showEligible()) {
    resetShow()
    removeBackdrop()
    return
  }
  if (settings.showWhen === 'active') {
    if (!showVisible) {
      removeBackdrop()
      return
    }
    mountBackdrop(liveUrl(), showOpacity)
    return
  }
  resetShow()
  mountBackdrop(liveUrl(), 1)
}

function applyShowOpacity() {
  if (backdropEl) backdropEl.style.opacity = String(clamp01(showOpacity))
}

/** Walk the opacity to showTarget over <= 1.5 s (<= 200 ms under reduced
 *  motion). Reversals cancel the current ramp and start from where it is. */
function beginShowRamp() {
  const epoch = ++showEpoch
  if (showRampTimer) {
    clearShowTimer(showRampTimer)
    showRampTimer = null
  }
  const reduced = Boolean($settings.get().reducedMotion)
  const total = reduced ? SHOW_FADE_REDUCED_MS : SHOW_FADE_MS
  const step = reduced ? SHOW_FADE_REDUCED_MS : SHOW_FADE_STEP_MS
  const steps = Math.max(1, Math.round(total / step))
  showRampStepMs = step
  showRampLeft = steps
  showRampDelta = (clamp01(showTarget) - clamp01(showOpacity)) / steps
  if (Math.abs(showRampDelta) < 1e-4) {
    showOpacity = clamp01(showTarget)
    applyShowOpacity()
    if (showOpacity <= 0) {
      showVisible = false
      showTarget = 0
      removeBackdrop()
    }
    return
  }
  const tick = () => {
    if (disposed || epoch !== showEpoch) return
    showRampTimer = null
    showRampLeft -= 1
    showOpacity = clamp01(showOpacity + showRampDelta)
    if (showRampLeft <= 0) {
      showOpacity = clamp01(showTarget)
      applyShowOpacity()
      if (showOpacity <= 0) {
        showVisible = false
        showTarget = 0
        removeBackdrop()
      }
      return
    }
    applyShowOpacity()
    showRampTimer = setShowTimer(tick, showRampStepMs)
  }
  showRampTimer = setShowTimer(tick, showRampStepMs)
}

function beginFadeIn() {
  if (disposed) return
  if (!showEligible()) {
    resetShow()
    removeBackdrop()
    return
  }
  showVisible = true
  showTarget = 1
  mountBackdrop(liveUrl(), showOpacity)
  beginShowRamp()
}

function beginFadeOut() {
  if (disposed || !showVisible) return
  showTarget = 0
  beginShowRamp()
}

/** Advance the "Only while active" state machine from the poll tick. Activity
 *  must last 300 ms before the first fade-in; 2.5 s of idle starts fade-out.
 *  Short gaps between tool calls stay inside the hysteresis window. */
function updateShow() {
  if (disposed) return
  const settings = $settings.get()
  if (!showEligible()) {
    resetShow()
    removeBackdrop()
    return
  }
  if (settings.showWhen !== 'active') {
    resetShow()
    return
  }
  const moving = visualIsMoving()
  if (moving) {
    if (showIdleTimer) {
      clearShowTimer(showIdleTimer)
      showIdleTimer = null
    }
    if (!showVisible) {
      if (!showDelayTimer) {
        showDelayTimer = setShowTimer(() => {
          showDelayTimer = null
          if (disposed) return
          if (!showEligible() || !visualIsMoving()) return
          beginFadeIn()
        }, SHOW_FADE_IN_DELAY_MS)
      }
    } else if (showTarget === 0) {
      beginFadeIn()
    }
    return
  }
  if (showDelayTimer) {
    clearShowTimer(showDelayTimer)
    showDelayTimer = null
  }
  if (!showVisible) return
  if (!showIdleTimer) {
    showIdleTimer = setShowTimer(() => {
      showIdleTimer = null
      if (disposed) return
      if (!showEligible() || visualIsMoving()) return
      beginFadeOut()
    }, SHOW_FADE_OUT_IDLE_MS)
  }
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

/**
 * The server is the single source of truth for the display controls. Without
 * this, a quick menu built from stale local storage showed a different motion
 * or behaviour than the one actually driving the visual. Sync the five keys
 * the server owns; local-only preferences (windowVisual, themeOptIn, showWhen)
 * are never touched here.
 */
function syncFromServer(frame) {
  if (!frame || typeof frame !== 'object') return
  const current = $settings.get()
  const patch = {}
  if (typeof frame.motion === 'string' && MOTIONS.includes(frame.motion) && frame.motion !== current.motion) {
    patch.motion = frame.motion
  }
  if (typeof frame.behavior === 'string' && BEHAVIORS.includes(frame.behavior) && frame.behavior !== current.behavior) {
    patch.behavior = frame.behavior
  }
  if (Number.isFinite(frame.intensity)) {
    const intensity = clamp01(frame.intensity)
    if (intensity !== current.intensity) patch.intensity = intensity
  }
  if (Number.isFinite(frame.opacity)) {
    const opacity = clamp01(frame.opacity)
    if (opacity !== current.opacity) patch.opacity = opacity
  }
  if (typeof frame.reduced_motion === 'boolean' && frame.reduced_motion !== current.reducedMotion) {
    patch.reducedMotion = frame.reduced_motion
  }
  if (Object.keys(patch).length) writeSettings(patch)
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
    syncFromServer(frame)
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
    updateShow()
    syncBackdrop()
    accentStep(Date.now())
    pulseStep()
  } finally {
    polling = false
  }
}

// --------------------------------------------------------------- pulse dot

/**
 * Is the Aura visual actually moving right now? Music-led motions follow the
 * level/silence frame, agent-led motions follow the mood, and the ambient
 * profiles ('both' and legacy 'designs') rest on a gentle design that always
 * drifts. Used for the status-bar dot and for the "Only while active" fade.
 */
function visualIsMoving() {
  const settings = $settings.get()
  const frame = liveFrame || {}
  const level = Number.isFinite(frame.level) ? clamp01(frame.level) : 0
  const musicPlaying = frame.silence !== true && level > PULSE_MUSIC_LEVEL
  const agentActive = typeof frame.mood === 'string' && frame.mood !== '' && frame.mood !== 'idle'
  if (settings.motion === 'agent') return agentActive
  if (settings.motion === 'agent_music') return agentActive || musicPlaying
  if (settings.motion === 'music') return musicPlaying
  return true
}

/**
 * Advance the pulse dot one breath step (once per poll tick, so never faster
 * than 4 Hz). Reduced motion never cycles; it holds a steady dim dot. The
 * value is handed to the React dot as an inline opacity — no stylesheet, no
 * animation node, nothing added to the host document.
 */
function pulseStep() {
  if (disposed) return
  const settings = $settings.get()
  const live = $live.get()
  const enabled = live.ok ? live.enabled === true : settings.enabled
  if (!enabled || !visualIsMoving()) {
    pulseIndex = 0
    if ($pulse.get() !== 0) $pulse.set(0)
    return
  }
  if (settings.reducedMotion) {
    if ($pulse.get() !== PULSE_REDUCED_OPACITY) $pulse.set(PULSE_REDUCED_OPACITY)
    return
  }
  pulseIndex = $pulse.get() === 0 || $pulse.get() === PULSE_REDUCED_OPACITY
    ? 0
    : (pulseIndex + 1) % PULSE_LEVELS.length
  $pulse.set(PULSE_LEVELS[pulseIndex])
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
  if (!first && $settings.get().windowVisual) {
    writeSettings({ windowVisual: false })
    resetShow()
    removeBackdrop()
  }
  if ($settings.get().themeOptIn && !$themeApplied.get()) applyThemeIfOptedIn()
  updateShow()
}

function setThemeOptIn(on) {
  writeSettings({ themeOptIn: Boolean(on) })
  if (on) applyThemeIfOptedIn()
  else restoreTheme()
}

/**
 * "Visual behind the app". Turning it on while Aura is off turns Aura on
 * through the same door as the "Aura enabled" switch: the owner hit the
 * visual being ON while Aura was OFF, which used to draw nothing in silence.
 */
async function setWindowVisual(on) {
  writeSettings({ windowVisual: Boolean(on) })
  if (on && (!$live.get().enabled || !$settings.get().enabled)) {
    await setEnabled(true)
  }
  syncBackdrop()
  updateShow()
}

/** One control that returns the host to the user's own appearance: turns off
 *  the accent pulse, clears any override, restores the previous theme and
 *  removes every effect Aura may have applied. The plugin stays mounted. */
async function restoreMyTheme() {
  if (!ctxRef || disposed) return
  writeSettings({ accentPulse: false, themeOptIn: false, windowVisual: false })
  resetShow()
  removeBackdrop()
  clearAccent(true)
  restoreTheme()
  await pushControl({ accent_pulse: false })
  if ($live.get().ok) void poll()
}

// ------------------------------------------------------------- enable switch

async function setEnabled(next) {
  if (!ctxRef || disposed) return
  const enabled = Boolean(next)
  writeSettings({ enabled })
  if (!enabled) {
    resetShow()
    removeBackdrop()
    clearAccent(true)
    restoreTheme()
  } else if ($settings.get().themeOptIn) {
    applyThemeIfOptedIn()
  }
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

async function setMotion(next) {
  if (!ctxRef || disposed) return
  const motion = MOTIONS.includes(next) ? next : DEFAULT_SETTINGS.motion
  writeSettings({ motion })
  updateShow()
  await pushControl({ motion })
}

/** "Gentle motion (motion-sensitive)". The same key lives in the server's
 *  config (config.reduced_motion) and /control accepts it, so the server and
 *  the backdrop's reduced-motion force-switch stay in agreement. The local
 *  effect — the ramp cap and the dot — applies immediately in this half. */
async function setReducedMotion(next) {
  if (!ctxRef || disposed) return
  const reducedMotion = Boolean(next)
  writeSettings({ reducedMotion })
  syncBackdrop()
  updateShow()
  await pushControl({ reduced_motion: reducedMotion })
}

/** "Show: Always / Only while active". Desktop-only presentation choice: the
 *  server has no such key, but the push keeps the one-door rule for every
 *  quick-menu control and unknown keys are ignored by /control. */
async function setShowWhen(next) {
  if (!ctxRef || disposed) return
  const showWhen = SHOW_WHEN_OPTIONS.includes(next) ? next : 'always'
  writeSettings({ showWhen })
  resetShow()
  removeBackdrop()
  if (showWhen === 'always') syncBackdrop()
  else updateShow()
  await pushControl({ show_when: showWhen })
}

/** Shared by the settings page and the quick menu: apply the intensity
 *  locally (accent at once) and then push it — one door for both surfaces. */
function applyIntensity(rawValue) {
  const intensity = clamp01(rawValue)
  writeSettings({ intensity })
  if (intensity <= 0) clearAccent(true)
  else accentStep(Date.now())
  void pushControl({ intensity })
}

/** The motion select's offered values; a saved legacy `designs` keeps a
 *  matching option so the select never lies about the stored value. */
function motionChoices(settings) {
  return settings.motion === 'designs' ? MOTION_OPTIONS.concat(['designs']) : MOTION_OPTIONS
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

/**
 * The status-bar quick menu. A host Popover (the working pattern from the
 * quota/revamp plugins) carries its own outside-click/Escape/focus handling,
 * so this adds no listeners and no stylesheet. Every control reuses the same
 * module handlers as the settings page: setEnabled, setMotion, applyIntensity,
 * setOpacity, setBehavior, setReducedMotion. The panel is closed when we
 * dispose (via $menuOpen) and whenever a control is used it stays open like
 * the settings page so the user can stack changes.
 */
function AuraQuickMenu() {
  const settings = useValue($settings)
  const live = useValue($live)
  const pulse = useValue($pulse)
  const useHostNav = host && typeof host.navigate === 'function'
  // Server flag wins while it answers, exactly like syncBackdrop does.
  const auraOn = live.ok ? live.enabled === true : settings.enabled
  const open = useValue($menuOpen)

  const setOpen = value => {
    if ($menuOpen.get() !== Boolean(value)) $menuOpen.set(Boolean(value))
  }

  const row = (label, control) =>
    jsxs('div', {
      style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '7px 12px' },
      children: [
        jsx('div', {
          style: { fontSize: 12, color: 'var(--ui-text-primary)', whiteSpace: 'nowrap' },
          children: label
        }),
        jsx('div', { style: { display: 'flex', alignItems: 'center', flex: 'none' }, children: control })
      ]
    })

  const sliderStyle = { width: 110, accentColor: 'var(--ui-accent)' }
  const readout = value =>
    jsx('span', {
      style: { fontSize: 11, color: 'var(--ui-text-tertiary)', minWidth: 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
      children: `${Math.round(clamp01(value) * 100)}%`
    })
  const selectStyle = {
    font: 'inherit',
    fontSize: 11,
    color: 'var(--ui-text-primary)',
    background: 'var(--ui-bg)',
    border: '1px solid var(--ui-stroke-secondary)',
    borderRadius: 6,
    padding: '3px 6px'
  }

  const glyphColor = auraOn ? 'var(--ui-accent)' : 'var(--ui-text-tertiary)'

  return jsxs(Popover, {
    open,
    onOpenChange: setOpen,
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsx(Button, {
          size: 'micro',
          variant: 'ghost',
          'aria-label': 'Aura quick settings',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          title: 'Aura',
          style: { color: glyphColor, lineHeight: 1, fontWeight: 700 },
          children: jsxs('span', {
            'aria-hidden': true,
            style: { display: 'inline-flex', alignItems: 'center', fontSize: 14, lineHeight: 1, letterSpacing: 0.5 },
            children: [
              'A',
              // The breathing dot: opacity comes from the poll ticker, so it
              // moves at most 4 Hz, sits still under reduced motion, and is
              // away entirely while nothing moves or Aura is off. No CSS
              // animation node exists to leak — the value is an inline style.
              jsx('span', {
                key: 'dot',
                style: {
                  display: 'inline-block',
                  width: 5,
                  height: 5,
                  marginLeft: 3,
                  borderRadius: 999,
                  background: 'var(--ui-accent)',
                  opacity: Number(pulse),
                  transition: 'opacity 220ms ease-in-out'
                }
              })
            ]
          })
        })
      }),
      jsx(PopoverContent, {
        side: 'top',
        align: 'end',
        'aria-label': 'Aura quick settings',
        style: {
          minWidth: 264,
          padding: '6px 0',
          background: 'var(--ui-bg-elevated, var(--ui-bg))',
          border: '1px solid var(--ui-stroke-secondary)',
          borderRadius: 10,
          boxShadow: '0 8px 28px rgba(0,0,0,0.28)',
          display: 'flex',
          flexDirection: 'column',
          gap: 1
        },
        children: [
          row(
            'Aura',
            jsx(Switch, {
              checked: settings.enabled,
              'aria-label': 'Aura enabled',
              onCheckedChange: value => {
                void setEnabled(value)
              }
            })
          ),
          row(
            'Reacts to',
            jsx('select', {
              value: settings.motion,
              'aria-label': 'Reacts to',
              style: selectStyle,
              onChange: event => {
                void setMotion(event && event.target ? String(event.target.value) : 'both')
              },
              children: motionChoices(settings).map(name =>
                jsx('option', { key: name, value: name, children: MOTION_LABELS[name] })
              )
            })
          ),
          row(
            'Intensity',
            jsxs('div', {
              style: { display: 'flex', alignItems: 'center', gap: 8 },
              children: [
                jsx('input', {
                  key: 'slider',
                  type: 'range',
                  min: 0,
                  max: 100,
                  step: 1,
                  value: Math.round(settings.intensity * 100),
                  'aria-label': 'Intensity',
                  style: sliderStyle,
                  onChange: event => {
                    applyIntensity(Number(event && event.target ? event.target.value : 0) / 100)
                  }
                }),
                readout(settings.intensity)
              ]
            })
          ),
          row(
            'Transparency',
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
                  'aria-label': 'Transparency',
                  style: sliderStyle,
                  onChange: event => {
                    void setOpacity(clamp01(Number(event && event.target ? event.target.value : 0) / 100))
                  }
                }),
                readout(settings.opacity)
              ]
            })
          ),
          row(
            'Style',
            jsx('select', {
              value: settings.behavior,
              'aria-label': 'Style',
              style: selectStyle,
              onChange: event => {
                void setBehavior(event && event.target ? String(event.target.value) : 'balanced')
              },
              children: BEHAVIORS.map(name =>
                jsx('option', { key: name, value: name, children: BEHAVIOR_LABELS[name] })
              )
            })
          ),
          row(
            'Show',
            jsx('select', {
              value: settings.showWhen,
              'aria-label': 'Show',
              style: selectStyle,
              onChange: event => {
                void setShowWhen(event && event.target ? String(event.target.value) : 'always')
              },
              children: SHOW_WHEN_OPTIONS.map(name =>
                jsx('option', { key: name, value: name, children: SHOW_WHEN_LABELS[name] })
              )
            })
          ),
          row(
            'Gentle motion',
            jsx(Switch, {
              checked: settings.reducedMotion,
              'aria-label': 'Gentle motion (motion-sensitive)',
              onCheckedChange: value => {
                void setReducedMotion(value)
              }
            })
          ),
          useHostNav
            ? jsxs('div', {
              style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 12px 4px', borderTop: '1px solid var(--ui-stroke-secondary)', marginTop: 2 },
              children: [
                jsx(Button, {
                  size: 'micro',
                  variant: 'ghost',
                  'aria-label': 'All Aura settings',
                  onClick: () => {
                    setOpen(false)
                    try {
                      host.navigate(SETTINGS_NAV_PATH)
                    } catch {
                      // older hosts without navigate
                    }
                  },
                  children: 'All Aura settings'
                }),
                jsx('span', {
                  'aria-hidden': true,
                  style: { fontSize: 10, color: 'var(--ui-text-tertiary)' },
                  children: 'Aura'
                })
              ]
            })
            : null
        ]
      })
    ]
  })
}

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

function AuraSettings() {
  const settings = useValue($settings)
  const live = useValue($live)
  const applied = useValue($themeApplied)

  const serverLine = live.ok
    ? `Server reachable on 127.0.0.1${live.port ? `:${live.port}` : ''}${live.capture ? ` · capture: ${live.capture}` : ''}`
    : live.error || 'Server not reachable.'
  // Same truth rule as syncBackdrop: the server flag wins while it answers.
  const auraOn = live.ok ? live.enabled === true : settings.enabled

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
          'Listens to system audio and drives the backdrop and the accent.',
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
          'How strongly audio and mood move the backdrop and the accent. 0 returns your theme’s own accent.',
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
              applyIntensity(event && event.target ? event.target.value : 0)
            }
          })
        )
      }),
      jsx('div', {
        key: 'opacity',
        children: row(
          'Visual opacity',
          'Dims the backdrop and its scrim together; chat text and controls stay fully legible.',
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
        key: 'motion',
        children: row(
          'Motion source',
          'Default (Agent + music) follows playback and agent activity; Music only settles in silence; Agent activity moves only while the agent works and pauses after 2.5 s idle; Music, or gentle designs rests on designs in silence.',
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
            children: motionChoices(settings).map(name =>
              jsx('option', { key: name, value: name, children: MOTION_LABELS[name] })
            )
          })
        )
      }),
      jsx('div', {
        key: 'show',
        children: row(
          'Show',
          'Always keeps the backdrop and glass mounted. Only while active shows them just while the visual is moving, fading in after 300 ms of activity and removing the glass entirely after 2.5 s idle.',
          jsx('select', {
            value: settings.showWhen,
            'aria-label': 'Show',
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
              const value = event && event.target ? String(event.target.value) : 'always'
              void setShowWhen(value)
            },
            children: SHOW_WHEN_OPTIONS.map(name =>
              jsx('option', { key: name, value: name, children: SHOW_WHEN_LABELS[name] })
            )
          })
        )
      }),
      jsx('div', {
        key: 'gentle',
        children: row(
          'Gentle motion (motion-sensitive)',
          'The motion-sickness-friendly mode: calmer reaction, no strobe, no pulsing, and the reduced-motion visual profile in the window backdrop.',
          jsx(Switch, {
            checked: settings.reducedMotion,
            'aria-label': 'Gentle motion (motion-sensitive)',
            onCheckedChange: value => {
              void setReducedMotion(value)
            }
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
          'Lets thinking, tool, approval and error change the visual. Off drops any held mood.',
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
        key: 'windowVisual',
        children: row(
          'Visual behind the app',
          settings.windowVisual && !auraOn
            ? 'Aura is off - turn it on to see the visual'
            : 'Show the moving Aura visual behind the whole window. Turn off to restore your theme.',
          jsx(Switch, {
            checked: settings.windowVisual,
            'aria-label': 'Visual behind the app',
            onCheckedChange: value => setWindowVisual(value)
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
      }),
      jsx('div', {
        key: 'restore',
        children: row(
          'Restore my theme',
          'Turns off the window visual, the accent pulse and Aura Live, clears every override and restores your previous theme.',
          jsx(Button, {
            size: 'sm',
            variant: 'outline',
            'aria-label': 'Restore my theme',
            onClick: () => {
              void restoreMyTheme()
            },
            children: 'Restore my theme'
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
  description: 'Deep-stage palette with an electric accent, for Aura’s window visual.',
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
  resetShow()
  removeBackdrop()
  clearAccent(true)
  restoreTheme()
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
  $menuOpen.set(false)
  $pulse.set(0)
  pulseIndex = 0
}

// ------------------------------------------------------------------- export

export default {
  id: ID,
  name: 'Aura',
  description:
    'Audio-reactive window visual, accent pulse and optional theme for what this computer is playing. Local only: no recording, no account, no sound of its own.',
  register(ctx) {
    // Reset first: a hot reload must not inherit the previous instance's state.
    const mine = ++instanceSeq
    const dispose = () => {
      if (disposed || mine !== instanceSeq) return
      disposed = true
      teardown()
    }
    disposed = false
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
    $menuOpen.set(false)
    $pulse.set(0)
    pulseIndex = 0
    resetShow()
    const settings = readSettings(ctx)
    $settings.set(settings)
    $live.set({ ...EMPTY_LIVE })

    const track = disposer => {
      if (typeof disposer === 'function') disposers.push(disposer)
    }

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

    // The status-bar quick menu (the owner's "small icon of an A ... with a
    // drop down"). The contribution lives in the status bar; the panel is a
    // host Popover, which owns its own Escape/outside-click/focus handling,
    // so nothing here adds a listener or a node to clear on dispose.
    track(
      ctx.register({
        id: 'quick-menu',
        area: STATUSBAR_AREAS.right,
        order: 127,
        render: () => jsx(AuraQuickMenu, {})
      })
    )

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
