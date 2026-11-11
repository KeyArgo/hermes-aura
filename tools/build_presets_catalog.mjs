#!/usr/bin/env node
/**
 * Build web/presets.json from the static score + headless probe results.
 *
 * Keeps the existing curated entries, then adds candidates that:
 *   - are not already in the catalog;
 *   - did not fail to compile/load and are not black/near-static;
 *   - have a static reactivity score > 0;
 *   - keep a large non-strobe pool for reduced motion.
 *
 * Strobe is only set for a clear measured full-screen flash (peakDelta >= 25),
 * except for the existing deep-probed entries whose flags are kept.
 *
 * Usage: node tools/build_presets_catalog.mjs [scored.json] [all_results.json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCORED = process.argv[2] || '/tmp/scored.json'
const PROBED = process.argv[3] || path.join(ROOT, 'tests', 'e2e', 'all_results.json')
const TARGET_TOTAL = 140
const MIN_NONSTROBE_ADD = 35
const FAMILIES = ['organic', 'liquid', 'geometric', 'fractal', 'cosmic', 'energy']

const catalogPath = path.join(ROOT, 'web', 'presets.json')
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
const scored = JSON.parse(fs.readFileSync(SCORED, 'utf8'))
const probed = JSON.parse(fs.readFileSync(PROBED, 'utf8'))
const measured = new Map(probed.map(r => [r.preset, r]))
const existing = new Set(catalog.presets.map(p => p.name))

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)) }

function familyFor(name, m, raw) {
  const n = name.toLowerCase()
  const has = (...words) => words.some(w => n.includes(w))
  if (has('fractal', 'mandel', 'julia', 'spiral', 'artifact', 'recursive', 'ifs', 'mandelbox', 'mandelbulb')) return 'fractal'
  if (has('cosmic', 'nebula', 'star', 'galaxy', 'wormhole', 'space', 'universe', 'void', 'singular', 'magellan', 'aurora', 'planet', 'moon', 'eclipse', 'infinity', 'astral', 'temporal', 'cosmos')) return 'cosmic'
  if (has('liquid', 'water', 'sea', 'ocean', 'river', 'wave', 'tide', 'paint', 'spill', 'flow', 'fluid', 'ripple', 'pond', 'fish', 'bubble', 'smoke', 'fog', 'cloud', 'oil', 'ink', 'plasma', 'lava', 'storm', 'turbulence', 'surface', 'pearl', 'jelly', 'blob', 'goo', 'milk', 'splash', 'rain', 'melt')) return 'liquid'
  if (has('organic', 'flower', 'moss', 'garden', 'tree', 'leaf', 'bloom', 'nature', 'butterfly', 'bird', 'fungus', 'cell', 'bacteria', 'vine', 'root', 'seed', 'jungle', 'forest', 'insect', 'worm', 'coral', 'witchcraft', 'bombyx')) return 'organic'
  if (has('energy', 'glow', 'glowstick', 'neon', 'beat', 'mashup', 'pulse', 'flash', 'electric', 'lightning', 'firework', 'spark', 'laser', 'rave', 'party', 'dance', 'acid', 'reactive', 'illumination', 'solar', 'proton', 'atomic', 'nuclear', 'explosion')) return 'energy'
  if (has('geometric', 'matrix', 'vector', 'cross', 'grid', 'square', 'cube', 'crystal', 'tile', 'glass', 'skylight', 'corridor', 'architecture', 'circuit', 'hex', 'polygon', 'kaleid', 'caleid', 'mosaic', 'morgana', 'shape', 'shader', 'tunnel', 'portal')) return 'geometric'
  const cov = m.coverage ?? 0
  const motion = m.motion ?? 0
  const hue = m.hueEnt ?? 0
  if (motion > 8 && cov > 0.6) return 'energy'
  if (hue > 2.2) return 'cosmic'
  if (cov < 0.4) return 'geometric'
  if (motion < 1.5) return 'organic'
  return 'liquid'
}

function beatFor(raw) {
  return clamp(Math.round((raw - 2) / 3), 0, 5)
}

function strobeFor(m, raw) {
  // Fast screen has only two samples; only trust a clear full-screen flash.
  return (m.peakDelta ?? 0) >= 25
}

function scoreOf(r) {
  return r.raw ?? r.score ?? 0
}

const candidates = []
for (const r of scored) {
  if (existing.has(r.name)) continue
  const m = measured.get(r.name)
  if (!m || m.compileFailed || m.error) continue
  if ((m.coverage ?? 0) < 0.08) continue
  if ((m.coverage ?? 0) < 0.05 && (m.motion ?? 0) < 0.10) continue
  const raw = scoreOf(r)
  if (!(raw > 0)) continue
  candidates.push({ name: r.name, raw, m })
}
candidates.sort((a, b) => b.raw - a.raw)

const nonStrobe = candidates.filter(c => !strobeFor(c.m, c.raw))
const strobe = candidates.filter(c => strobeFor(c.m, c.raw))
const picked = []
const pickedNames = new Set()
function take(list, count) {
  for (const c of list) {
    if (picked.length >= TARGET_TOTAL - catalog.presets.length) return
    if (count <= 0) return
    if (pickedNames.has(c.name)) continue
    picked.push(c)
    pickedNames.add(c.name)
    count -= 1
  }
}

// Guarantee a large calm pool first, then fill with the strongest reactive ones.
take(nonStrobe, MIN_NONSTROBE_ADD)
take(strobe, TARGET_TOTAL - catalog.presets.length - picked.length)
if (catalog.presets.length + picked.length < TARGET_TOTAL) {
  take(candidates.filter(c => !pickedNames.has(c.name)), TARGET_TOTAL - catalog.presets.length - picked.length)
}

// Balance any family that would otherwise be thin.
const counts = new Map(FAMILIES.map(f => [f, catalog.presets.filter(p => p.family === f).length]))
for (const c of picked) {
  const f = familyFor(c.name, c.m, c.raw)
  c.family = f
  counts.set(f, (counts.get(f) || 0) + 1)
}
for (const f of FAMILIES) {
  if ((counts.get(f) || 0) >= 8) continue
  for (const c of picked) {
    if (c.family === f) continue
    if (counts.get(c.family) <= 9) continue
    counts.set(c.family, counts.get(c.family) - 1)
    c.family = f
    counts.set(f, counts.get(f) + 1)
    if (counts.get(f) >= 8) break
  }
}

const additions = picked.map(c => ({
  name: c.name,
  family: c.family,
  strobe: strobeFor(c.m, c.raw),
  beat: beatFor(c.raw),
}))

const presets = catalog.presets.concat(additions)
const calm = presets.filter(p => !p.strobe).length
const familyCounts = Object.fromEntries(FAMILIES.map(f => [f, presets.filter(p => p.family === f).length]))
const note = [
  'Curated for beat reactivity and visual density across the vendored butterchurn-presets@2.4.7 packs',
  '(base + Extra + Extra2 + MD1). Existing entries were measured in muted headless Chrome with',
  'tests/e2e/probe_presets.py; the 2026-11-08 expansion was ranked by static reactivity from',
  'tools/score_presets.mjs and screened with tools/probe_all_presets.py for compile failures, black',
  'frames and near-static output. strobe=true is conservative and measured: luma-grid jumps >=12/255',
  'at >=0.5/s, or >=25/255 peak delta; reduced-motion users only ever see strobe=false presets.',
  'Families steer the mood engine in aura.js: idle=organic/liquid calm, thinking=geometric/fractal',
  'structure, approval=cosmic contrast, error=liquid wash under the red tint, streaming=energy.',
].join(' ')

const out = {
  schema: catalog.schema,
  note,
  default: catalog.default,
  presets,
}
fs.writeFileSync(catalogPath, JSON.stringify(out, null, 2) + '\n')

console.log('catalog entries: %d (+%d), non-strobe: %d', presets.length, additions.length, calm)
console.log('families:', familyCounts)
console.log('picked:', additions.length, 'candidates:', candidates.length)
