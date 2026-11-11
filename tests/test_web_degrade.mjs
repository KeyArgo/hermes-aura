/**
 * Regression test for the backdrop freeze: a missed frame budget must degrade
 * the renderer (lower resolution / frame rate) but must NEVER become a hard
 * blocker that stops the render loop. A hard blocker hides the canvas; in the
 * click-through overlay that is the whole backdrop going black.
 *
 * Also covers recovery: when frames get cheap again the quality ladder steps
 * back up and the soft `perf` notice is cleared.
 *
 * Run: node tests/test_web_degrade.mjs
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
  assert.equal(typeof aura.evaluateDegrade, 'function', 'evaluateDegrade hook missing')
  assert.equal(typeof aura.degradeLadder, 'function', 'degradeLadder hook missing')
  assert.equal(typeof aura.hardBlocker, 'function', 'hardBlocker hook missing')
  return aura
}

function seed(aura, frameMs, syncMs) {
  aura._frameTimes.length = 0
  aura._syncTimes.length = 0
  for (let i = 0; i < 120; i += 1) aura._frameTimes.push(frameMs)
  for (let i = 0; i < 10; i += 1) aura._syncTimes.push(syncMs)
}

record('perf is a soft notice, never a hard blocker', () => {
  const aura = freshAura()
  assert.equal(aura.hardBlocker(), null)
  aura._blockers.set('perf', 'Rendering is slow — keeping a reduced frame rate.')
  assert.equal(aura.hardBlocker(), null, 'perf must not be in HARD_BLOCKERS')
  const snap = aura.snapshot()
  assert.equal(snap.fallbackActive, false, 'a slow GPU must keep the canvas visible')
  assert.ok(snap.fallbackReasons.includes('perf'), 'the soft notice should still be reported')
})

record('a missed budget at the floor degrades softly and keeps drawing', () => {
  const aura = freshAura()
  aura._quality.software = true
  const ladder = aura.degradeLadder()
  const floor = ladder[ladder.length - 1]
  aura._quality.degradeLevel = ladder.length - 1
  aura._quality.renderScale = floor.scale
  aura._quality.fpsCap = floor.fps
  seed(aura, 300, 300) // 300 ms frames: far past every budget
  aura.evaluateDegrade()
  assert.equal(aura._quality.perfLimited, true, 'perf-limited flag should be set')
  assert.equal(aura._quality.degradedToFallback, true)
  assert.equal(aura.hardBlocker(), null, 'the loop must not be stopped')
  assert.ok(aura._blockers.has('perf'), 'the soft notice should be present')
  assert.ok(aura._quality.fpsCap > 0, 'there must still be a frame budget')
  assert.equal(aura._quality.degradeLevel, ladder.length - 1, 'already at the floor')
  const snap = aura.snapshot()
  assert.equal(snap.fallbackActive, false)
  assert.equal(snap.quality.perfLimited, true)
})

record('cheap frames recover quality and clear the perf notice', () => {
  const aura = freshAura()
  aura._quality.software = true
  const ladder = aura.degradeLadder()
  aura._quality.degradeLevel = ladder.length - 1
  aura._quality.renderScale = ladder[ladder.length - 1].scale
  aura._quality.fpsCap = ladder[ladder.length - 1].fps
  aura._quality.perfLimited = true
  aura._quality.degradedToFallback = true
  aura._blockers.set('perf', 'Rendering is slow — keeping a reduced frame rate.')
  seed(aura, 4, 4)
  for (let i = 0; i < 6; i += 1) aura.evaluateDegrade()
  assert.ok(aura._quality.degradeLevel < ladder.length - 1, 'quality should step back up')
  assert.equal(aura._quality.perfLimited, false, 'perf-limited flag should clear')
  assert.equal(aura._blockers.has('perf'), false, 'the soft notice should clear')
  assert.equal(aura.hardBlocker(), null)
})

record('software ladder goes deep enough to keep SwiftShader moving', () => {
  const aura = freshAura()
  aura._quality.software = true
  const ladder = aura.degradeLadder()
  assert.ok(ladder.length >= 4, 'software needs more than three steps')
  assert.ok(ladder[ladder.length - 1].scale <= 0.15, 'the floor should shrink the buffer')
  assert.ok(ladder[ladder.length - 1].fps <= 8, 'the floor should allow a slow cadence')
})

record('a throwing frame never becomes a permanent graphics failure', () => {
  const aura = freshAura()
  aura.noteRenderError(new Error('preset exploded'))
  assert.equal(aura.hardBlocker(), null, 'one bad frame must not stop the loop')
  assert.equal(aura.snapshot().fallbackActive, false)
  assert.ok(aura._state.errors.length >= 1, 'the first error is still reported')
  for (let i = 0; i < 25; i += 1) aura.noteRenderError(new Error('still exploding'))
  assert.equal(aura.hardBlocker(), null, 'a streak must not block webgl either')
  assert.ok(aura._state.errors.length <= 4, 'error recording stays bounded')
})

console.log(results.join('\n'))
if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log(`\n${results.length} passed`)
