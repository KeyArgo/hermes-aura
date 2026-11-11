/*
 * Aura visualizer page (L2) — CONTRACT.md v0.1.
 *
 * Reads ?token=, opens the same-origin WS /api/stream, parses §2 binary PCM frames
 * (float32 mono 48k, ≤1024 samples), feeds them through an AudioWorklet into
 * Butterchurn's connectAudio via a silent graph (gain 0 → destination). The canvas
 * tracks its container with a ResizeObserver and is sized in device pixels, not CSS
 * only. Mood events drive intensity/brightness/pulse/tint; mood never touches the
 * audio graph.
 *
 * Hard rules enforced here:
 *   - no audio output: every path to ctx.destination goes through gain 0;
 *   - no external network: only same-origin fetch/WS;
 *   - flash limiter ≤3 flashes/s, attention pulses ≤2 Hz (we use 1 Hz);
 *   - prefers-reduced-motion: lower intensity, no strobe presets, no pulse animation;
 *   - failure is always visible: one-line message + accent-only fallback, never a
 *     silent blank frame.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // constants / state
  // ---------------------------------------------------------------------------

  const params = new URLSearchParams(location.search);
  const TOKEN = params.get('token') || '';
  const FORCE_NO_WEBGL = params.get('no-webgl') === '1';
  const FORCE_REDUCED = params.get('reduced-motion') === '1';
  const OVERLAY = params.get('overlay') === '1';

  if (OVERLAY) {
    // Ambient install: nothing but the canvas may paint, and the page itself
    // must stay transparent over the host window.
    document.documentElement.classList.add('aura-overlay');
    if (document.body) document.body.classList.add('aura-overlay');
  }

  const MOODS = ['idle', 'thinking', 'tool', 'approval', 'error', 'streaming', 'done'];
  const ATTENTION = ['approval', 'error'];
  // `perf` is deliberately NOT a hard blocker. A slow frame is still a moving
  // backdrop; the render loop lowers its own resolution/frame budget and keeps
  // drawing (REVamp's approach). A hard blocker hides the canvas, which in the
  // click-through overlay means the whole backdrop goes black.
  const HARD_BLOCKERS = ['token', 'webgl', 'capture', 'audio'];
  // Capture is a data source, not a graphics prerequisite: in ambient mode the
  // page keeps drawing and only says what is missing. No cause is guessed.
  const CAPTURE_NONE_AMBIENT = 'System audio loopback is unavailable — ambient visuals continue; music reactivity is off.';
  const CAPTURE_NONE_BLOCKED = 'System audio loopback is unavailable — showing the accent-only fallback.';
  const FLASH_WINDOW_MS = 1000;
  const FLASH_MAX_PER_WINDOW = 3;
  const ATTENTION_PULSE_MS = 1000;   // 1 Hz — contract caps attention at 2 Hz
  const DONE_SETTLE_MS = 1500;       // contract: done settles for ≤1.5 s

  // CONTRACT.md §9: named behaviour profiles with concrete render parameters.
  // Keep in sync with aura_core/behavior.py; the server also publishes this
  // mapping in /api/config so a page never has to guess.
  const BEHAVIOR_PROFILES = {
    calm: {
      intensity_ceiling: 0.6,
      pulse_hz_max: 0,
      preset_family: 'organic',
      blend_ms: 2400,
      mood_gain_scale: 0.35,
      allow_strobe: false,
      hard_pulse: false
    },
    balanced: {
      intensity_ceiling: 1.0,
      pulse_hz_max: 1.0,
      preset_family: 'liquid',
      blend_ms: 1200,
      mood_gain_scale: 1.0,
      allow_strobe: true,
      hard_pulse: true
    },
    intense: {
      intensity_ceiling: 1.0,
      pulse_hz_max: 2.0,
      preset_family: 'geometric',
      blend_ms: 600,
      mood_gain_scale: 1.35,
      allow_strobe: true,
      hard_pulse: true
    }
  };
  const DEFAULT_BEHAVIOR = 'balanced';

  const state = {
    ready: false,
    errors: [],
    enabled: true,
    capture: 'unknown',
    reducedMotion: false,
    userIntensity: 0.6,
    // Dynamic intensity (§9.6): the server publishes a multiplier derived from
    // the number of live chats; the user's saved intensity stays untouched.
    sessionBoost: 1.0,
    sessions: 0,
    effectiveIntensity: 0.6,
    sampleGain: 1.0,
    opacity: 0.75,
    behavior: DEFAULT_BEHAVIOR,
    behaviorProfile: Object.assign({}, BEHAVIOR_PROFILES[DEFAULT_BEHAVIOR]),
    motion: 'both',
    // What the render gain does while the agent is idle or done (motion follows
    // the agent): 'stop' dark, 'ember' a low glow, 'always' unchanged.
    idleMotion: 'always',
    ambientFallback: false,
    // Agent-gated motion: tracked from the RAW mood stream, separate from the
    // mood visuals, so moodReactive=false never freezes agent mode.
    agentActive: false,
    // -1 = no idle instant recorded yet (a real timestamp can be 0).
    agentIdleSince: -1,
    captureNotice: null,
    moodReactive: true,
    // Opt-in: the server default is off, and a page opened standalone starts
    // with no pulse until the user (or the config event) turns it on.
    accentPulse: false,
    autoPreset: true,
    presetName: null,
    presetFamily: null,
    presetStrobe: false,
    presetAnchor: null,
    frames: 0,
    badFrames: 0,
    droppedFrames: 0,
    lastSeq: 0,
    lastPcmSeq: 0,
    lastRenderedPcmSeq: 0,
    lastFeatures: null,
    // Silence gate: the visual follows the audio. No audio -> the canvas fades
    // out and its drawing buffer is cleared, so a preset never free-runs on its
    // own internal motion with nothing playing. lastAudioAt is a page-clock ms.
    lastAudioAt: 0,
    renderPaused: false,
    canvas: { w: 0, h: 0, cssW: 0, cssH: 0 }
  };

  const quality = {
    tier: 'unknown',
    renderer: 'unknown',
    software: false,
    renderScale: 1,
    fpsCap: 30,
    degradeLevel: 0,
    goodStreak: 0,
    perfLimited: false,
    degradedToFallback: false
  };

  const blockers = new Map(); // reason -> one-line message
  const frameTimes = [];
  const syncTimes = []; // render()+1px readPixels samples: real GPU-inclusive frame cost
  const syncProbe = new Uint8Array(4);

  const dom = {};
  const audio = {
    ctx: null,
    node: null,
    mute: null,
    sampleRate: 0,
    mixBus: null,
    realGain: null,
    ambientGain: null,
    ambient: null,
    mixTarget: '',
    mixGate: ''
  };
  const MOTIONS = ['designs', 'both', 'music', 'agent', 'agent_music'];
  const IDLE_MOTIONS = ['stop', 'ember', 'always'];
  const IDLE_EMBER_GAIN = 0.06;   // ember: a low glow while idle, never dark
  const MOTION_SILENCE_MS = 1500; // both: rest on designs after this much quiet
  const MOTION_FADE_S = 2;        // crossfade between real audio and designs
  // Raw moods that mean the agent is doing something. `done` counts until it
  // settles to idle (DONE_SETTLE_MS), exactly like the visual settle.
  const AGENT_ACTIVE_MOODS = ['thinking', 'tool', 'streaming', 'approval', 'error', 'done'];
  // Do not flicker the canvas between tool calls: an idle mood pauses only
  // after this long, and any new active mood cancels the pending pause.
  const AGENT_IDLE_GRACE_MS = 2500;
  // `suspended` means the page is going away (pagehide) or is parked in the
  // back/forward cache: no reconnects, no new sockets until it comes back.
  const socket = { ws: null, state: 'boot', attempt: 0, timer: null, suspended: false };
  let viz = null;
  let catalog = { presets: [], byName: Object.create(null), default: null };
  let resizeQueued = false;
  let rafId = null;
  let lastRenderAt = 0;
  let renderErrorStreak = 0;
  let silenceTimer = null;
  let agentIdleTimer = null;
  let lastSample = null;
  let probeRecorder = null;
  let prevProbeBuf = null;
  let draggingIntensity = false;
  let draggingOpacity = false;

  // Visual audio analysis is driven from the PCM stream itself, not from the
  // Web Audio graph. An overlay iframe never gets the gesture that would unlock
  // an AudioContext, so Butterchurn's own analysers would read flat silence.
  // Instead we keep the most recent PCM and hand Butterchurn the byte arrays it
  // would otherwise sample from an AnalyserNode.
  const PCM_RING_SIZE = 1024;
  const PCM_STALE_MS = 300;
  const HARD_CUT_MIN_MS = 8000;
  const HARD_CUT_MIN_MS_CALM = 20000;
  // Auto-gain: quiet monitor captures must not quantise to 128 (silence).
  // The envelope is deliberately slow so a kick keeps its relative contrast;
  // gain is only ever boosted (never attenuates loud audio into clipping).
  const AGC_TARGET_PEAK = 0.75;
  const AGC_MIN_PEAK = 0.002;
  const AGC_MAX_GAIN = 64;
  const AGC_ENVELOPE_DECAY = 0.99;
  const SILENCE_PEAK = 0.0015;
  let agcGain = 1.0;
  let agcPeak = 0.0;
  const pcmRing = new Float32Array(PCM_RING_SIZE);
  let pcmWrite = 0;
  let pcmFilled = 0;
  let lastPcmAt = 0;
  let fluxPrevRms = 0;
  let lastHardCutAt = -Infinity;

  // ---------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function num(v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; }
  function now() { return performance.now(); }

  function recordError(err) {
    const text = String(err && err.message ? err.message : err);
    state.errors.push(text);
    if (state.errors.length > 50) state.errors.shift();
    try { console.warn('[aura]', text); } catch (_) {}
  }

  window.addEventListener('error', (e) => {
    recordError(e.message || 'script error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    recordError((e.reason && e.reason.message) || e.reason || 'unhandled rejection');
  });

  // Every same-origin request is bounded. The page is served by this same
  // server, so an endpoint that stops answering is wedged rather than slow, and
  // an unbounded request would stall boot() before connect() - a dark stage
  // with a perfectly healthy /api/stream and no way back.
  let fetchTimeoutMs = 5000;

  function fetchWithTimeout(path, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    const init = Object.assign({}, opts, { signal: controller.signal });
    return fetch(path, init).finally(() => clearTimeout(timer));
  }

  async function getJson(path, opts) {
    const headers = Object.assign({ Accept: 'application/json' }, (opts && opts.headers) || {});
    if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
    try {
      const res = await fetchWithTimeout(path, Object.assign({}, opts, { headers }));
      let body = null;
      try { body = await res.json(); } catch (_) { body = null; }
      return { status: res.status, ok: res.ok, json: body };
    } catch (e) {
      return { status: 0, ok: false, json: null, error: String(e) };
    }
  }

  async function postControl(payload) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
    try {
      const res = await fetchWithTimeout('/api/control', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      let body = null;
      try { body = await res.json(); } catch (_) { body = null; }
      if (!res.ok) recordError('control ' + res.status);
      return body;
    } catch (e) {
      recordError(e);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // visual opacity (CONTRACT.md §9) — dims the canvas AND its scrim together,
  // never the chat text or the control chrome (they are separate elements).
  //
  // The scrim keeps the text legible: its element opacity never falls below
  // 0.85, and its gradient alphas are compensated by the inverse of that
  // opacity, so the effective contrast is never below today's scrim at any
  // user opacity. Both layers are computed from `opacity`; neither is allowed
  // to go fully transparent while the other does.
  // ---------------------------------------------------------------------------

  const SCRIM_BASE = { a: 82, b: 38, c: 62 };
  const SCRIM_MIN_OPACITY = 0.85;

  function scrimOpacityFor(opacity) {
    const o = clamp(num(opacity, 0.75), 0, 1);
    return SCRIM_MIN_OPACITY + (1 - SCRIM_MIN_OPACITY) * o; // 0.85 .. 1.0
  }

  function applyVisualOpacity() {
    const o = clamp(num(state.opacity, 0.75), 0, 1);
    const scrim = scrimOpacityFor(o);
    const boost = 1 / scrim; // keeps effective gradient alpha at today's level
    if (dom.canvas) {
      // Aura off keeps its old dimmed look (0.35 of the chosen opacity).
      const target = state.enabled ? o : o * 0.35;
      // While the silence gate holds, the canvas must stay faded out: its
      // drawing buffer is cleared, so revealing it here would paint an opaque
      // black panel. Only audio (resumeVisual) restores the user's opacity.
      dom.canvas.style.opacity = state.renderPaused ? '0' : String(target);
    }
    if (dom.scrim) {
      dom.scrim.style.opacity = String(scrim);
      dom.scrim.style.setProperty('--aura-scrim-a', (Math.min(100, SCRIM_BASE.a * boost)).toFixed(1));
      dom.scrim.style.setProperty('--aura-scrim-b', (Math.min(100, SCRIM_BASE.b * boost)).toFixed(1));
      dom.scrim.style.setProperty('--aura-scrim-c', (Math.min(100, SCRIM_BASE.c * boost)).toFixed(1));
    }
    if (dom.root) dom.root.style.setProperty('--aura-visual-opacity', o.toFixed(3));
  }

  function setOpacityUI(value) {
    state.opacity = clamp(num(value, 0.75), 0, 1);
    if (dom.opacity) {
      dom.opacity.value = String(Math.round(state.opacity * 100));
      dom.opacity.setAttribute('aria-valuetext', Math.round(state.opacity * 100) + ' percent');
    }
    if (dom.opacityOut) dom.opacityOut.textContent = Math.round(state.opacity * 100) + '%';
    applyVisualOpacity();
  }

  // ---------------------------------------------------------------------------
  // status / message rendering (theme vars only)
  // ---------------------------------------------------------------------------

  function showMessage(text, tone) {
    if (!dom.message) return;
    dom.message.textContent = text;
    dom.message.dataset.tone = tone || 'info';
    dom.message.hidden = false;
  }

  function hideMessage() {
    if (!dom.message) return;
    dom.message.hidden = true;
  }

  function block(reason, message) {
    blockers.set(reason, message);
    renderStatus();
  }

  function unblock(reason) {
    if (blockers.delete(reason)) renderStatus();
  }

  function hardBlocker() {
    for (const reason of HARD_BLOCKERS) {
      if (blockers.has(reason)) return reason;
    }
    return null;
  }

  function renderStatus() {
    const hard = hardBlocker();
    const fallback = !!hard;
    if (dom.root) dom.root.dataset.fallback = fallback ? '1' : '0';
    if (dom.canvas) {
      dom.canvas.style.visibility = fallback ? 'hidden' : 'visible';
      dom.canvas.style.opacity = state.renderPaused ? '0'
        : (state.enabled ? String(state.opacity) : String(state.opacity * 0.35));
    }
    if (dom.conn) {
      dom.conn.dataset.state = socket.state === 'connected' ? 'connected'
        : (socket.state === 'refused' || socket.state === 'reconnecting' ? 'reconnecting' : 'boot');
      const label = dom.conn.querySelector('#aura-conn-label');
      if (label) label.textContent = socket.state;
    }
    if (fallback) {
      showMessage(blockers.get(hard), 'warn');
    } else if (!state.enabled) {
      showMessage('Aura is off — the visualizer is paused.', 'info');
    } else if (state.captureNotice) {
      // Non-blocking: ambient visuals are still drawing behind this line.
      showMessage(state.captureNotice, 'info');
    } else if (blockers.has('perf')) {
      // Non-blocking too: the canvas is still drawing at the reduced budget.
      showMessage(blockers.get('perf'), 'info');
    } else if (socket.state !== 'connected') {
      showMessage('Reconnecting to Aura…', 'info');
    } else {
      hideMessage();
    }
    updateMoodVisuals();
  }

  // ---------------------------------------------------------------------------
  // flash limiter — a real cap, not a comment: every visible flash goes through it.
  // ---------------------------------------------------------------------------

  const flash = {
    history: [],       // timestamps of accepted flashes (kept ~5 s for inspection)
    rejected: 0,
    allow() {
      const t = now();
      while (this.history.length && t - this.history[0] > 5000) this.history.shift();
      const recent = this.history.filter((x) => t - x < FLASH_WINDOW_MS);
      if (recent.length >= FLASH_MAX_PER_WINDOW) {
        this.rejected += 1;
        return false;
      }
      this.history.push(t);
      if (this.history.length > 400) this.history.shift();
      return true;
    },
    countInLastSecond() {
      const t = now();
      return this.history.filter((x) => t - x < FLASH_WINDOW_MS).length;
    },
    maxInAnyWindow() {
      const h = this.history.slice();
      let worst = 0;
      for (let i = 0; i < h.length; i++) {
        let c = 0;
        for (let j = i; j < h.length && h[j] - h[i] < FLASH_WINDOW_MS; j++) c++;
        worst = Math.max(worst, c);
      }
      return worst;
    }
  };

  // ---------------------------------------------------------------------------
  // mood engine
  // ---------------------------------------------------------------------------

  // gain = audio-reactivity multiplier on the PCM before Butterchurn,
  // bright = CSS brightness lift, tint = red settle, pulse = accent pulse mode,
  // fx = saturate/contrast on the stage element (canvas keeps brightness only:
  // the e2e parses the first filter function). The bundle exposes no runtime
  // zoom/decay knobs (vendor/butterchurn.min.js: only loadPreset /
  // setRendererSize / connectAudio) and is never patched — mood shape comes
  // from preset-family selection, gain/brightness here, and the stage filter.
  const MOOD_MOD = {
    idle:      { gain: 1.00, bright: 0.00, tint: 0.00, pulse: 'none',      floor: 0, fx: { saturate: 1.00, contrast: 1.00 } },
    thinking:  { gain: 1.30, bright: 0.14, tint: 0.00, pulse: 'breathe',   floor: 0, fx: { saturate: 1.08, contrast: 1.06 } },
    tool:      { gain: 1.12, bright: 0.04, tint: 0.00, pulse: 'none',      floor: 0, fx: { saturate: 1.03, contrast: 1.02 } },
    approval:  { gain: 1.15, bright: 0.08, tint: 0.00, pulse: 'attention', floor: 0.6, fx: { saturate: 1.12, contrast: 1.14 } },
    error:     { gain: 1.00, bright: 0.00, tint: 0.30, pulse: 'attention', floor: 0.6, fx: { saturate: 1.06, contrast: 1.08 } },
    streaming: { gain: 1.45, bright: 0.10, tint: 0.00, pulse: 'none',      floor: 0, fx: { saturate: 1.14, contrast: 1.05 } },
    done:      { gain: 0.95, bright: 0.02, tint: 0.00, pulse: 'settle',    floor: 0, fx: { saturate: 1.00, contrast: 1.00 } }
  };

  // Preset families (web/presets.json `family`) that express each mood.
  // null = keep whatever is playing (transient moods). Attention moods blend
  // in over MOOD_BLEND_MS and the idle restore brings the previous preset back.
  const MOOD_FAMILIES = {
    idle: ['organic', 'liquid'],
    thinking: ['geometric', 'fractal'],
    tool: null,
    approval: ['cosmic', 'geometric'],
    error: ['liquid', 'cosmic'],
    streaming: ['energy', 'geometric'],
    done: null
  };
  const MOOD_BLEND_MS = 2200; // mood-driven preset changes crossfade, never cut

  const mood = {
    current: 'idle',
    previous: 'idle',
    serverIntensity: 0,
    ttl: 0,
    lastAt: 0,
    expiry: null,
    settle: null,
    pulse: null,
    pulsePeriod: ATTENTION_PULSE_MS
  };


  function moodMod() { return MOOD_MOD[mood.current] || MOOD_MOD.idle; }

  function activeProfile() {
    return state.behaviorProfile || BEHAVIOR_PROFILES[DEFAULT_BEHAVIOR];
  }

  function stopPulse() {
    if (mood.pulse) { clearInterval(mood.pulse); mood.pulse = null; }
    if (dom.glow) {
      dom.glow.classList.remove('peak');
      // The calm/reduced-motion wash is an inline var on the glow itself, so it
      // outranks the level-driven one on #aura-root until it is dropped here.
      dom.glow.style.removeProperty('--aura-glow');
    }
  }

  function startPulse() {
    stopPulse();
    const mod = moodMod();
    if (!dom.glow) return;
    if (mod.pulse === 'none') return;
    const profile = activeProfile();
    // calm (hard_pulse false) and reduced-motion show a static accent wash:
    // no hard pulses at all, but the attention mood is still visible.
    if (state.reducedMotion || !profile.hard_pulse || !(profile.pulse_hz_max > 0)) {
      mood.pulsePeriod = 0;
      dom.glow.style.setProperty('--aura-glow', '0.24');
      return;
    }
    if (mod.pulse === 'breathe') {
      // 4 s breathing — well under the flash cap, still counts as a flash event.
      mood.pulsePeriod = 4000;
      mood.pulse = setInterval(() => {
        if (!flash.allow()) return;
        dom.glow.classList.add('peak');
        setTimeout(() => dom.glow.classList.remove('peak'), 400);
      }, mood.pulsePeriod);
      return;
    }
    // Attention pulse: never faster than 2 Hz (profile ceiling), never slower
    // than the 2 Hz contract cap allows us to slow it.
    mood.pulsePeriod = Math.max(500, Math.round(1000 / profile.pulse_hz_max));
    mood.pulse = setInterval(() => {
      if (!flash.allow()) return;
      dom.glow.classList.add('peak');
      setTimeout(() => dom.glow.classList.remove('peak'), 160);
    }, mood.pulsePeriod);
    // fire the first peak immediately, still through the limiter
    if (flash.allow()) {
      dom.glow.classList.add('peak');
      setTimeout(() => dom.glow.classList.remove('peak'), 160);
    }
  }

  function tickOnce() {
    if (!dom.glow || state.reducedMotion) return;
    if (!flash.allow()) return;
    dom.glow.classList.add('peak');
    setTimeout(() => dom.glow.classList.remove('peak'), 220);
  }

  function applyMood(name, intensity, ttlMs) {
    if (!MOODS.includes(name)) name = 'idle';
    // The agent activity gate always sees the RAW mood, even when mood colours
    // are off or Aura is disabled (the gate itself respects disabled).
    noteAgentMood(name);
    if (!state.enabled) name = 'idle';
    // mood_reactive=false: the agent-mood layer is off, so every incoming
    // mood is treated as idle. Nothing latches; turning it back on applies
    // the next mood event without a reload.
    if (!state.moodReactive) name = 'idle';
    const previous = mood.current;
    const changed = previous !== name;

    if (ATTENTION.includes(name) && !ATTENTION.includes(previous)) {
      // Remember what to restore to when the attention ttl expires.
      mood.previous = previous === 'idle' ? 'idle' : previous;
    }
    if (name === 'idle') mood.previous = 'idle';

    mood.current = name;
    mood.lastAt = now();
    mood.serverIntensity = clamp(num(intensity, 0), 0, 1);
    mood.ttl = clamp(num(ttlMs, 0), 0, 60000);
    if (mood.expiry) { clearTimeout(mood.expiry); mood.expiry = null; }

    if (name === 'done') {
      // One short settle, then idle. Never latched — and a repeated "done" from
      // the server must not keep re-arming (or cancelling) the settle.
      if (previous !== 'done') {
        if (mood.settle) { clearTimeout(mood.settle); mood.settle = null; }
        mood.settle = setTimeout(() => {
          if (mood.current === 'done') applyMood('idle', 0, 0);
        }, DONE_SETTLE_MS);
      }
    } else {
      if (mood.settle) { clearTimeout(mood.settle); mood.settle = null; }
      if (name !== 'idle' && mood.ttl > 0) {
        mood.expiry = setTimeout(() => {
          if (mood.current === name) restoreMood();
        }, Math.max(250, mood.ttl));
      }
    }

    if (changed && name === 'tool') tickOnce();

    stopPulse();
    startPulse();
    moodPresetHousekeeping(changed);
    updateMoodVisuals();
    // A mood change may open or close the idle gate; re-ease the render gain.
    applyMotionMix();
    updateMoodChip();
  }

  function restoreMood() {
    // Restore-on-clear: an attention mood expires back to where it came from,
    // never stays latched.
    const target = (mood.previous && mood.previous !== 'approval' && mood.previous !== 'error')
      ? mood.previous : 'idle';
    mood.previous = 'idle';
    applyMood(target === 'done' ? 'idle' : target, 0, 0);
  }

  function setMoodIdle() {
    mood.previous = 'idle';
    applyMood('idle', 0, 0);
  }

  function effectiveIntensity() {
    const mod = moodMod();
    const profile = activeProfile();
    const ceiling = clamp(num(profile.intensity_ceiling, 1), 0, 1);
    const gainScale = clamp(num(profile.mood_gain_scale, 1), 0, 2);
    // Dynamic intensity: more active chats scale the user's saved base up,
    // then the profile ceiling still caps the render (calm stays calm).
    const base = state.enabled
      ? clamp(state.userIntensity * clamp(num(state.sessionBoost, 1), 1, 2.5), 0, 1)
      : 0;
    let floor = mod.floor || 0;
    if (ATTENTION.includes(mood.current)) {
      // The server's mood intensity is a lower bound for attention moods, and the
      // contract floor of 0.6 always applies.
      floor = Math.max(floor, mood.serverIntensity);
    }
    // Mood alters the render only as strongly as the profile allows; the
    // attention floor still applies but never above the profile ceiling.
    const lift = 1 + (mod.gain - 1) * gainScale;
    return clamp(Math.max(base * lift, floor), 0, ceiling);
  }

  function sampleGain() {
    const intensity = effectiveIntensity();
    let g = 0.2 + 1.8 * intensity;
    if (state.reducedMotion) g *= 0.75;
    return g;
  }

  function isNearSilent(samples) {
    if (!samples || !samples.length) return true;
    let peak = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    return peak < SILENCE_PEAK;
  }

  // Slow rolling peak -> stable boost. Do not derive gain from a single frame
  // or the kick itself gets flattened; the envelope spans several beats.
  function updateAutoGain(samples) {
    if (!samples || !samples.length) return agcGain;
    let peak = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    agcPeak = Math.max(peak, agcPeak * AGC_ENVELOPE_DECAY);
    if (agcPeak < AGC_MIN_PEAK) agcPeak = AGC_MIN_PEAK;
    const desired = clamp(AGC_TARGET_PEAK / agcPeak, 1, AGC_MAX_GAIN);
    // Fast attack when the signal is quiet; slow release when it gets loud.
    const rate = desired > agcGain ? 0.08 : 0.5;
    agcGain += (desired - agcGain) * rate;
    agcGain = clamp(agcGain, 1, AGC_MAX_GAIN);
    return agcGain;
  }

  function updateMoodVisuals() {
    const mod = moodMod();
    const profile = activeProfile();
    const gainScale = clamp(num(profile.mood_gain_scale, 1), 0, 2);
    state.effectiveIntensity = effectiveIntensity();
    state.sampleGain = sampleGain();

    let bright = 1 + 0.10 * state.effectiveIntensity + mod.bright * gainScale;
    if (state.reducedMotion) bright = 1 + (bright - 1) * 0.6;
    if (dom.canvas) dom.canvas.style.filter = 'brightness(' + bright.toFixed(2) + ')';

    // Mood colour/contrast on the stage wrapper (canvas keeps brightness only).
    if (dom.stage) {
      const fx = mod.fx || {};
      let sat = typeof fx.saturate === 'number' ? fx.saturate : 1;
      let con = typeof fx.contrast === 'number' ? fx.contrast : 1;
      if (state.reducedMotion) { sat = 1 + (sat - 1) * 0.5; con = 1 + (con - 1) * 0.5; }
      const parts = [];
      if (Math.abs(sat - 1) > 0.001) parts.push('saturate(' + sat.toFixed(2) + ')');
      if (Math.abs(con - 1) > 0.001) parts.push('contrast(' + con.toFixed(2) + ')');
      dom.stage.style.filter = parts.length ? parts.join(' ') : '';
    }

    if (dom.root) {
      dom.root.style.setProperty('--aura-tint', String(mod.tint * gainScale));
      if (mod.pulse === 'none' || state.reducedMotion || !profile.hard_pulse) {
        const level = state.lastFeatures ? num(state.lastFeatures.level, 0) : 0;
        // Accent-only fallback needs to carry the room on its own; when the
        // visualizer is drawing, the glow is just a themed edge light.
        const base = hardBlocker()
          ? 0.22 + 0.30 * clamp(level, 0, 1)
          : 0.08 + 0.10 * clamp(level, 0, 1);
        dom.root.style.setProperty('--aura-glow', base.toFixed(3));
      }
      dom.root.dataset.mood = mood.current;
      dom.root.dataset.attention = ATTENTION.includes(mood.current) ? '1' : '0';
      dom.root.dataset.behavior = state.behavior;
    }
  }

  function updateMoodChip() {
    if (!dom.mood) return;
    dom.mood.textContent = mood.current;
    dom.mood.dataset.mood = mood.current;
  }

  // Watchdog: if the server stops repeating a non-idle mood, fall back to idle.
  setInterval(() => {
    if (!state.enabled) return;
    if (mood.current === 'idle' || mood.current === 'done') return;
    const grace = Math.max(mood.ttl || 0, 4500);
    if (now() - mood.lastAt > grace) setMoodIdle();
  }, 1000);

  // ---------------------------------------------------------------------------
  // presets
  // ---------------------------------------------------------------------------

  // Extra MIT preset packs ship alongside the base pack. They are injected
  // after the first frame so startup never waits on ~1.7 MB of extra presets.
  const EXTRA_PACKS = ['butterchurnPresetsExtra', 'butterchurnPresetsExtra2', 'butterchurnPresetsMD1'];
  const extraPacks = { started: false, loaded: 0 };
  let mergedPresetCache = null;
  let mergedPresetStamp = -1;

  function packPresets(globalName) {
    const p = window[globalName];
    if (!p) return null;
    return typeof p.getPresets === 'function' ? p.getPresets() : null;
  }

  function presetMap() {
    try {
      const stamp = extraPacks.loaded;
      if (mergedPresetCache && mergedPresetStamp === stamp) return mergedPresetCache;
      const merged = Object.create(null);
      const base = packPresets('butterchurnPresets');
      if (!base) return null;
      Object.assign(merged, base);
      for (const name of EXTRA_PACKS) {
        const extra = packPresets(name);
        if (!extra) continue;
        for (const key of Object.keys(extra)) {
          if (!(key in merged)) merged[key] = extra[key];
        }
      }
      mergedPresetCache = merged;
      mergedPresetStamp = stamp;
      return merged;
    } catch (e) {
      recordError(e);
      return null;
    }
  }

  function loadExtraPacks() {
    if (extraPacks.started) return;
    extraPacks.started = true;
    for (const name of EXTRA_PACKS) {
      if (window[name]) {
        extraPacks.loaded += 1;
        mergedPresetCache = null;
        continue;
      }
      const script = document.createElement('script');
      script.src = 'vendor/' + name + '.min.js';
      script.async = true;
      script.onload = () => {
        extraPacks.loaded += 1;
        mergedPresetCache = null;
      };
      script.onerror = () => recordError(new Error('extra preset pack failed to load: ' + name));
      document.body.appendChild(script);
    }
  }

  // --- shuffle bag (tests/test_presets_catalog.mjs evaluates this block) ---
  function createPresetShuffleBag(random) {
    const rnd = typeof random === 'function' ? random : Math.random;
    const bags = Object.create(null);
    const key = (pool) => pool.map((p) => String(p && p.name)).filter(Boolean).sort().join('\u0000');
    const refill = (pool, avoid) => {
      const names = pool.map((p) => p && p.name).filter((n) => n && n !== avoid);
      for (let i = names.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rnd() * (i + 1));
        const t = names[i];
        names[i] = names[j];
        names[j] = t;
      }
      return names;
    };
    return {
      draw(pool, avoid) {
        const list = (pool || []).filter((p) => p && p.name);
        if (!list.length) return null;
        const k = key(list);
        let bag = bags[k];
        if (!bag || !bag.length) bag = bags[k] = refill(list, avoid);
        if (!bag.length) bag = bags[k] = refill(list, null);
        return bag.shift() || null;
      },
      reset() {
        for (const k of Object.keys(bags)) delete bags[k];
      }
    };
  }
  // --- end shuffle bag ---
  const presetBag = createPresetShuffleBag(Math.random);

  function useVendoredPresets() {
    // Fall back to the vendored preset pack; no network, still works offline.
    const map = presetMap();
    if (!map) return;
    catalog.presets = Object.keys(map).sort().slice(0, 20)
      .map((name) => ({ name, family: 'misc', strobe: false, beat: 0 }));
    catalog.byName = Object.create(null);
    for (const p of catalog.presets) catalog.byName[p.name] = p;
    catalog.default = catalog.presets[0] ? catalog.presets[0].name : null;
  }

  async function loadCatalog() {
    try {
      const res = await fetchWithTimeout('presets.json', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('presets.json ' + res.status);
      const data = await res.json();
      const list = Array.isArray(data.presets) ? data.presets : [];
      catalog.presets = list.filter((p) => p && typeof p.name === 'string')
        .map((p) => ({
          name: p.name,
          family: String(p.family || 'misc'),
          strobe: !!p.strobe,
          beat: clamp(num(p.beat, 0), 0, 5)
        }));
      catalog.byName = Object.create(null);
      for (const p of catalog.presets) catalog.byName[p.name] = p;
      catalog.default = typeof data.default === 'string' ? data.default : null;
    } catch (e) {
      recordError(e);
    }
    if (!catalog.presets.length) {
      // A catalog that loaded but has nothing playable in it is a load failure
      // too: with an empty catalog no preset can ever be picked, so the canvas
      // would stay a blank frame with no message.
      recordError('presets.json offered no usable presets - using the vendored preset pack');
      useVendoredPresets();
    }
  }

  function strobeAllowed() {
    const profile = activeProfile();
    return !state.reducedMotion && profile.allow_strobe !== false;
  }

  function allowedPresets() {
    return catalog.presets.filter((p) => strobeAllowed() || !p.strobe);
  }

  function availableAllowedPresets() {
    const map = presetMap();
    if (!map) return [];
    return allowedPresets().filter((p) => map[p.name]);
  }

  function pickPresetForFamily(family) {
    if (!state.autoPreset) return null;
    const allowed = availableAllowedPresets();
    if (!allowed.length) return null;
    const byBeat = (a, b) => (b.beat || 0) - (a.beat || 0);
    const match = allowed.filter((p) => p.family === family).sort(byBeat);
    const pick = match.length ? match[0] : allowed.slice().sort(byBeat)[0];
    const blend = num(activeProfile().blend_ms, 1200);
    if (loadPresetByName(pick.name, blend)) return pick.name;
    return null;
  }

  function pickInitialPreset() {
    const allowed = availableAllowedPresets();
    if (!allowed.length) {
      const map = presetMap();
      if (!map) return null;
      const names = Object.keys(map);
      return names.length ? names.sort()[0] : null;
    }
    const family = activeProfile().preset_family;
    const byBeat = (a, b) => (b.beat || 0) - (a.beat || 0);
    const preferred = allowed.filter((p) => p.family === family).sort(byBeat);
    if (preferred.length) return preferred[0].name;
    if (catalog.default) {
      const d = catalog.byName[catalog.default];
      if (d && (strobeAllowed() || !d.strobe)) return d.name;
    }
    return allowed[0].name;
  }

  function loadPresetByName(name, blendMs, anchor) {
    if (!viz || typeof name !== 'string') return false;
    const map = presetMap();
    if (!map || !map[name]) return false;
    const meta = catalog.byName[name];
    if (meta && meta.strobe && !strobeAllowed()) {
      // No strobe presets for reduced-motion users or the calm profile.
      return false;
    }
    const blend = num(blendMs, num(activeProfile().blend_ms, 1200));
    try {
      viz.loadPreset(map[name], clamp(blend, 0, 8000));
      state.presetName = name;
      state.presetFamily = meta ? meta.family : null;
      state.presetStrobe = meta ? meta.strobe : false;
      // anchor=false: a mood-driven choice, not the user's/server's selection —
      // the idle restore blends back to state.presetAnchor.
      if (anchor !== false) state.presetAnchor = name;
      return true;
    } catch (e) {
      recordError(e);
      return false;
    }
  }

  // Mood → preset family: give each mood a visibly distinct shape. Runs on
  // mood CHANGE only (server repeats never re-trigger), crossfades over
  // MOOD_BLEND_MS, respects reduced-motion strobe filtering via
  // allowedPresets(), and never fights an explicit preset for the anchor.
  function moodPresetHousekeeping(changed) {
    if (!changed || !catalog.presets.length) return;
    if (mood.current === 'idle') {
      if (state.presetAnchor && state.presetName !== state.presetAnchor) {
        loadPresetByName(state.presetAnchor, MOOD_BLEND_MS + 800, false);
      }
      return;
    }
    const fams = MOOD_FAMILIES[mood.current];
    if (!fams) return;
    if (state.presetFamily && fams.indexOf(state.presetFamily) !== -1) return;
    const pool = availableAllowedPresets().filter((p) => fams.indexOf(p.family) !== -1);
    if (!pool.length) return;
    // Attention moods are short: blend in fast so the alarm lands immediately
    // (and is fully blended before a ~1 s attention check window closes).
    const blend = ATTENTION.includes(mood.current) ? 600 : MOOD_BLEND_MS;
    let attempts = pool.length;
    while (attempts-- > 0) {
      const name = presetBag.draw(pool, state.presetName);
      if (!name) break;
      if (loadPresetByName(name, blend, false)) return;
    }
  }

  // ---------------------------------------------------------------------------
  // visualizer
  // ---------------------------------------------------------------------------

  function readRenderer(gl) {
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || 'unknown');
      return String(gl.getParameter(gl.RENDERER) || 'unknown');
    } catch {
      return 'unknown';
    }
  }

  function detectWebGL() {
    if (FORCE_NO_WEBGL) return { ok: false, renderer: 'disabled by ?no-webgl=1', software: true };
    const probe = document.createElement('canvas');
    probe.width = 16; probe.height = 16;
    let gl = null;
    try {
      gl = probe.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    } catch {
      gl = null;
    }
    if (!gl) return { ok: false, renderer: 'none', software: true };
    const renderer = readRenderer(gl);
    const software = /swiftshader|llvmpipe|software|softpipe|basic render|mesa offscreen/i.test(renderer)
      || /^unknown$/i.test(renderer);
    try {
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    } catch (_) {}
    return { ok: true, renderer, software };
  }

  function applyQualityTier() {
    const webgl = detectWebGL();
    quality.renderer = webgl.renderer;
    quality.software = webgl.software;
    quality.tier = webgl.ok ? (webgl.software ? 'degraded-software' : 'full') : 'none';
    // Software GL: reduced resolution scaled up, ~24 fps cap (SPIKES.md S3).
    // Hardware: 30 fps, matching REVamp's MilkDrop budget — above that the extra
    // frames cost CPU and are hard to tell apart.
    quality.renderScale = webgl.software ? 0.45 : 1;
    quality.fpsCap = webgl.software ? 24 : 30;
    if (state.reducedMotion) {
      quality.renderScale *= 0.9;
      quality.fpsCap = Math.min(quality.fpsCap, 30);
    }
    return webgl;
  }

  function resizeCanvas() {
    if (!dom.stage) return;
    let rect = dom.stage.getBoundingClientRect();
    let cssW = Math.round(rect.width || 0);
    let cssH = Math.round(rect.height || 0);
    if (!cssW || !cssH) {
      // Embedded in a zero-height box at boot: fall back to the window box once.
      cssW = Math.round(window.innerWidth || 640);
      cssH = Math.round(window.innerHeight || 480);
    }
    cssW = Math.max(1, cssW);
    cssH = Math.max(1, cssH);
    const w = Math.max(64, Math.round(cssW * quality.renderScale));
    const h = Math.max(64, Math.round(cssH * quality.renderScale));
    state.canvas = { w, h, cssW, cssH };
    if (!dom.canvas) return;
    dom.canvas.width = w;
    dom.canvas.height = h;
    dom.canvas.style.width = '100%';
    dom.canvas.style.height = '100%';
    if (viz) {
      try {
        viz.setRendererSize(w, h, { pixelRatio: 1, textureRatio: 1 });
      } catch (e) {
        recordError(e);
      }
    }
  }

  function observeResize() {
    if (!dom.stage || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => {
      if (resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(() => {
        resizeQueued = false;
        resizeCanvas();
      });
    });
    ro.observe(dom.stage);
    window.addEventListener('resize', () => {
      if (resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(() => {
        resizeQueued = false;
        resizeCanvas();
      });
    }, { passive: true });
  }

  // ---------------------------------------------------------------------------
  // motion source: real audio, ambient designs, or both
  // ---------------------------------------------------------------------------

  function createAmbientSource(ctx, output) {
    const bus = ctx.createGain();
    bus.gain.value = 0.5;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.6;

    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.18;
    const oscA = ctx.createOscillator();
    oscA.type = 'sine';
    oscA.frequency.value = 110;
    const oscB = ctx.createOscillator();
    oscB.type = 'sine';
    oscB.frequency.value = 110.45; // slow beating gives presets gentle drift
    oscA.connect(oscGain);
    oscB.connect(oscGain);
    oscGain.connect(filter);

    // Brown-ish noise through the same low-pass: texture without hiss.
    const noise = ctx.createBufferSource();
    const length = Math.max(1, Math.floor(ctx.sampleRate * 2));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = last * 0.98 + white * 0.02;
      data[i] = last * 3;
    }
    noise.buffer = buffer;
    noise.loop = true;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.35;
    noise.connect(noiseGain);
    noiseGain.connect(filter);

    // Very slow LFO on the bus gain: the designs breathe rather than sit still.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.045;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.28;
    lfo.connect(lfoGain);
    lfoGain.connect(bus.gain);

    filter.connect(bus);
    bus.connect(output);
    try {
      oscA.start();
      oscB.start();
      noise.start();
      lfo.start();
    } catch (e) {
      recordError(e);
    }
    return { bus, oscA, oscB, noise, lfo };
  }

  function ensureMotionGraph() {
    if (audio.mixBus) return true;
    if (!audio.ctx || !audio.node) return false;
    try {
      const mixBus = audio.ctx.createGain();
      const realGain = audio.ctx.createGain();
      const ambientGain = audio.ctx.createGain();
      realGain.gain.value = 1;
      ambientGain.gain.value = 0;
      // PCM and designs meet here; only the visualizer reads this bus. The
      // worklet's own path to the speakers is still the gain-0 mute.
      audio.node.connect(realGain);
      realGain.connect(mixBus);
      const ambient = createAmbientSource(audio.ctx, ambientGain);
      ambientGain.connect(mixBus);
      audio.mixBus = mixBus;
      audio.realGain = realGain;
      audio.ambientGain = ambientGain;
      audio.ambient = ambient;
      audio.mixTarget = '';
      applyMotionMix(true);
      return true;
    } catch (e) {
      recordError(e);
      audio.mixBus = null;
      audio.realGain = null;
      audio.ambientGain = null;
      return false;
    }
  }

  function agentMotionMode() {
    return state.motion === 'agent' || state.motion === 'agent_music';
  }

  // Recent real audio: the same window `music` mode uses to settle in silence.
  function musicPresent() {
    return (now() - state.lastAudioAt) <= SILENCE_MS;
  }

  // Pure gate, also exposed on window.__aura for the Node logic test.
  // Returns null for the non-agent motion values.
  function agentMotionGate(motion, agentActive, musicNow) {
    if (motion === 'agent') {
      return { ambient: !!agentActive, real: false, pause: !agentActive };
    }
    if (motion === 'agent_music') {
      const real = !!musicNow;
      return { ambient: !real && !!agentActive, real, pause: !agentActive && !real };
    }
    return null;
  }

  function desiredMix() {
    if (state.motion === 'designs') return 'ambient';
    if (state.motion === 'music') return 'real';
    if (state.motion === 'agent') return 'ambient';
    if (state.motion === 'agent_music') return musicPresent() ? 'real' : 'ambient';
    return state.ambientFallback ? 'ambient' : 'real';
  }

  function rampGain(param, value, seconds) {
    if (!param || !audio.ctx) return;
    const t = audio.ctx.currentTime;
    const fade = Math.max(0.01, seconds);
    try {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(value, t + fade);
    } catch (_) {
      try { param.value = value; } catch (e) { /* a dead context settles on its own */ }
    }
  }

  function applyMotionMix(immediate) {
    if (!audio.realGain || !audio.ambientGain) return;
    const target = desiredMix();
    const gate = idleGate();
    if (audio.mixTarget === target && audio.mixGate === gate) return;
    audio.mixTarget = target;
    audio.mixGate = gate;
    const fade = immediate ? 0.01 : MOTION_FADE_S;
    // The idle gate multiplies whichever source is live; it beats the source
    // choice, and an attention mood already returned 1 from idleGate().
    rampGain(audio.realGain.gain, (target === 'real' ? 1 : 0) * gate, fade);
    rampGain(audio.ambientGain.gain, (target === 'ambient' ? 1 : 0) * gate, fade);
  }

  // Motion follows the agent: while the mood is idle or done, the render gain
  // follows idle_motion. Precedence: an attention mood (approval/error) beats
  // this gate; the gate beats the audio/design source choice.
  function idleGate() {
    if (ATTENTION.includes(mood.current)) return 1;
    if (state.idleMotion === 'always') return 1;
    if (mood.current !== 'idle' && mood.current !== 'done') return 1;
    return state.idleMotion === 'stop' ? 0 : IDLE_EMBER_GAIN;
  }

  function setIdleMotionUI(value) {
    const idleMotion = IDLE_MOTIONS.indexOf(value) !== -1 ? value : 'always';
    if (idleMotion === state.idleMotion) return;
    state.idleMotion = idleMotion;
    if (dom.root) dom.root.dataset.idleMotion = idleMotion;
    // Re-ease the live mix now: the mood may already be idle/done.
    applyMotionMix();
  }

  function ambientActive() {
    if (state.motion === 'designs') return true;
    if (state.motion === 'agent') return state.agentActive;
    if (state.motion === 'agent_music') return state.agentActive && !musicPresent();
    return state.motion === 'both' && state.ambientFallback;
  }

  function setMotionUI(value) {
    const motion = MOTIONS.indexOf(value) !== -1 ? value : 'both';
    state.motion = motion;
    state.ambientFallback = motion === 'designs';
    if (dom.motion) dom.motion.value = motion;
    if (dom.root) dom.root.dataset.motion = motion;
    if (dom.slider) {
      const disabled = motion === 'designs';
      dom.slider.disabled = disabled;
      if (dom.slider.setAttribute) dom.slider.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    }
    applyMotionMix();
    if (agentMotionMode()) {
      // First sight of agent mode with no tracked mood: start the idle grace
      // from now rather than pausing instantly on a mode switch.
      if (!state.agentActive && state.agentIdleSince < 0) {
        state.agentIdleSince = now();
        scheduleAgentIdlePause();
      }
      evaluateAgentMotion();
    } else if (ambientActive()) {
      if (state.renderPaused) resumeVisual();
    } else if (state.motion === 'music' && musicPresent() && state.renderPaused) {
      resumeVisual();
    }
  }

  function initViz() {
    if (viz) return true;
    if (hardBlocker() === 'webgl' || hardBlocker() === 'token' || hardBlocker() === 'capture') return false;
    if (!audio.ctx) return false;
    const webgl = applyQualityTier();
    if (!webgl.ok) {
      block('webgl', 'WebGL 2 is unavailable here — showing the accent-only fallback.');
      return false;
    }
    const BC = window.butterchurn && (window.butterchurn.default || window.butterchurn);
    if (!BC || typeof BC.createVisualizer !== 'function') {
      block('webgl', 'The visualizer library failed to load — showing the accent-only fallback.');
      return false;
    }
    resizeCanvas();
    try {
      viz = BC.createVisualizer(audio.ctx, dom.canvas, {
        width: state.canvas.w,
        height: state.canvas.h,
        pixelRatio: 1
      });
      ensureMotionGraph();
      viz.connectAudio(audio.mixBus || audio.node);
    } catch (e) {
      recordError(e);
      viz = null;
      block('webgl', 'The visualizer could not start on this GPU — showing the accent-only fallback.');
      return false;
    }
    const initial = pickInitialPreset();
    if (initial) loadPresetByName(initial, 0);
    if (state.enabled) startLoop();
    if (!silenceTimer) silenceTimer = setInterval(tickSilence, 250);
    // Load the extra packs only after the first frame is underway, during idle
    // time (or at most 2 s later). Parsing ~1.7 MB must never delay first paint
    // or the opening seconds of the visual.
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => loadExtraPacks(), { timeout: 2000 });
    } else {
      setTimeout(loadExtraPacks, 2000);
    }
    return true;
  }

  function pushFrameTime(dt) {
    frameTimes.push(dt);
    if (frameTimes.length > 120) frameTimes.shift();
  }

  function medianFrameTime() {
    if (frameTimes.length < 5) return 0;
    const s = frameTimes.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  function medianSyncTime() {
    if (syncTimes.length < 3) return 0;
    const s = syncTimes.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  function degradeLadder() {
    // Deeper software steps: SwiftShader can be several times slower than a GPU,
    // so shrinking the drawing buffer is the only lever that actually buys frames.
    return quality.software
      ? [{ scale: 0.45, fps: 24 }, { scale: 0.34, fps: 20 }, { scale: 0.26, fps: 16 },
         { scale: 0.18, fps: 12 }, { scale: 0.12, fps: 8 }]
      : [{ scale: 1, fps: 30 }, { scale: 0.75, fps: 24 }, { scale: 0.55, fps: 18 },
         { scale: 0.4, fps: 14 }, { scale: 0.3, fps: 10 }];
  }

  function applyQualityStep(level) {
    const ladder = degradeLadder();
    quality.degradeLevel = clamp(level, 0, ladder.length - 1);
    quality.renderScale = ladder[quality.degradeLevel].scale;
    quality.fpsCap = ladder[quality.degradeLevel].fps;
    if (state.reducedMotion) quality.fpsCap = Math.min(quality.fpsCap, 30);
  }

  function evaluateDegrade() {
    // gl.finish() gives the real GPU-inclusive cost; render() alone returns before
    // SwiftShader has drawn, which would hide a missed budget.
    const p50 = Math.max(medianFrameTime(), medianSyncTime());
    if (!p50) return;
    const budget = 1000 / quality.fpsCap;
    if (p50 <= budget * 1.6) {
      // Sustained headroom: step back up toward the original quality. Without
      // this a transient stall would leave the backdrop permanently tiny.
      quality.goodStreak += 1;
      if (quality.goodStreak >= 6 && quality.degradeLevel > 0) {
        quality.goodStreak = 0;
        quality.perfLimited = false;
        quality.degradedToFallback = false;
        unblock('perf');
        applyQualityStep(quality.degradeLevel - 1);
        resizeCanvas();
      }
      return;
    }
    quality.goodStreak = 0;
    const ladder = degradeLadder();
    const next = Math.min(quality.degradeLevel + 1, ladder.length - 1);
    if (next === quality.degradeLevel) {
      // At the floor and still missing frames. Do NOT stop drawing: REVamp's
      // frame budget only skips frames, and a 4 fps backdrop still reacts to
      // music while a hidden canvas is indistinguishable from a frozen one.
      if (p50 > 260 && !quality.perfLimited) {
        quality.perfLimited = true;
        quality.degradedToFallback = true;
        block('perf', 'Rendering is slow on this GPU — keeping a reduced frame rate.');
      }
      return;
    }
    quality.perfLimited = false;
    quality.degradedToFallback = false;
    if (blockers.has('perf')) unblock('perf');
    applyQualityStep(next);
    resizeCanvas();
  }

  function noteRenderError(err) {
    renderErrorStreak += 1;
    // Keep the error list bounded and the console quiet during a bad streak.
    if (renderErrorStreak === 1 || renderErrorStreak % 20 === 0) recordError(err);
    if (renderErrorStreak % 10 === 0 && catalog.presets.length) {
      // The preset itself may be what throws; rotate before giving up.
      const allowed = availableAllowedPresets();
      let attempts = allowed.length;
      while (attempts-- > 0) {
        const name = presetBag.draw(allowed, state.presetName);
        if (!name) break;
        if (loadPresetByName(name, 0, false)) break;
      }
    }
  }

  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    if (!viz || !state.enabled) return;
    if (hardBlocker()) return;
    if (state.renderPaused) return; // silence gate: nothing to draw
    const interval = 1000 / quality.fpsCap;
    if (ts - lastRenderAt < interval - 1.5) return;
    const t0 = now();
    try {
      renderFrame();
    } catch (e) {
      // A preset (or a lost context) can throw. Never treat one bad frame as a
      // permanent graphics failure: rotate away from the preset and keep going.
      noteRenderError(e);
      lastRenderAt = ts;
      return;
    }
    renderErrorStreak = 0;
    lastRenderAt = ts;
    state.frames += 1;
    if (probeRecorder) {
      const cap = captureCanvas();
      if (cap) {
        probeRecorder.push({
          t: Date.now(),
          mean: cap.mean,
          lit: cap.lit,
          hash: cap.hash,
          grid: cap.grid,
          diff: cap.diff,
          frames: state.frames,
          audioRms: Number(pcmRms().toFixed(4))
        });
        if (probeRecorder.length > 6000) probeRecorder.shift();
      }
    }
    const dt = now() - t0;
    pushFrameTime(dt);
    if (state.frames % 5 === 0 && dom.canvas) {
      // Real cost, including the GPU work that render() only queues: a 1x1
      // readPixels blocks until SwiftShader has actually drawn the frame.
      let gl = null;
      try { gl = dom.canvas.getContext('webgl2'); } catch (_) {}
      if (gl) {
        try { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncProbe); } catch (_) {}
      }
      syncTimes.push(now() - t0);
      if (syncTimes.length > 10) syncTimes.shift();
    }
    if (state.frames % 20 === 0) evaluateDegrade();
  }

  function startLoop() {
    if (rafId) return;
    rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  // ---------------------------------------------------------------------------
  // silence gate
  // ---------------------------------------------------------------------------

  // Butterchurn presets animate on their own internal time as well as the audio,
  // so a bright preset keeps glowing with nothing playing (measured: 20 of 21
  // curated presets stayed lit at mean 24..155 in silence). The visual is
  // supposed to follow the audio, so sustained silence fades the canvas out and
  // clears its drawing buffer; any audio resumes it at the user's opacity.
  const SILENCE_MS = 1200;
  const SILENCE_FADE_MS = 600;

  // Agent activity gate. Driven by the RAW mood (before moodReactive/enabled
  // coercion) so turning mood colours off cannot freeze agent motion.
  function noteAgentMood(rawMood) {
    const active = AGENT_ACTIVE_MOODS.indexOf(rawMood) !== -1;
    if (active) {
      state.agentActive = true;
      state.agentIdleSince = -1;
      if (agentIdleTimer) { clearTimeout(agentIdleTimer); agentIdleTimer = null; }
      if (agentMotionMode()) {
        applyMotionMix();
        // Resume within the same tick as the mood event.
        if (state.renderPaused) resumeVisual();
      }
      return;
    }
    if (!state.agentActive && state.agentIdleSince >= 0) {
      // Keep the first idle instant; make sure the grace timer is armed.
      if (!agentIdleTimer) scheduleAgentIdlePause();
      return;
    }
    state.agentActive = false;
    state.agentIdleSince = now();
    scheduleAgentIdlePause();
  }

  function scheduleAgentIdlePause() {
    if (!agentMotionMode()) return;
    if (agentIdleTimer) { clearTimeout(agentIdleTimer); agentIdleTimer = null; }
    const remaining = Math.max(0, AGENT_IDLE_GRACE_MS - (now() - state.agentIdleSince));
    agentIdleTimer = setTimeout(() => {
      agentIdleTimer = null;
      evaluateAgentMotion();
    }, remaining);
  }

  function evaluateAgentMotion() {
    if (!agentMotionMode()) return;
    if (!state.enabled) {
      if (state.renderPaused) resumeVisual();
      return;
    }
    if (hardBlocker()) return;
    const gate = agentMotionGate(state.motion, state.agentActive, musicPresent());
    if (!gate) return;
    applyMotionMix();
    const settled = state.agentIdleSince >= 0
      && (now() - state.agentIdleSince) >= AGENT_IDLE_GRACE_MS;
    if (gate.pause && settled) pauseVisual();
    else if (state.renderPaused) resumeVisual();
  }

  function clearVisual() {
    if (!dom.canvas) return;
    let gl = null;
    try { gl = dom.canvas.getContext('webgl2'); } catch (_) { gl = null; }
    if (!gl) return;
    try {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } catch (_) { /* a lost context clears on restore anyway */ }
  }

  function pauseVisual() {
    if (state.renderPaused) return;
    state.renderPaused = true;
    if (dom.canvas) {
      dom.canvas.style.transition = 'opacity ' + SILENCE_FADE_MS + 'ms ease';
      dom.canvas.style.opacity = '0';
    }
    clearVisual();
    if (dom.root) dom.root.dataset.silence = '1';
  }

  function resumeVisual() {
    if (!state.renderPaused) return;
    state.renderPaused = false;
    if (dom.canvas) dom.canvas.style.opacity = state.enabled ? String(state.opacity) : String(state.opacity * 0.35);
    if (dom.root) dom.root.dataset.silence = '0';
    lastRenderAt = 0;
    if (viz) { try { renderFrame(); } catch (_) {} }
  }

  // Called for every PCM frame and every feature event: silence=true means the
  // capture produced no audio, so it must not count as audio presence.
  function noteAudio(silent) {
    if (silent) return;
    state.lastAudioAt = now();
    if (state.motion === 'both' && state.ambientFallback) {
      // Sound is back: crossfade from designs to the real audio.
      state.ambientFallback = false;
      applyMotionMix();
    }
    if (state.motion === 'agent_music') applyMotionMix();
    if (state.renderPaused) {
      // agent: only agent activity moves the visual. agent_music: real audio
      // also moves it. In plain agent mode, music alone must not wake it.
      if (agentMotionMode()) {
        if (state.agentActive || (state.motion === 'agent_music' && musicPresent())) resumeVisual();
      } else {
        resumeVisual();
      }
    }
  }

  function tickSilence() {
    if (!state.enabled) { if (state.renderPaused) resumeVisual(); return; }
    if (hardBlocker()) return;
    const quiet = now() - state.lastAudioAt;

    if (agentMotionMode()) {
      evaluateAgentMotion();
      return;
    }

    if (state.motion === 'both') {
      const shouldRest = quiet > MOTION_SILENCE_MS;
      if (shouldRest !== state.ambientFallback) {
        state.ambientFallback = shouldRest;
        applyMotionMix();
      }
      // Ambient designs keep drawing; the silence gate only applies to real audio.
      if (state.renderPaused) resumeVisual();
      return;
    }

    applyMotionMix();

    if (state.motion === 'designs') {
      // The designs are the source, so silence must not fade the canvas.
      if (state.renderPaused) resumeVisual();
      return;
    }

    // music: real audio only. In silence the visuals settle (no ambient).
    if (quiet > SILENCE_MS) {
      pauseVisual();
    } else if (state.renderPaused) {
      resumeVisual();
    }
  }

  function pcmRms() {
    try {
      const pcm = latestPcm();
      let sum = 0;
      for (let i = 0; i < pcm.length; i += 1) sum += pcm[i] * pcm[i];
      return Math.sqrt(sum / pcm.length);
    } catch (_) {
      return 0;
    }
  }

  // Read the current drawing buffer into a coarse 4x4 brightness grid. Mean
  // luma alone barely moves when a preset reacts with motion rather than
  // brightness, which made beat-response tests read as noise.
  function captureCanvas() {
    if (!dom.canvas) return null;
    let gl = null;
    try { gl = dom.canvas.getContext('webgl2'); } catch { gl = null; }
    if (!gl) return null;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    if (!w || !h) return null;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let diff = null;
    if (prevProbeBuf && prevProbeBuf.length === buf.length) {
      let d = 0;
      let n = 0;
      for (let i = 0; i < buf.length; i += 16) {
        d += Math.abs(buf[i] - prevProbeBuf[i])
          + Math.abs(buf[i + 1] - prevProbeBuf[i + 1])
          + Math.abs(buf[i + 2] - prevProbeBuf[i + 2]);
        n += 3;
      }
      diff = d / n;
    }
    prevProbeBuf = buf;
    let sum = 0;
    let lit = 0;
    let hash = 0;
    const stride = 16;
    const cells = new Float64Array(16);
    const counts = new Float64Array(16);
    for (let i = 0; i < buf.length; i += stride) {
      const v = buf[i] + buf[i + 1] + buf[i + 2];
      sum += v;
      if (v > 12) lit += 1;
      hash = (hash * 31 + v) | 0;
      const px = (i / 4) | 0;
      const x = px % w;
      const y = (px / w) | 0;
      const cell = Math.min(3, (x * 4 / w) | 0) + 4 * Math.min(3, (y * 4 / h) | 0);
      cells[cell] += v;
      counts[cell] += 1;
    }
    const grid = [];
    for (let c = 0; c < 16; c += 1) grid.push(counts[c] ? Math.round(cells[c] / counts[c] / 3) : 0);
    return {
      mean: Math.round(sum / (buf.length / stride) / 3),
      lit,
      hash,
      grid,
      diff,
      w,
      h
    };
  }

  function sampleNow() {
    if (!viz || !dom.canvas) return null;
    if (state.renderPaused) {
      // Silence: the buffer is cleared, so a sample reads black without waking
      // the preset up (viz.render() would draw a bright frame again).
      clearVisual();
    } else {
      try { renderFrame(); } catch (e) { recordError(e); return null; }
    }
    const cap = captureCanvas();
    if (!cap) return null;
    lastSample = Object.assign(cap, {
      frames: state.frames,
      audioRms: Number(pcmRms().toFixed(4)),
      mood: mood.current,
      preset: state.presetName,
      intensity: Number(state.effectiveIntensity.toFixed(3)),
      sampleGain: Number(state.sampleGain.toFixed(3)),
      autoGain: Number(agcGain.toFixed(3))
    });
    return lastSample;
  }

  // ---------------------------------------------------------------------------
  // audio-driven visuals — PCM ring buffer, independent of AudioContext state
  // ---------------------------------------------------------------------------

  // Pure: ordered PCM samples -> the three unsigned time-domain byte arrays
  // Butterchurn expects (128 = silence). reducedMotion scales the deviation
  // from silence so the preset reacts gently without hard cuts.
  function buildAudioLevels(samples) {
    const timeByteArray = new Uint8Array(PCM_RING_SIZE);
    timeByteArray.fill(128);
    const src = samples || new Float32Array(0);
    const n = Math.min(src.length, PCM_RING_SIZE);
    const start = src.length - n;
    const scale = state.reducedMotion ? 0.5 : 1;
    for (let i = 0; i < n; i += 1) {
      const v = clamp(num(src[start + i], 0), -1, 1) * scale;
      timeByteArray[PCM_RING_SIZE - n + i] = clamp(Math.round(128 + v * 127), 0, 255);
    }
    return {
      timeByteArray,
      timeByteArrayL: new Uint8Array(timeByteArray),
      timeByteArrayR: new Uint8Array(timeByteArray)
    };
  }

  function appendPcm(samples) {
    for (let i = 0; i < samples.length; i += 1) {
      pcmRing[pcmWrite] = clamp(samples[i], -1, 1);
      pcmWrite = (pcmWrite + 1) % PCM_RING_SIZE;
      if (pcmFilled < PCM_RING_SIZE) pcmFilled += 1;
    }
    lastPcmAt = now();
  }

  function latestPcm() {
    const out = new Float32Array(PCM_RING_SIZE);
    if (!pcmFilled) return out;
    let idx = (pcmWrite - pcmFilled + PCM_RING_SIZE) % PCM_RING_SIZE;
    for (let i = 0; i < pcmFilled; i += 1) {
      out[i] = pcmRing[idx];
      idx = (idx + 1) % PCM_RING_SIZE;
    }
    return out;
  }

  // No PCM for a while (or none yet): feed silence so presets settle the way
  // MilkDrop does instead of free-running on stale samples.
  function currentAudioLevels() {
    if (!lastPcmAt || (now() - lastPcmAt) > PCM_STALE_MS) {
      return buildAudioLevels(new Float32Array(PCM_RING_SIZE));
    }
    return buildAudioLevels(latestPcm());
  }

  function renderFrame() {
    if (!viz) return false;
    viz.render({ audioLevels: currentAudioLevels() });
    state.lastRenderedPcmSeq = state.lastPcmSeq;
    return true;
  }

  // A strong onset may jump straight to a new preset ("hard cut"), but never
  // more than once every 8 s, and never for calm/reduced-motion/auto-off.
  function maybeHardCut() {
    if (!viz || state.reducedMotion || !state.autoPreset) return false;
    const t = now();
    const minMs = state.behavior === 'calm' ? HARD_CUT_MIN_MS_CALM : HARD_CUT_MIN_MS;
    if (t - lastHardCutAt < minMs) return false;
    const allowed = availableAllowedPresets();
    if (!allowed.length) return false;
    const family = activeProfile().preset_family;
    const preferred = allowed.filter((p) => p.family === family && p.name !== state.presetName);
    const anyOther = allowed.filter((p) => p.name !== state.presetName);
    const pool = preferred.length ? preferred : anyOther;
    if (!pool.length) return false;
    let attempts = pool.length;
    while (attempts-- > 0) {
      const name = presetBag.draw(pool, state.presetName);
      if (!name) break;
      if (!loadPresetByName(name, 0, false)) continue;
      lastHardCutAt = t;
      return true;
    }
    return false;
  }

  // Local energy-flux onset detector on the incoming PCM. It complements the
  // server's features.onset; both are rate-limited by maybeHardCut().
  function detectLocalOnset(samples) {
    if (!samples.length) return;
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    const rise = rms - fluxPrevRms;
    fluxPrevRms = rms;
    if (rms > 0.06 && rise > 0.05) maybeHardCut();
  }

  // ---------------------------------------------------------------------------
  // audio graph — silent by construction
  // ---------------------------------------------------------------------------

  function resampleMono(samples, fromRate, toRate, gain) {
    const n = samples.length;
    if (Math.abs(fromRate - toRate) < 1) {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = clamp(samples[i] * gain, -1, 1);
      return out;
    }
    const ratio = toRate / fromRate;
    const outLen = Math.max(1, Math.round(n * ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const src = i / ratio;
      const i0 = Math.floor(src);
      const i1 = Math.min(n - 1, i0 + 1);
      const frac = src - i0;
      const v = samples[i0] * (1 - frac) + samples[i1] * frac;
      out[i] = clamp(v * gain, -1, 1);
    }
    return out;
  }

  async function initAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      block('audio', 'This view has no Web Audio — showing the accent-only fallback.');
      return false;
    }
    let ctx;
    try {
      ctx = new AC({ latencyHint: 'interactive', sampleRate: 48000 });
    } catch {
      try { ctx = new AC(); } catch (e2) {
        recordError(e2);
        block('audio', 'Web Audio could not start — showing the accent-only fallback.');
        return false;
      }
    }
    audio.ctx = ctx;
    audio.sampleRate = ctx.sampleRate;
    try {
      await ctx.audioWorklet.addModule('pcm-worklet.js');
    } catch (e) {
      recordError(e);
      block('audio', 'Audio processing is unavailable — showing the accent-only fallback.');
      return false;
    }
    try {
      const node = new AudioWorkletNode(ctx, 'aura-pcm', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { maxQueueSamples: Math.round(ctx.sampleRate * 0.25) }
      });
      // HARD RULE: the only path to the speakers goes through gain 0.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute);
      mute.connect(ctx.destination);
      node.port.onmessage = (event) => {
        const d = event.data || {};
        if (d.type === 'stats') state.droppedFrames = Math.max(state.droppedFrames, d.droppedFrames || 0);
      };
      audio.node = node;
      audio.mute = mute;
    } catch (e) {
      recordError(e);
      block('audio', 'Audio processing is unavailable — showing the accent-only fallback.');
      return false;
    }
    ctx.addEventListener('statechange', () => {
      if (ctx.state === 'running') {
        unblock('audio');
      } else if (ctx.state === 'suspended') {
        audioSuspended();
      }
    });
    // Autoplay-blocked contexts never resolve resume() until the user gestures,
    // and boot() must not wait on that: the page still has to connect, show the
    // mood/status, and arm the gesture resume. Race it with a short timeout.
    try {
      const resumed = ctx.resume();
      if (resumed && typeof resumed.then === 'function') {
        Promise.race([resumed, new Promise((r) => setTimeout(r, 300))]).catch(() => {});
      }
    } catch (e) { recordError(e); }
    if (ctx.state !== 'running') {
      audioSuspended();
    }
    return true;
  }

  // The app backdrop is click-through, so it can never receive the gesture
  // autoplay wants. There the designs keep drawing (presets animate on time
  // alone) and resume is retried quietly; the parent window's own activation
  // can unlock it through allow="autoplay".
  let resumeRetry = null;
  function audioSuspended() {
    // The visual no longer needs the Web Audio graph (PCM drives Butterchurn
    // directly), so a suspended context is not a blocker anywhere — including
    // the click-through overlay that can never get an autoplay gesture.
    unblock('audio');
    if (!viz) initViz();
    startLoop();
    if (!OVERLAY) armGestureResume();
    if (resumeRetry) return;
    resumeRetry = setInterval(() => {
      if (!audio.ctx || audio.ctx.state === 'running') {
        clearInterval(resumeRetry);
        resumeRetry = null;
        return;
      }
      try { audio.ctx.resume().catch(() => {}); } catch (_) { /* retried next tick */ }
    }, 2000);
  }

  let gestureArmed = false;
  function armGestureResume() {
    if (gestureArmed) return;
    gestureArmed = true;
    const resume = () => {
      if (!audio.ctx) return;
      audio.ctx.resume().then(() => {
        if (audio.ctx.state === 'running') {
          unblock('audio');
          if (!viz) initViz();
        }
      }).catch(() => {});
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
      gestureArmed = false;
    };
    window.addEventListener('pointerdown', resume, { passive: true });
    window.addEventListener('keydown', resume, { passive: true });
  }

  function parsePcm(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 32) return null;
    const dv = new DataView(buffer);
    if (dv.getUint8(0) !== 0x41 || dv.getUint8(1) !== 0x55 || dv.getUint8(2) !== 0x52 || dv.getUint8(3) !== 0x41) return null;
    if (dv.getUint8(4) !== 1) return null;
    const flags = dv.getUint8(5);
    if (dv.getUint16(6, true) !== 32) return null;
    const seq = Number(dv.getBigUint64(8, true));
    const ts = Number(dv.getBigUint64(16, true));
    const rate = dv.getUint32(24, true);
    const count = dv.getUint32(28, true);
    if (count === 0 || count > 1024) return null;
    if (buffer.byteLength !== 32 + count * 4) return null;
    if (rate <= 0) return null;
    return {
      seq,
      ts,
      rate,
      count,
      silence: (flags & 1) === 1,
      samples: new Float32Array(buffer, 32, count)
    };
  }

  function feedPcm(frame) {
    const samples = frame.samples;
    // Trust the samples, not the server's stale silence bit. A quiet monitor
    // capture can be flagged silent for up to 100 ms (features are stale), and
    // zeroing it here used to discard the very audio that should drive Aura.
    const nearSilent = isNearSilent(samples);
    noteAudio(nearSilent);
    if (socket.ws && socket.ws.bufferedAmount > 512 * 1024) {
      // Socket backed up: drop this frame rather than queue latency.
      state.droppedFrames += 1;
      return;
    }
    const gain = sampleGain() * updateAutoGain(samples);
    // Visual analysis always runs, at 48 kHz, whether or not the worklet graph
    // is alive. This is what makes the backdrop follow the music.
    const visualSamples = resampleMono(samples, frame.rate || 48000, 48000, gain);
    appendPcm(visualSamples);
    state.lastPcmSeq = frame.seq;
    if (!nearSilent) detectLocalOnset(samples);
    else fluxPrevRms = 0;
    if (!audio.node || !audio.ctx) return;
    const out = resampleMono(samples, frame.rate || 48000, audio.ctx.sampleRate || 48000, gain);
    try {
      audio.node.port.postMessage({ samples: out }, [out.buffer]);
    } catch (e) {
      recordError(e);
    }
  }

  // ---------------------------------------------------------------------------
  // websocket
  // ---------------------------------------------------------------------------

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/api/stream?token=' + encodeURIComponent(TOKEN);
  }

  function handleText(raw) {
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'features': {
        state.lastFeatures = {
          level: clamp(num(ev.level, 0), 0, 1),
          bands: Array.isArray(ev.bands) ? ev.bands.slice(0, 8).map((b) => clamp(num(b, 0), 0, 1)) : [],
          onset: !!ev.onset,
          centroid: clamp(num(ev.centroid, 0), 0, 1),
          flatness: clamp(num(ev.flatness, 0), 0, 1),
          silence: !!ev.silence
        };
        noteAudio(!!ev.silence);
        if (state.lastFeatures.onset && !state.lastFeatures.silence) maybeHardCut();
        updateMoodVisuals();
        break;
      }
      case 'mood':
        applyMood(ev.mood, num(ev.intensity, 0.6), num(ev.ttl_ms, 0));
        break;
      case 'preset':
        // auto_preset=false: rotation stops cleanly. A manual preset still
        // arrives through the config event and is applied there.
        if (!state.autoPreset) break;
        loadPresetByName(ev.name, num(ev.blend_ms, num(activeProfile().blend_ms, 1200)));
        break;
      case 'config':
        applyConfig(ev);
        break;
      case 'error':
        recordError(ev.code + ': ' + ev.message);
        if (ev.code === 'capture_lost') {
          block('capture', 'System audio capture was lost — showing the accent-only fallback.');
        }
        break;
      case 'pong':
      default:
        break;
    }
  }

  function handleBinary(buffer) {
    const frame = parsePcm(buffer);
    if (!frame) {
      state.badFrames += 1;
      return;
    }
    state.lastSeq = frame.seq;
    feedPcm(frame);
  }

  function connect() {
    if (blockers.has('token')) {
      socket.state = 'refused';
      renderStatus();
      return;
    }
    if (socket.ws && (socket.ws.readyState === WebSocket.CONNECTING || socket.ws.readyState === WebSocket.OPEN)) return;
    if (!TOKEN) {
      block('token', 'Aura needs its access token — open it from the Aura plugin.');
      socket.state = 'refused';
      renderStatus();
      return;
    }
    socket.state = socket.attempt === 0 ? 'connecting' : 'reconnecting';
    renderStatus();
    let ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      recordError(e);
      scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    socket.ws = ws;
    ws.onopen = () => {
      socket.attempt = 0;
      socket.state = 'connected';
      renderStatus();
    };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') handleText(event.data);
      else handleBinary(event.data);
    };
    ws.onclose = (event) => {
      // A late close from a socket we already replaced must not touch the new
      // one, and nothing should reconnect while the page is hidden.
      if (socket.ws && socket.ws !== ws) return;
      socket.ws = null;
      setMoodIdle();
      if (socket.suspended) { socket.state = 'boot'; renderStatus(); return; }
      if (event.code === 1008) {
        socket.state = 'refused';
        block('token', 'Aura refused this token (1008) — reopen it from the plugin.');
        renderStatus();
        return; // a bad token will not fix itself by retrying
      }
      socket.state = 'reconnecting';
      renderStatus();
      scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  function scheduleReconnect() {
    if (socket.suspended) return;
    socket.attempt += 1;
    const delay = Math.min(5000, 400 * Math.pow(1.7, socket.attempt - 1)) + Math.random() * 150;
    if (socket.timer) clearTimeout(socket.timer);
    socket.timer = setTimeout(() => { socket.timer = null; connect(); }, delay);
  }

  function disconnect() {
    if (socket.timer) { clearTimeout(socket.timer); socket.timer = null; }
    if (socket.ws) {
      try { socket.ws.close(); } catch (_) {}
      socket.ws = null;
    }
    socket.state = 'boot';
  }

  // The browser never tells the server when a tab goes away, so the socket used
  // to die by timeout. Tear it down deliberately, and reconnect if the page is
  // restored from the back/forward cache.
  window.addEventListener('pagehide', () => { socket.suspended = true; disconnect() })
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    socket.suspended = false;
    socket.attempt = 0;
    connect();
  })
  // Coming back from bfcache resets UI timers that the browser froze; an
  // explicit reconnect is the only reliable way to know the stream is live.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !socket.ws && !socket.suspended) connect();
  })

  // ---------------------------------------------------------------------------
  // config + controls
  // ---------------------------------------------------------------------------

  function applyConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    // `enabled` is the server-side truth: desktop settings and aura_control turn
    // Aura on through /api/control, and the page must follow that change.
    if (typeof cfg.enabled === 'boolean' && cfg.enabled !== state.enabled) setEnabledUI(cfg.enabled);
    if (typeof cfg.reduced_motion === 'boolean') setReducedMotion(cfg.reduced_motion || FORCE_REDUCED);
    if (typeof cfg.intensity === 'number' && !draggingIntensity) {
      setIntensityUI(clamp(cfg.intensity, 0, 1));
    }
    if (typeof cfg.opacity === 'number' && !draggingOpacity) {
      setOpacityUI(clamp(cfg.opacity, 0, 1));
    }
    if (typeof cfg.auto_preset === 'boolean') setAutoPresetUI(cfg.auto_preset);
    if (typeof cfg.behavior === 'string') {
      setBehaviorUI(cfg.behavior, cfg.behavior_profile);
    }
    if (typeof cfg.motion === 'string') {
      setMotionUI(cfg.motion);
    }
    if (typeof cfg.idle_motion === 'string') {
      setIdleMotionUI(cfg.idle_motion);
    }
    if (typeof cfg.mood_reactive === 'boolean') setMoodReactiveUI(cfg.mood_reactive);
    if (typeof cfg.accent_pulse === 'boolean') setAccentPulseUI(cfg.accent_pulse);
    // A manually chosen preset arrives through the config event; preset
    // *rotation* arrives as its own event and is gated by auto_preset.
    if (typeof cfg.preset === 'string' && cfg.preset && cfg.preset !== state.presetName) {
      loadPresetByName(cfg.preset, num(activeProfile().blend_ms, 1200));
    }
    if (typeof cfg.capture === 'string') syncCaptureFallback(cfg.capture);
  }

  function setBehaviorUI(name, serverProfile) {
    const saved = (typeof name === 'string' && Object.prototype.hasOwnProperty.call(BEHAVIOR_PROFILES, name))
      ? name : DEFAULT_BEHAVIOR;
    // Overlay mode is ambient and must stay calm by default. Only an explicit
    // saved 'intense' choice survives, because the user asked for that.
    const key = (OVERLAY && saved !== 'intense') ? 'calm' : saved;
    const p = Object.assign({}, BEHAVIOR_PROFILES[key]);
    const profileMatches = key === saved;
    if (profileMatches && serverProfile && typeof serverProfile === 'object') {
      // The server publishes the mapping (§9); take its numbers when sane.
      for (const k of ['intensity_ceiling', 'pulse_hz_max', 'blend_ms', 'mood_gain_scale']) {
        if (typeof serverProfile[k] === 'number' && isFinite(serverProfile[k])) p[k] = serverProfile[k];
      }
      if (typeof serverProfile.preset_family === 'string') p.preset_family = serverProfile.preset_family;
      if (typeof serverProfile.allow_strobe === 'boolean') p.allow_strobe = serverProfile.allow_strobe;
      if (typeof serverProfile.hard_pulse === 'boolean') p.hard_pulse = serverProfile.hard_pulse;
    }
    p.pulse_hz_max = clamp(num(p.pulse_hz_max, 0), 0, 2); // contract cap
    p.intensity_ceiling = clamp(num(p.intensity_ceiling, 1), 0, 1);
    state.behavior = key;
    state.behaviorProfile = p;
    if (dom.behavior) dom.behavior.value = key;
    if (dom.root) dom.root.dataset.behavior = key;
    if (state.presetStrobe && !strobeAllowed()) {
      const calm = allowedPresets()[0];
      if (calm) loadPresetByName(calm.name, num(p.blend_ms, 1200));
    }
    if (state.autoPreset && viz) pickPresetForFamily(p.preset_family);
    stopPulse();
    startPulse();
    updateMoodVisuals();
  }

  function setMoodReactiveUI(on) {
    const next = !!on;
    if (next === state.moodReactive) return;
    state.moodReactive = next;
    if (dom.root) dom.root.dataset.moodReactive = next ? '1' : '0';
    if (!next) {
      // Drop any held mood and its pulse; nothing latched survives.
      mood.previous = 'idle';
      applyMood('idle', 0, 0);
    } else {
      // Turning it back on applies the server's current mood without a reload.
      refreshMood();
    }
  }

  function setAccentPulseUI(on) {
    state.accentPulse = !!on;
    if (dom.root) dom.root.dataset.accentPulse = state.accentPulse ? '1' : '0';
  }

  function setAutoPresetUI(on) {
    const next = !!on;
    state.autoPreset = next;
    if (dom.root) dom.root.dataset.autoPreset = next ? '1' : '0';
    if (next && viz) pickPresetForFamily(activeProfile().preset_family);
  }

  async function refreshMood() {
    if (!state.moodReactive || !TOKEN) return;
    const st = await getJson('/api/state');
    if (st.ok && st.json && typeof st.json.mood === 'string' && MOODS.includes(st.json.mood)) {
      applyMood(st.json.mood, num(st.json.intensity, 0.6), 4000);
    }
  }

  function syncCaptureFallback(capture) {
    state.capture = capture;
    if (capture === 'none' && state.motion !== 'music') {
      // No capture, but designs still move on the ambient source. This is an
      // informational notice, never a hard blocker: the canvas keeps drawing.
      unblock('capture');
      state.captureNotice = CAPTURE_NONE_AMBIENT;
      state.ambientFallback = true;
      applyMotionMix();
      if (!viz) initViz();
      else startLoop();
    } else if (capture === 'none') {
      // Music mode needs real audio for its visuals, so capture is a blocker here.
      state.captureNotice = null;
      block('capture', CAPTURE_NONE_BLOCKED);
      if (viz) stopLoop();
    } else {
      state.captureNotice = null;
      unblock('capture');
      if (!viz) initViz();
      else startLoop();
    }
    renderStatus();
  }

  function setReducedMotion(on) {
    const next = !!on;
    if (next === state.reducedMotion) return;
    state.reducedMotion = next;
    if (dom.root) dom.root.dataset.reducedMotion = next ? '1' : '0';
    // Never strobe: if the current preset is flagged strobe, blend to a calm one.
    if (state.presetStrobe && !strobeAllowed()) {
      const calm = allowedPresets()[0];
      if (calm) loadPresetByName(calm.name, 1500);
    }
    if (viz) {
      const ladder = degradeLadder();
      const step = ladder[Math.min(quality.degradeLevel, ladder.length - 1)];
      quality.renderScale = step.scale;
      quality.fpsCap = step.fps;
      if (next) { quality.renderScale *= 0.9; quality.fpsCap = Math.min(quality.fpsCap, 30); }
      resizeCanvas();
    }
    updateMoodVisuals();
    stopPulse();
    startPulse();
  }

  function setIntensityUI(value) {
    state.userIntensity = clamp(value, 0, 1);
    if (dom.slider) {
      dom.slider.value = String(Math.round(state.userIntensity * 100));
      dom.slider.setAttribute('aria-valuetext', Math.round(state.userIntensity * 100) + ' percent');
    }
    if (dom.sliderOut) dom.sliderOut.textContent = Math.round(state.userIntensity * 100) + '%';
    updateMoodVisuals();
  }

  function setEnabledUI(enabled) {
    state.enabled = !!enabled;
    if (dom.toggle) {
      dom.toggle.setAttribute('aria-pressed', String(state.enabled));
      dom.toggle.textContent = state.enabled ? 'On' : 'Off';
    }
    if (dom.root) dom.root.dataset.enabled = state.enabled ? '1' : '0';
    if (!state.enabled) {
      setMoodIdle();
      stopLoop();
    } else {
      if (!viz) initViz();
      startLoop();
      setMoodIdle();
    }
    renderStatus();
  }

  let intensityPostTimer = null;
  function scheduleIntensityPost() {
    if (intensityPostTimer) clearTimeout(intensityPostTimer);
    intensityPostTimer = setTimeout(() => {
      intensityPostTimer = null;
      postControl({ intensity: Number(state.userIntensity.toFixed(3)) });
    }, 180);
  }

  let opacityPostTimer = null;
  function scheduleOpacityPost() {
    if (opacityPostTimer) clearTimeout(opacityPostTimer);
    opacityPostTimer = setTimeout(() => {
      opacityPostTimer = null;
      postControl({ opacity: Number(state.opacity.toFixed(3)) });
    }, 180);
  }

  function bindControls() {
    if (dom.slider) {
      dom.slider.addEventListener('pointerdown', () => { draggingIntensity = true; });
      dom.slider.addEventListener('pointerup', () => { draggingIntensity = false; });
      dom.slider.addEventListener('input', () => {
        const v = clamp(Number(dom.slider.value) / 100, 0, 1);
        draggingIntensity = true;
        setIntensityUI(v);
        scheduleIntensityPost();
      });
      dom.slider.addEventListener('change', () => {
        draggingIntensity = false;
        scheduleIntensityPost();
      });
      dom.slider.addEventListener('keyup', () => { draggingIntensity = false; });
    }
    if (dom.opacity) {
      dom.opacity.addEventListener('pointerdown', () => { draggingOpacity = true; });
      dom.opacity.addEventListener('pointerup', () => { draggingOpacity = false; });
      dom.opacity.addEventListener('input', () => {
        const v = clamp(Number(dom.opacity.value) / 100, 0, 1);
        draggingOpacity = true;
        setOpacityUI(v);
        scheduleOpacityPost();
      });
      dom.opacity.addEventListener('change', () => {
        draggingOpacity = false;
        scheduleOpacityPost();
      });
      dom.opacity.addEventListener('keyup', () => { draggingOpacity = false; });
    }
    if (dom.behavior) {
      dom.behavior.addEventListener('change', () => {
        const value = String(dom.behavior.value || '');
        if (!Object.prototype.hasOwnProperty.call(BEHAVIOR_PROFILES, value)) return;
        setBehaviorUI(value);
        postControl({ behavior: value });
      });
    }
    if (dom.motion) {
      dom.motion.addEventListener('change', () => {
        const value = String(dom.motion.value || '');
        if (MOTIONS.indexOf(value) === -1) return;
        setMotionUI(value);
        if (state.capture === 'none') syncCaptureFallback(state.capture);
        postControl({ motion: value });
      });
    }
    if (dom.toggle) {
      dom.toggle.addEventListener('click', () => {
        const next = !state.enabled;
        setEnabledUI(next);
        postControl({ enabled: next });
      });
    }
  }

  // A lost context is the one graphics failure that can recover on its own.
  // Hide the canvas while it is gone (accent-only), then resume when the GPU
  // hands it back instead of leaving a frozen frame forever.
  function setupContextRecovery() {
    if (!dom.canvas || !dom.canvas.addEventListener) return;
    dom.canvas.addEventListener('webglcontextlost', (event) => {
      try { event.preventDefault(); } catch (_) {}
      block('webgl', 'The graphics context was lost — waiting for it to come back.');
    }, false);
    dom.canvas.addEventListener('webglcontextrestored', () => {
      unblock('webgl');
      renderErrorStreak = 0;
      if (viz) {
        try { resizeCanvas(); } catch (_) {}
        startLoop();
      } else {
        initViz();
      }
    }, false);
  }

  // ---------------------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------------------

  async function boot() {
    dom.root = document.getElementById('aura-root');
    dom.stage = document.getElementById('aura-stage');
    dom.canvas = document.getElementById('aura-canvas');
    dom.tint = document.getElementById('aura-tint');
    dom.glow = document.getElementById('aura-glow');
    dom.scrim = document.getElementById('aura-scrim');
    dom.message = document.getElementById('aura-message');
    dom.mood = document.getElementById('aura-mood');
    dom.conn = document.getElementById('aura-conn');
    dom.slider = document.getElementById('aura-intensity');
    dom.sliderOut = document.getElementById('aura-intensity-out');
    dom.opacity = document.getElementById('aura-opacity');
    dom.opacityOut = document.getElementById('aura-opacity-out');
    dom.behavior = document.getElementById('aura-behavior');
    dom.motion = document.getElementById('aura-motion');
    dom.toggle = document.getElementById('aura-toggle');
    setupContextRecovery();
    if (dom.motion) dom.motion.value = state.motion;
    if (dom.slider) dom.slider.disabled = state.motion === 'designs';

    const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    state.reducedMotion = FORCE_REDUCED || !!(mq && mq.matches);
    if (dom.root) dom.root.dataset.reducedMotion = state.reducedMotion ? '1' : '0';
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', (e) => setReducedMotion(e.matches || FORCE_REDUCED));
    }
    // Some embedders apply the media emulation a beat after the first script run;
    // re-read once the document is live so the preference is never missed.
    if (mq) {
      setTimeout(() => setReducedMotion(FORCE_REDUCED || mq.matches), 350);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) setReducedMotion(FORCE_REDUCED || mq.matches);
      });
    }

    bindControls();
    observeResize();
    resizeCanvas();
    applyVisualOpacity();
    updateMoodChip();
    renderStatus();

    await loadCatalog();

    if (!TOKEN) {
      block('token', 'Aura needs its access token — open it from the Aura plugin.');
      state.ready = true;
      return;
    }

    const health = await getJson('/healthz');
    if (health.status === 401) {
      block('token', 'Aura refused this token (401) — reopen it from the plugin.');
      socket.state = 'refused';
    } else if (health.ok && health.json) {
      state.capture = String(health.json.capture || 'unknown');
      if (state.capture === 'none' && state.motion === 'music') {
        block('capture', CAPTURE_NONE_BLOCKED);
      }
    }

    const cfg = await getJson('/api/config');
    if (cfg.ok && cfg.json) applyConfig(cfg.json);

    const st = await getJson('/api/state');
    if (st.ok && st.json) {
      if (typeof st.json.enabled === 'boolean') setEnabledUI(st.json.enabled);
      if (typeof st.json.intensity === 'number') setIntensityUI(clamp(st.json.intensity, 0, 1));
      if (typeof st.json.mood === 'string' && MOODS.includes(st.json.mood)) {
        // Feed idle too: agent motion must start paused when the agent is idle
        // at load, and move when /api/state reports an active mood.
        applyMood(st.json.mood, num(st.json.intensity, 0.6), 4000);
      }
    }

    if (!blockers.has('token')) {
      const audioOk = await initAudio();
      if (audioOk && !hardBlocker()) initViz();
      else if (audioOk && hardBlocker() === 'capture') { /* viz waits for capture */ }
      connect();
    }

    renderStatus();
    state.ready = true;
  }

  // ---------------------------------------------------------------------------
  // test / inspection API (e2e drives this over CDP)
  // ---------------------------------------------------------------------------

  window.__aura = {
    _getJson: getJson,
    _loadCatalog: loadCatalog,
    _catalog() { return { presets: catalog.presets.slice(), default: catalog.default }; },
    _setFetchTimeoutMs(ms) {
      fetchTimeoutMs = Number(ms) > 0 ? Number(ms) : 5000;
    },
    snapshot() {
      return {
        ready: state.ready,
        errors: state.errors.slice(),
        enabled: state.enabled,
        capture: state.capture,
        reducedMotion: state.reducedMotion,
        socketState: socket.state,
        reconnectAttempts: socket.attempt,
        frames: state.frames,
        badFrames: state.badFrames,
        droppedFrames: state.droppedFrames,
        lastSeq: state.lastSeq,
        pcmSeq: state.lastPcmSeq,
        renderedPcmSeq: state.lastRenderedPcmSeq,
        autoGain: Number(agcGain.toFixed(3)),
        mood: mood.current,
        previousMood: mood.previous,
        moodTtl: mood.ttl,
        pulsePeriodMs: mood.pulsePeriod,
        intensity: Number(state.effectiveIntensity.toFixed(3)),
        userIntensity: Number(state.userIntensity.toFixed(3)),
        sampleGain: Number(state.sampleGain.toFixed(3)),
        opacity: Number(state.opacity.toFixed(3)),
        behavior: state.behavior,
        behaviorProfile: Object.assign({}, state.behaviorProfile),
        motion: state.motion,
        idleMotion: state.idleMotion,
        idleGate: idleGate(),
        ambientFallback: state.ambientFallback,
        agentActive: state.agentActive,
        agentIdleSince: state.agentIdleSince,
        moodReactive: state.moodReactive,
        accentPulse: state.accentPulse,
        autoPreset: state.autoPreset,
        overlay: OVERLAY,
        silent: state.renderPaused,
        canvasOpacity: dom.canvas ? dom.canvas.style.opacity : null,
        scrimOpacity: dom.scrim ? dom.scrim.style.opacity : null,
        scrimMix: dom.scrim ? {
          a: dom.scrim.style.getPropertyValue('--aura-scrim-a'),
          b: dom.scrim.style.getPropertyValue('--aura-scrim-b'),
          c: dom.scrim.style.getPropertyValue('--aura-scrim-c')
        } : null,
        preset: state.presetName,
        presetFamily: state.presetFamily,
        presetStrobe: state.presetStrobe,
        presetAnchor: state.presetAnchor,
        fallbackReasons: Array.from(blockers.keys()),
        fallbackActive: !!hardBlocker(),
        message: dom.message && !dom.message.hidden ? dom.message.textContent : null,
        messageTone: dom.message ? dom.message.dataset.tone : null,
        canvas: Object.assign({}, state.canvas),
        canvasAttrs: dom.canvas ? { width: dom.canvas.width, height: dom.canvas.height } : null,
        quality: {
          tier: quality.tier,
          renderer: quality.renderer,
          software: quality.software,
          renderScale: quality.renderScale,
          fpsCap: quality.fpsCap,
          degradeLevel: quality.degradeLevel,
          degradedToFallback: quality.degradedToFallback,
          perfLimited: quality.perfLimited,
          frameMs: Math.round(medianFrameTime()),
          syncMs: Math.round(medianSyncTime())
        },
        audio: {
          state: audio.ctx ? audio.ctx.state : null,
          sampleRate: audio.sampleRate,
          worklet: !!audio.node,
          mutedGain: audio.mute ? audio.mute.gain.value : null,
          motionMix: audio.mixTarget || null,
          realGain: audio.realGain ? audio.realGain.gain.value : null,
          ambientGain: audio.ambientGain ? audio.ambientGain.gain.value : null
        },
        flash: {
          accepted: flash.history.length,
          rejected: flash.rejected,
          lastSecond: flash.countInLastSecond(),
          maxPerSecond: flash.maxInAnyWindow()
        },
        features: state.lastFeatures,
        lastSample,
        presetCount: catalog.presets.length,
        reducedPresetsAllowed: allowedPresets().length
      };
    },
    sampleNow,
    // Frame-accurate probe: the loop records every rendered frame instead of
    // rendering extra frames from a timer (which aliased a 120 BPM kick).
    startProbe() {
      probeRecorder = [];
      return true;
    },
    stopProbe() {
      const rows = probeRecorder || [];
      probeRecorder = null;
      return rows;
    },
    // e2e hook: let the test drive mood without a server (still used by WS events).
    applyMood,
    noteAgentMood,
    noteAudio,
    agentMotionGate,
    buildAudioLevels,
    agentIdleGraceMs: AGENT_IDLE_GRACE_MS,
    setIntensityUI,
    setOpacityUI,
    setBehaviorUI,
    setMotionUI,
    setMoodReactiveUI,
    setAutoPresetUI,
    setAccentPulseUI,
    applyConfig,
    setEnabledUI,
    // expose internals for assertions
    _state: state,
    _quality: quality,
    _frameTimes: frameTimes,
    _syncTimes: syncTimes,
    _blockers: blockers,
    hardBlocker,
    degradeLadder,
    evaluateDegrade,
    noteRenderError,
    _viz: function () { return viz; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { boot().catch(recordError); }, { once: true });
  } else {
    boot().catch(recordError);
  }
})();
