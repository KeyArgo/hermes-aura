/**
 * Pure-logic test for the web agent-motion gate (web/aura.js).
 *
 * The page is a browser IIFE, so this loads it in a vm sandbox with a fake
 * clock and no DOM boot (document.readyState stays "loading"). It drives the
 * same __aura hooks the e2e suite uses: applyMood()/noteAgentMood()/
 * setMotionUI() and the exported pure agentMotionGate().
 *
 * Covered:
 *   - idle -> thinking resumes the visual;
 *   - thinking -> idle pauses only after AGENT_IDLE_GRACE_MS;
 *   - a new active mood cancels the pending pause;
 *   - agent_music with music playing never pauses;
 *   - moodReactive=false does not freeze the raw-mood activity gate.
 *
 * Run: node tests/test_web_motion.mjs
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

function makeClock() {
  const clock = { t: 0 }
  const timers = []
  let nextId = 1
  const setTimeoutFake = (fn, ms) => {
    const timer = { id: nextId++, at: clock.t + Math.max(0, Number(ms) || 0), fn, cancelled: false, done: false }
    timers.push(timer)
    return timer.id
  }
  const clearTimeoutFake = id => {
    const timer = timers.find(entry => entry.id === id)
    if (timer) timer.cancelled = true
  }
  const advance = ms => {
    clock.t += ms
    let ran = true
    while (ran) {
      ran = false
      for (const timer of timers) {
        if (timer.done || timer.cancelled) continue
        if (timer.at <= clock.t) {
          timer.done = true
          timer.fn()
          ran = true
        }
      }
    }
  }
  return { clock, advance, setTimeoutFake, clearTimeoutFake }
}

function freshAura() {
  const time = makeClock()
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
    performance: { now: () => time.clock.t },
    console,
    setTimeout: time.setTimeoutFake,
    clearTimeout: time.clearTimeoutFake,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => { throw new Error('fetch is not expected in this test') },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {}
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'web/aura.js' })
  const aura = sandbox.window.__aura
  assert.ok(aura, 'window.__aura test hook missing')
  return { aura, time }
}

record('agent idle grace is 2500 ms and the pure gate matches the contract', () => {
  const { aura } = freshAura()
  const check = (args, expected) => {
    const actual = JSON.parse(JSON.stringify(aura.agentMotionGate(...args)))
    assert.deepEqual(actual, expected)
  }
  assert.equal(aura.agentIdleGraceMs, 2500)
  check(['agent', true, false], { ambient: true, real: false, pause: false })
  check(['agent', false, true], { ambient: false, real: false, pause: true })
  check(['agent_music', false, true], { ambient: false, real: true, pause: false })
  check(['agent_music', true, false], { ambient: true, real: false, pause: false })
  check(['agent_music', true, true], { ambient: false, real: true, pause: false })
  check(['agent_music', false, false], { ambient: false, real: false, pause: true })
  assert.equal(aura.agentMotionGate('both', false, false), null)
  assert.equal(aura.agentMotionGate('music', true, true), null)
})

record('idle -> thinking resumes the visual immediately', () => {
  const { aura, time } = freshAura()
  aura.setMotionUI('agent')
  aura.applyMood('idle', 0, 0)
  time.advance(2500)
  assert.equal(aura._state.renderPaused, true, 'idle agent did not pause after grace')
  aura.applyMood('thinking', 0.7, 0)
  assert.equal(aura._state.agentActive, true)
  assert.equal(aura._state.renderPaused, false, 'thinking did not resume the visual')
})

record('thinking -> idle pauses only after the 2500 ms grace', () => {
  const { aura, time } = freshAura()
  aura.setMotionUI('agent')
  aura.applyMood('thinking', 0.7, 0)
  assert.equal(aura._state.renderPaused, false)
  aura.applyMood('idle', 0, 0)
  time.advance(2499)
  assert.equal(aura._state.renderPaused, false, 'paused before the grace elapsed')
  time.advance(1)
  assert.equal(aura._state.renderPaused, true, 'did not pause after the grace')
})

record('a new active mood cancels the pending pause', () => {
  const { aura, time } = freshAura()
  aura.setMotionUI('agent')
  aura.applyMood('thinking', 0.7, 0)
  aura.applyMood('idle', 0, 0)
  time.advance(1000)
  aura.applyMood('tool', 0.6, 0)
  time.advance(2000)
  assert.equal(aura._state.renderPaused, false, 'the old idle timer paused the visual mid-tool')
})

record('agent_music with music playing never pauses', () => {
  const { aura, time } = freshAura()
  aura.setMotionUI('agent_music')
  aura.applyMood('idle', 0, 0)
  for (let i = 0; i < 8; i += 1) {
    time.advance(500)
    aura.noteAudio(false)
  }
  assert.equal(aura._state.renderPaused, false, 'agent_music paused while audio was present')
  assert.equal(aura._state.agentActive, false)
})

record('agent_music pauses only when idle and silent', () => {
  const { aura, time } = freshAura()
  aura.setMotionUI('agent_music')
  aura.applyMood('idle', 0, 0)
  time.advance(5000) // no audio ever arrived: silent
  assert.equal(aura._state.renderPaused, true, 'idle + silent agent_music did not pause')
})

record('agent mode ignores music-only audio', () => {
  const { aura, time } = freshAura()
  aura.setMotionUI('agent')
  aura.applyMood('idle', 0, 0)
  time.advance(2500)
  assert.equal(aura._state.renderPaused, true)
  aura.noteAudio(false)
  assert.equal(aura._state.renderPaused, true, 'plain agent mode woke on music while the agent was idle')
})

record('moodReactive=false does not freeze the raw agent gate', () => {
  const { aura } = freshAura()
  aura.setMotionUI('agent')
  aura.setMoodReactiveUI(false)
  aura.applyMood('thinking', 0.7, 0)
  assert.equal(aura._state.agentActive, true, 'raw agent activity was lost with mood colours off')
  assert.equal(aura._state.renderPaused, false, 'agent mode stayed frozen with mood colours off')
  assert.equal(aura.snapshot().mood, 'idle', 'mood visuals should still be forced to idle')
  aura.setMoodReactiveUI(true)
})

console.log(results.join('\n'))
console.log(`\n${results.length - failed} passed, ${failed} failed`)

if (failed > 0) process.exitCode = 1
