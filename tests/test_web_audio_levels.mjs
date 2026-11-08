/**
 * Pure-logic test for the PCM -> Butterchurn audio-level bridge (web/aura.js).
 *
 * The overlay backdrop never gets an AudioContext gesture, so the visual is
 * driven by buildAudioLevels() over the PCM ring buffer instead of an
 * AnalyserNode. This test loads the page IIFE in a vm sandbox (no DOM boot)
 * and drives the exported pure buildAudioLevels() hook.
 *
 * Covered:
 *   - silence maps to unsigned 128 everywhere;
 *   - a full-scale sine spans the ~1..255 byte range;
 *   - every array is fftSize (1024) long;
 *   - reducedMotion halves the deviation from silence.
 *
 * Run: node tests/test_web_audio_levels.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'web', 'aura.js'), 'utf8')

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

function freshAura() {
  const sandbox = {
    location: { search: '?token=test-token' },
    URLSearchParams,
    document: {
      readyState: 'loading',
      documentElement: { classList: { add() {} } },
      body: { classList: { add() {} } },
      addEventListener() {},
      getElementById() { return null }
    },
    window: {
      addEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {} })
    },
    performance: { now: () => 0 },
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => { throw new Error('fetch is not expected in this test') },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {}
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'web/aura.js' })
  const aura = sandbox.window.__aura
  assert.ok(aura, 'window.__aura test hook missing')
  assert.equal(typeof aura.buildAudioLevels, 'function', 'buildAudioLevels hook missing')
  return aura
}

function sine(n, amplitude) {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * i) / 64)
  return out
}

function deviation(levels) {
  let max = 0
  for (const v of levels.timeByteArray) max = Math.max(max, Math.abs(v - 128))
  return max
}

record('silence maps to 128 (unsigned zero) in every channel', () => {
  const aura = freshAura()
  const levels = aura.buildAudioLevels(new Float32Array(1024))
  assert.equal(levels.timeByteArray.length, 1024)
  assert.equal(levels.timeByteArrayL.length, 1024)
  assert.equal(levels.timeByteArrayR.length, 1024)
  for (const v of levels.timeByteArray) assert.equal(v, 128)
  for (const v of levels.timeByteArrayL) assert.equal(v, 128)
  for (const v of levels.timeByteArrayR) assert.equal(v, 128)
})

record('full-scale sine spans the unsigned byte range', () => {
  const aura = freshAura()
  const levels = aura.buildAudioLevels(sine(1024, 1))
  let min = 255
  let max = 0
  for (const v of levels.timeByteArray) {
    min = Math.min(min, v)
    max = Math.max(max, v)
  }
  assert.ok(min <= 2, `expected a near-zero byte, got min=${min}`)
  assert.ok(max >= 254, `expected a near-255 byte, got max=${max}`)
})

record('all returned arrays are fftSize (1024) long', () => {
  const aura = freshAura()
  const levels = aura.buildAudioLevels(sine(600, 0.8))
  assert.equal(levels.timeByteArray.length, 1024)
  assert.equal(levels.timeByteArrayL.length, 1024)
  assert.equal(levels.timeByteArrayR.length, 1024)
})

record('reducedMotion halves the deviation from silence', () => {
  const aura = freshAura()
  const normal = deviation(aura.buildAudioLevels(sine(1024, 1)))
  aura._state.reducedMotion = true
  const reduced = deviation(aura.buildAudioLevels(sine(1024, 1)))
  const ratio = reduced / normal
  assert.ok(Math.abs(ratio - 0.5) < 0.02, `expected ~0.5x deviation, got ${ratio.toFixed(3)} (${normal} -> ${reduced})`)
})

console.log(results.join('\n'))
console.log(`\n${results.length - failed} passed, ${failed} failed`)

if (failed > 0) process.exitCode = 1
