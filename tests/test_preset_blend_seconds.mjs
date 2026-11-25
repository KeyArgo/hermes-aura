/**
 * Regression test for preset crossfades that never finished.
 *
 * Profiles and the CONTRACT.md §5 "preset" message carry the blend in
 * milliseconds (balanced = 1200), but Butterchurn's loadPreset() measures
 * blendDuration in seconds of renderer time: calcTimeAndFPS() advances
 * renderer time by 1/fps per frame and blendProgress is
 * (time - blendStartTime) / blendDuration. A 1200 handed straight to the
 * renderer is a 20-minute crossfade with both presets mixed the whole way, and
 * a page that has already recorded the new preset name so name checks pass.
 *
 * loadPresetByName() is lifted out of web/aura.js and run against a stub
 * visualizer that records what the renderer receives. The renderer's own clock
 * is read out of vendor/butterchurn.min.js, so the "seconds" assumption is the
 * vendored one and not an assumption of this test.
 *
 * Run: node tests/test_preset_blend_seconds.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'web', 'aura.js'), 'utf8')
const VENDOR = fs.readFileSync(path.join(ROOT, 'web', 'vendor', 'butterchurn.min.js'), 'utf8')

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

/** One function body out of aura.js, balanced on braces. */
function extract(name) {
  const start = SOURCE.indexOf('function ' + name + '(')
  assert.ok(start >= 0, `aura.js: function ${name}() not found`)
  let depth = 0
  for (let i = SOURCE.indexOf('{', start); i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1
    else if (SOURCE[i] === '}') {
      depth -= 1
      if (depth === 0) return SOURCE.slice(start, i + 1)
    }
  }
  throw new Error(`aura.js: unbalanced body for ${name}`)
}

const NAME = 'regression preset'

/** loadPresetByName() with a visualizer that keeps every blend it is given. */
function harness(profile) {
  const body = extract('loadPresetByName')
  const calls = []
  const state = {
    reducedMotion: false, autoPreset: true, presetName: null,
    presetFamily: null, presetStrobe: false, presetAnchor: null
  }
  const catalog = {
    presets: [{ name: NAME, family: 'organic', strobe: false }],
    byName: { [NAME]: { name: NAME, family: 'organic', strobe: false } },
    default: NAME
  }
  const viz = { loadPreset(preset, blend) { calls.push(blend) } }
  const presetMap = () => ({ [NAME]: { name: NAME } })
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d)
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  const recordError = () => {}
  const api = new Function('state', 'catalog', 'activeProfile', 'viz', 'presetMap',
    'num', 'clamp', 'recordError',
    body + '\nreturn { loadPresetByName };'
  )(state, catalog, () => profile, viz, presetMap, num, clamp, recordError)
  return { api, calls, state }
}

// ------------------------------------------------------- the renderer's clock

/** The two lines of the vendored renderer that decide what blendDuration means. */
function vendorClock() {
  const advance = /this\.time\+=1\/this\.fps/.test(VENDOR)
  const progress = /this\.blendProgress=\(this\.time-this\.blendStartTime\)\/this\.blendDuration/
    .test(VENDOR)
  assert.ok(advance && progress,
    'butterchurn.min.js no longer advances renderer time in seconds; re-derive the unit')
}

/** Rendered seconds until blendProgress reaches 1, at the renderer's own fps. */
function secondsToComplete(blendDuration, fps = 60) {
  let time = 0
  let frames = 0
  const blendStartTime = 0
  while ((time - blendStartTime) / blendDuration < 1) {
    time += 1 / fps
    frames += 1
    if (frames > 1e7) break
  }
  return { seconds: time, frames }
}

// ------------------------------------------------------------------ tests

record('the vendored renderer measures the blend in seconds of its own time', () => {
  vendorClock()
})

record('a profile 1200 ms blend reaches the renderer as 1.2', () => {
  const { api, calls } = harness({ blend_ms: 1200 })
  assert.equal(api.loadPresetByName(NAME), true, 'the preset was refused')
  assert.deepEqual(calls, [1.2],
    `the renderer was given ${JSON.stringify(calls)} for a 1200 ms blend`)
})

record('an explicit 1200 ms blend reaches the renderer as 1.2', () => {
  const { api, calls } = harness({ blend_ms: 2400 })
  assert.equal(api.loadPresetByName(NAME, 1200), true, 'the preset was refused')
  assert.deepEqual(calls, [1.2],
    `the renderer was given ${JSON.stringify(calls)} for a 1200 ms blend`)
})

record('the crossfade completes after about 1.2 seconds of rendered time', () => {
  const { api, calls } = harness({ blend_ms: 1200 })
  api.loadPresetByName(NAME, 1200)
  const blend = calls[0]
  const done = secondsToComplete(blend)
  assert.ok(done.seconds >= 1.15 && done.seconds <= 1.3,
    `the blend took ${done.seconds} s of renderer time, not 1.2 s`)
  // The bug's shape: the raw milliseconds, read as seconds, is ~20 minutes.
  assert.ok(done.seconds < 10,
    `the blend took ${done.seconds} s of renderer time — the value is still unsaturated`)
})

record('a mood-speed 600 ms blend reaches the renderer as 0.6', () => {
  const { api, calls } = harness({ blend_ms: 1200 })
  api.loadPresetByName(NAME, 600)
  assert.deepEqual(calls, [0.6])
  assert.ok(secondsToComplete(calls[0]).seconds <= 0.65,
    'the attention blend still outlives its ~1 s check window')
})

record('no blend still means an instant switch', () => {
  const { api, calls } = harness({ blend_ms: 1200 })
  api.loadPresetByName(NAME, 0)
  assert.deepEqual(calls, [0])
})

record('the 8000 ms ceiling is still a ceiling', () => {
  const { api, calls } = harness({ blend_ms: 1200 })
  api.loadPresetByName(NAME, 60000)
  assert.deepEqual(calls, [8])
})

console.log(results.join('\n'))
if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log(`\n${results.length} passed`)
