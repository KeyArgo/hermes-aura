/**
 * Static beat-reactivity scorer for the vendored Butterchurn preset bundle.
 *
 * Loads web/vendor/butterchurnPresets.min.js (UMD), calls getPresets(), and
 * scores every preset for BEAT REACTIVITY from its equations text only (no
 * browser): occurrences of bass/bass_att/mid/mid_att/treb/treb_att/beats in the
 * frame/pixel equations, in enabled waves' frame/point equations, and in
 * enabled shapes' equations; plus spectrum taps q1..q31 + beat/beats (the
 * literal spectrum input, used heavily by e.g. mandelbox explorer) and
 * audio-driven wave settings (wave_a amplitude response, samples driven from
 * the spectrum, non-default wave_mode). The
 * bundle's composite shaders are precompiled GLSL and carry no audio
 * identifiers (verified 2026-11-08), so they are not scored for reactivity.
 *
 * Also emits a strobe-risk HINT from equation text (fast time-driven flips of
 * full-screen colour/brightness variables a.ib_r/g/b or brightness multipliers:
 * abs/sign/sin-modulate on time with rate >= 3, or mod() toggles). The hint is
 * advisory only — the catalog's `strobe` field keeps probe semantics
 * (tests/e2e/probe_presets.py: jumpsPerSec >= 0.5 or peakDelta >= 25), because
 * visual strobing mostly lives in the precompiled comp opcodes, not the text.
 *
 * Run:  node tools/score_presets.mjs [path/to/bundle.min.js] [--json out.json]
 * Prints every preset sorted by normalized score, merged with the measured
 * quick/deep probe numbers (coverage, motion, measured strobe) when present.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

export function loadBundle(bundlePath = path.join(ROOT, 'web', 'vendor', 'butterchurnPresets.min.js')) {
  const src = fs.readFileSync(bundlePath, 'utf8')
  const mod = { exports: {} }
  new Function('module', 'exports', 'self', src)(mod, mod.exports, undefined)
  return mod.exports.getPresets()
}

const AUDIO_VARS = ['bass_att', 'bass', 'mid_att', 'mid', 'treb_att', 'treb', 'beats', 'beat']
const AUDIO_BANDS = ['bass', 'mid', 'treb'] // "distinct bands touched" bonus

function audioHits(text) {
  const count = {}
  let total = 0
  for (const v of AUDIO_VARS) {
    const re = new RegExp(`(?<![A-Za-z0-9_])${v}(?![A-Za-z0-9_])`, 'g')
    const n = ((text || '').match(re) || []).length
    if (n) {
      count[v] = n
      total += n
    }
  }
  return { count, distinct: Object.keys(count).length, total }
}

// 0 when absent; saturating in distinct vars touched and total occurrences.
function ctxScore(hits) {
  if (!hits.distinct) return 0
  return 0.6 * hits.distinct + 0.4 * Math.log2(1 + hits.total)
}

const FAST_TOGGLE = /a\.(?:ib_[rgb]|[a-z0-9_]*bright[a-z0-9_]*|[a-z0-9_]*colr_mult[a-z0-9_]*|[a-z0-9_]*(?:color|col)[a-z0-9_]*mult[a-z0-9_]*)=(?:[^;]*)/g

function strobeText(eqs) {
  const evidence = []
  let risk = 0
  for (const text of eqs) {
    if (!text) continue
    const toggles = text.match(FAST_TOGGLE) || []
    for (const stmt of toggles) {
      const freq = [...stmt.matchAll(/(\d*\.?\d+)\s*\*\s*(?:a\.)?time|(?:a\.)?time\s*\*\s*(\d*\.?\d+)/g)]
        .map(m => Number(m[1] || m[2]))
        .filter(n => n > 0)
      const square = /Math\.abs\(|Math\.sign\(|\bmod\(/.test(stmt)
      const fast = freq.some(f => f >= 3)
      if (square && (fast || freq.length === 0)) {
        risk += fast ? 1 : 0.5
        evidence.push(stmt.slice(0, 72))
      }
    }
  }
  return { risk: Math.min(risk, 4), evidence: evidence.slice(0, 2) }
}

export function scorePreset(preset) {
  const p = preset || {}
  const enabled = arr => (arr || []).filter(w => w && w.baseVals && w.baseVals.enabled)
  const waves = enabled(p.waves)
  const shapes = enabled(p.shapes)

  const parts = { frame: 0, pixel: 0, waves: 0, shapes: 0 }
  const allText = [p.frame_eqs_str, p.pixel_eqs_str]
  parts.frame = ctxScore(audioHits(p.frame_eqs_str)) * 1.0
  parts.pixel = ctxScore(audioHits(p.pixel_eqs_str)) * 0.6
  for (const w of waves) {
    parts.waves += ctxScore(audioHits(w.frame_eqs_str)) * 0.45
    parts.waves += ctxScore(audioHits(w.point_eqs_str)) * 0.45
    allText.push(w.frame_eqs_str, w.point_eqs_str)
  }
  for (const s of shapes) {
    parts.shapes += ctxScore(audioHits(s.frame_eqs_str)) * 0.45
    allText.push(s.frame_eqs_str)
  }

  const joined = allText.filter(Boolean).join(';')
  const overall = audioHits(joined)
  const bands = AUDIO_BANDS.filter(b => overall.count[b] || overall.count[`${b}_att`]).length
  const bandsBonus = 0.5 * overall.distinct + 0.25 * bands
  const qTaps = [...new Set((joined.match(/(?<![A-Za-z0-9_])q(?:3[01]|[12]\d|[1-9])(?![A-Za-z0-9_])/g) || []))]
  const qTotal = (joined.match(/(?<![A-Za-z0-9_])q(?:3[01]|[12]\d|[1-9])(?![A-Za-z0-9_])/g) || []).length
  const spectrumBonus = qTaps.length ? 0.3 * Math.min(qTaps.length, 8) + 0.15 * Math.log2(1 + qTotal) : 0

  // Audio-driven wave behaviour: amplitude response, spectrum samples, mode.
  let waveDrive = 0
  for (const w of waves) {
    const b = w.baseVals
    if (Number(b.a) > 0) waveDrive += 0.4
    if (Number(b.samples) > 0 && Number(b.samples) <= 32) waveDrive += 0.35
    if (Number(b.spectrum) > 0) waveDrive += 0.1
  }
  waveDrive = Math.min(waveDrive, 2.0)
  const shapeDrive = Math.min(shapes.length * 0.25, 0.75)

  const raw = parts.frame + parts.pixel + parts.waves + parts.shapes + bandsBonus + waveDrive + shapeDrive + spectrumBonus
  const strobe = strobeText([p.frame_eqs_str, p.pixel_eqs_str, ...waves.map(w => w.frame_eqs_str), ...shapes.map(s => s.frame_eqs_str)])
  return {
    raw: +raw.toFixed(3),
    bands: overall.distinct,
    qTaps: qTaps.length,
    waves: waves.length,
    shapes: shapes.length,
    waveDrive: +waveDrive.toFixed(2),
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, +v.toFixed(2)])),
    strobeRisk: strobe.risk, // hint only; catalog strobe stays measured
    strobeEvidence: strobe.evidence
  }
}

function loadMeasured() {
  const merge = new Map()
  for (const f of ['quick_results.json', 'deep_results.json']) {
    const file = path.join(ROOT, 'tests', 'e2e', f)
    if (!fs.existsSync(file)) continue
    for (const r of JSON.parse(fs.readFileSync(file, 'utf8'))) merge.set(r.preset, { ...(merge.get(r.preset) || {}), ...r })
  }
  return merge
}

export function scoreAll(bundlePath) {
  const P = loadBundle(bundlePath)
  const measured = loadMeasured()
  const scored = Object.keys(P).map(name => {
    const s = scorePreset(P[name])
    const m = measured.get(name)
    return { name, ...s, coverage: m ? m.coverage : null, motion: m ? m.motion : null, strobeMeasured: m ? m.strobe : null }
  })
  const max = Math.max(...scored.map(s => s.raw)) || 1
  for (const s of scored) s.score = +(s.raw / max).toFixed(4)
  scored.sort((a, b) => b.score - a.score || (b.motion || 0) - (a.motion || 0) || a.name.localeCompare(b.name))
  return scored
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const jsonAt = process.argv.indexOf('--json')
  const bundleArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined
  const rows = scoreAll(bundleArg)
  if (jsonAt >= 0 && process.argv[jsonAt + 1]) fs.writeFileSync(process.argv[jsonAt + 1], JSON.stringify(rows, null, 1))
  const pad = (v, n) => String(v ?? '').padStart(n)
  console.log('score   raw  bands qt  wv sh waveD  cov   motion STR(measured) [risk] name')
  for (const r of rows) {
    console.log(
      `${pad(r.score, 6)} ${pad(r.raw, 5)} ${pad(r.bands, 4)} ${pad(r.qTaps, 3)} ${pad(r.waves, 3)} ${pad(r.shapes, 2)} ${pad(r.waveDrive, 5)} ` +
      `${pad(r.coverage, 6)} ${pad(r.motion, 6)} ${r.strobeMeasured ? '  YES' : '   no'} ` +
      `${r.strobeRisk >= 1 ? `[r${r.strobeRisk}]` : '      '} ${r.name}`
    )
  }
  console.log(`\n${rows.length} presets scored (max raw ${rows[0].raw})`)
}
