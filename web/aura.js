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

  const MOODS = ['idle', 'thinking', 'tool', 'approval', 'error', 'streaming', 'done'];
  const ATTENTION = ['approval', 'error'];
  const HARD_BLOCKERS = ['token', 'webgl', 'capture', 'audio', 'perf'];
  const FLASH_WINDOW_MS = 1000;
  const FLASH_MAX_PER_WINDOW = 3;
  const ATTENTION_PULSE_MS = 1000;   // 1 Hz — contract caps attention at 2 Hz
  const DONE_SETTLE_MS = 1500;       // contract: done settles for ≤1.5 s

  const state = {
    ready: false,
    errors: [],
    enabled: true,
    capture: 'unknown',
    reducedMotion: false,
    userIntensity: 0.6,
    effectiveIntensity: 0.6,
    sampleGain: 1.0,
    presetName: null,
    presetFamily: null,
    presetStrobe: false,
    frames: 0,
    badFrames: 0,
    droppedFrames: 0,
    lastSeq: 0,
    lastFeatures: null,
    canvas: { w: 0, h: 0, cssW: 0, cssH: 0 }
  };

  const quality = {
    tier: 'unknown',
    renderer: 'unknown',
    software: false,
    renderScale: 1,
    fpsCap: 60,
    degradeLevel: 0,
    degradedToFallback: false
  };

  const blockers = new Map(); // reason -> one-line message
  const frameTimes = [];
  const syncTimes = []; // render()+1px readPixels samples: real GPU-inclusive frame cost
  const syncProbe = new Uint8Array(4);

  const dom = {};
  const audio = { ctx: null, node: null, mute: null, sampleRate: 0 };
  const socket = { ws: null, state: 'boot', attempt: 0, timer: null };
  let viz = null;
  let catalog = { presets: [], byName: Object.create(null), default: null };
  let resizeQueued = false;
  let rafId = null;
  let lastRenderAt = 0;
  let lastSample = null;
  let draggingIntensity = false;

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

  async function getJson(path, opts) {
    const headers = Object.assign({ Accept: 'application/json' }, (opts && opts.headers) || {});
    if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
    try {
      const res = await fetch(path, Object.assign({}, opts, { headers }));
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
      const res = await fetch('/api/control', {
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
      dom.canvas.style.opacity = state.enabled ? '1' : '0.35';
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
  // bright = CSS brightness lift, tint = red settle, pulse = accent pulse mode.
  const MOOD_MOD = {
    idle:      { gain: 1.00, bright: 0.00, tint: 0.00, pulse: 'none',      floor: 0 },
    thinking:  { gain: 1.30, bright: 0.14, tint: 0.00, pulse: 'breathe',   floor: 0 },
    tool:      { gain: 1.12, bright: 0.04, tint: 0.00, pulse: 'none',      floor: 0 },
    approval:  { gain: 1.15, bright: 0.08, tint: 0.00, pulse: 'attention', floor: 0.6 },
    error:     { gain: 1.00, bright: 0.00, tint: 0.24, pulse: 'attention', floor: 0.6 },
    streaming: { gain: 1.45, bright: 0.10, tint: 0.00, pulse: 'none',      floor: 0 },
    done:      { gain: 0.95, bright: 0.02, tint: 0.00, pulse: 'settle',    floor: 0 }
  };

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

  function stopPulse() {
    if (mood.pulse) { clearInterval(mood.pulse); mood.pulse = null; }
    if (dom.glow) dom.glow.classList.remove('peak');
  }

  function startPulse() {
    stopPulse();
    const mod = moodMod();
    if (!dom.glow) return;
    if (mod.pulse === 'none') return;
    if (state.reducedMotion) {
      // No strobe: a static accent wash instead of a pulsing one.
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
    mood.pulsePeriod = ATTENTION_PULSE_MS; // 1 Hz ≤ 2 Hz cap
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
    if (!state.enabled) name = 'idle';
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
    updateMoodVisuals();
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
    const base = state.enabled ? state.userIntensity : 0;
    let floor = mod.floor || 0;
    if (ATTENTION.includes(mood.current)) {
      // The server's mood intensity is a lower bound for attention moods, and the
      // contract floor of 0.6 always applies.
      floor = Math.max(floor, mood.serverIntensity);
    }
    return clamp(Math.max(base * mod.gain, floor), 0, 1);
  }

  function sampleGain() {
    const intensity = effectiveIntensity();
    let g = 0.2 + 1.8 * intensity;
    if (state.reducedMotion) g *= 0.75;
    return g;
  }

  function updateMoodVisuals() {
    const mod = moodMod();
    state.effectiveIntensity = effectiveIntensity();
    state.sampleGain = sampleGain();

    let bright = 1 + 0.10 * state.effectiveIntensity + mod.bright;
    if (state.reducedMotion) bright = 1 + (bright - 1) * 0.6;
    if (dom.canvas) dom.canvas.style.filter = 'brightness(' + bright.toFixed(2) + ')';

    if (dom.root) {
      dom.root.style.setProperty('--aura-tint', String(mod.tint));
      if (mod.pulse === 'none' || state.reducedMotion) {
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

  function presetMap() {
    try {
      const p = window.butterchurnPresets;
      if (!p) return null;
      return (typeof p.getPresets === 'function' ? p.getPresets() : null);
    } catch (e) {
      recordError(e);
      return null;
    }
  }

  async function loadCatalog() {
    try {
      const res = await fetch('presets.json', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('presets.json ' + res.status);
      const data = await res.json();
      const list = Array.isArray(data.presets) ? data.presets : [];
      catalog.presets = list.filter((p) => p && typeof p.name === 'string')
        .map((p) => ({ name: p.name, family: String(p.family || 'misc'), strobe: !!p.strobe }));
      catalog.byName = Object.create(null);
      for (const p of catalog.presets) catalog.byName[p.name] = p;
      catalog.default = typeof data.default === 'string' ? data.default : null;
    } catch (e) {
      recordError(e);
      // Fall back to the vendored preset pack; no network, still works offline.
      const map = presetMap();
      if (map) {
        catalog.presets = Object.keys(map).sort().slice(0, 20)
          .map((name) => ({ name, family: 'misc', strobe: false }));
        catalog.byName = Object.create(null);
        for (const p of catalog.presets) catalog.byName[p.name] = p;
        catalog.default = catalog.presets[0] ? catalog.presets[0].name : null;
      }
    }
  }

  function allowedPresets() {
    return catalog.presets.filter((p) => !state.reducedMotion || !p.strobe);
  }

  function pickInitialPreset() {
    const allowed = allowedPresets();
    if (!allowed.length) return null;
    if (catalog.default) {
      const d = catalog.byName[catalog.default];
      if (d && (!state.reducedMotion || !d.strobe)) return d.name;
    }
    return allowed[0].name;
  }

  function loadPresetByName(name, blendMs) {
    if (!viz || typeof name !== 'string') return false;
    const map = presetMap();
    if (!map || !map[name]) return false;
    const meta = catalog.byName[name];
    if (state.reducedMotion && meta && meta.strobe) {
      // No strobe presets for reduced-motion users.
      return false;
    }
    try {
      viz.loadPreset(map[name], clamp(num(blendMs, 0), 0, 8000));
      state.presetName = name;
      state.presetFamily = meta ? meta.family : null;
      state.presetStrobe = meta ? meta.strobe : false;
      return true;
    } catch (e) {
      recordError(e);
      return false;
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
    } catch (e) {
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
    } catch (e) {
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
    quality.renderScale = webgl.software ? 0.45 : 1;
    quality.fpsCap = webgl.software ? 24 : 60;
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
    } catch (e) {
      recordError(e);
      viz = null;
      block('webgl', 'The visualizer could not start on this GPU — showing the accent-only fallback.');
      return false;
    }
    const initial = pickInitialPreset();
    if (initial) loadPresetByName(initial, 0);
    if (state.enabled) startLoop();
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
    return quality.software
      ? [{ scale: 0.45, fps: 24 }, { scale: 0.34, fps: 20 }, { scale: 0.26, fps: 16 }]
      : [{ scale: 1, fps: 60 }, { scale: 0.75, fps: 40 }, { scale: 0.55, fps: 30 }, { scale: 0.4, fps: 20 }];
  }

  function evaluateDegrade() {
    // gl.finish() gives the real GPU-inclusive cost; render() alone returns before
    // SwiftShader has drawn, which would hide a missed budget.
    const p50 = Math.max(medianFrameTime(), medianSyncTime());
    if (!p50) return;
    const budget = 1000 / quality.fpsCap;
    if (p50 <= budget * 1.6) return;
    const ladder = degradeLadder();
    const next = Math.min(quality.degradeLevel + 1, ladder.length - 1);
    if (next === quality.degradeLevel) {
      // At the floor and still missing frames: accent-only beats a slideshow.
      if (p50 > 260 && !quality.degradedToFallback) {
        quality.degradedToFallback = true;
        block('perf', 'Rendering is too slow on this GPU — showing the accent-only fallback.');
        if (viz) { try { viz.render(); } catch (_) {} }
      }
      return;
    }
    quality.degradeLevel = next;
    quality.renderScale = ladder[next].scale;
    quality.fpsCap = ladder[next].fps;
    if (state.reducedMotion) quality.fpsCap = Math.min(quality.fpsCap, 30);
    resizeCanvas();
  }

  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    if (!viz || !state.enabled) return;
    if (hardBlocker()) return;
    const interval = 1000 / quality.fpsCap;
    if (ts - lastRenderAt < interval - 1.5) return;
    const t0 = now();
    try {
      viz.render();
    } catch (e) {
      recordError(e);
      block('webgl', 'The visualizer stopped — showing the accent-only fallback.');
      return;
    }
    lastRenderAt = ts;
    state.frames += 1;
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

  function sampleNow() {
    if (!viz || !dom.canvas) return null;
    try { viz.render(); } catch (e) { recordError(e); return null; }
    let gl = null;
    try { gl = dom.canvas.getContext('webgl2'); } catch (e) { gl = null; }
    if (!gl) return null;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    if (!w || !h) return null;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0;
    let lit = 0;
    let hash = 0;
    const stride = 16;
    for (let i = 0; i < buf.length; i += stride) {
      const v = buf[i] + buf[i + 1] + buf[i + 2];
      sum += v;
      if (v > 12) lit += 1;
      hash = (hash * 31 + v) | 0;
    }
    lastSample = {
      mean: Math.round(sum / (buf.length / stride) / 3),
      lit,
      hash,
      w,
      h,
      frames: state.frames,
      mood: mood.current,
      preset: state.presetName,
      intensity: Number(state.effectiveIntensity.toFixed(3)),
      sampleGain: Number(state.sampleGain.toFixed(3))
    };
    return lastSample;
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
    } catch (e) {
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
        block('audio', 'Audio is paused until you click — showing the accent-only fallback.');
        armGestureResume();
      }
    });
    try { await ctx.resume(); } catch (e) { recordError(e); }
    if (ctx.state !== 'running') {
      block('audio', 'Audio is paused until you click — showing the accent-only fallback.');
      armGestureResume();
    }
    return true;
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
    if (!audio.node || !audio.ctx) return;
    if (socket.ws && socket.ws.bufferedAmount > 512 * 1024) {
      // Socket backed up: drop this frame rather than queue latency.
      state.droppedFrames += 1;
      return;
    }
    const gain = sampleGain();
    let samples = frame.samples;
    if (frame.silence) {
      // A silent frame is zeroes, never whatever the capture buffer held.
      samples = new Float32Array(frame.count);
    }
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
    try { ev = JSON.parse(raw); } catch (e) { return; }
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
        updateMoodVisuals();
        break;
      }
      case 'mood':
        applyMood(ev.mood, num(ev.intensity, 0.6), num(ev.ttl_ms, 0));
        break;
      case 'preset':
        loadPresetByName(ev.name, num(ev.blend_ms, 1200));
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
      socket.ws = null;
      setMoodIdle();
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

  // ---------------------------------------------------------------------------
  // config + controls
  // ---------------------------------------------------------------------------

  function applyConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    // `enabled` is the server-side truth: the desktop chip and aura_control turn
    // Aura on through /api/control, and the page must follow that change.
    if (typeof cfg.enabled === 'boolean' && cfg.enabled !== state.enabled) setEnabledUI(cfg.enabled);
    if (typeof cfg.reduced_motion === 'boolean') setReducedMotion(cfg.reduced_motion || FORCE_REDUCED);
    if (typeof cfg.intensity === 'number' && !draggingIntensity) {
      setIntensityUI(clamp(cfg.intensity, 0, 1));
    }
    if (typeof cfg.capture === 'string') applyCapture(cfg.capture);
  }

  function applyCapture(capture) {
    state.capture = capture;
    if (capture === 'none') {
      block('capture', 'No system audio is available on this machine — showing the accent-only fallback.');
      if (viz) stopLoop();
    } else {
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
    if (next && state.presetStrobe) {
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
    if (dom.toggle) {
      dom.toggle.addEventListener('click', () => {
        const next = !state.enabled;
        setEnabledUI(next);
        postControl({ enabled: next });
      });
    }
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
    dom.toggle = document.getElementById('aura-toggle');

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
      if (state.capture === 'none') {
        block('capture', 'No system audio is available on this machine — showing the accent-only fallback.');
      }
    }

    const cfg = await getJson('/api/config');
    if (cfg.ok && cfg.json) applyConfig(cfg.json);

    const st = await getJson('/api/state');
    if (st.ok && st.json) {
      if (typeof st.json.enabled === 'boolean') setEnabledUI(st.json.enabled);
      if (typeof st.json.intensity === 'number') setIntensityUI(clamp(st.json.intensity, 0, 1));
      if (typeof st.json.mood === 'string' && MOODS.includes(st.json.mood) && st.json.mood !== 'idle') {
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
        mood: mood.current,
        previousMood: mood.previous,
        moodTtl: mood.ttl,
        pulsePeriodMs: mood.pulsePeriod,
        intensity: Number(state.effectiveIntensity.toFixed(3)),
        userIntensity: Number(state.userIntensity.toFixed(3)),
        sampleGain: Number(state.sampleGain.toFixed(3)),
        preset: state.presetName,
        presetFamily: state.presetFamily,
        presetStrobe: state.presetStrobe,
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
          syncMs: Math.round(medianSyncTime())
        },
        audio: {
          state: audio.ctx ? audio.ctx.state : null,
          sampleRate: audio.sampleRate,
          worklet: !!audio.node,
          mutedGain: audio.mute ? audio.mute.gain.value : null
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
    // e2e hook: let the test drive mood without a server (still used by WS events).
    applyMood,
    setIntensityUI,
    setEnabledUI,
    // expose internals for assertions
    _state: state,
    _quality: quality,
    _viz: function () { return viz; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { boot().catch(recordError); }, { once: true });
  } else {
    boot().catch(recordError);
  }
})();
