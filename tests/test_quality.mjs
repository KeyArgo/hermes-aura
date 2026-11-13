/**
 * Quality rules for Aura's film player (web/quality.js) plus the page wiring.
 *
 * What this proves and what it does NOT:
 *
 *   - it runs the shipped rules as written (the same file web/player.html
 *     loads), so the picker's answers cannot drift from the page's behaviour;
 *   - it proves a source swap keeps the position and the play state, which is
 *     the whole point of a quality switch mid-film;
 *   - it proves YouTube's one honest answer is "Auto (YouTube decides)" and
 *     that nothing in the page pretends to force a level (no `vq`, no
 *     setPlaybackQuality call) — measured: the embed ignores that command;
 *   - it does NOT play video. Playback itself is a browser thing; the measured
 *     claims live in REPORT.md.
 *
 * Run: node tests/test_quality.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const results = []
let failed = 0

async function record(name, fn) {
  try {
    await fn()
    results.push(`PASS ${name}`)
  } catch (error) {
    failed += 1
    results.push(`FAIL ${name}: ${error && error.message ? error.message : error}`)
  }
}

const quality = (await import(pathToFileURL(path.join(ROOT, 'web', 'quality.js')).href)).default
const pageSource = fs.readFileSync(path.join(ROOT, 'web', 'player.html'), 'utf8')

// ---------------------------------------------------------------- module

await record('quality: YouTube is auto-only, a file is not', () => {
  assert.equal(quality.autoOnly('youtube'), true)
  assert.equal(quality.autoOnly('playlist'), true)
  assert.equal(quality.autoOnly('video'), false)
  assert.equal(quality.autoOnly('frame'), false)
  assert.equal(quality.autoLabel, 'Auto (YouTube decides)')
})

await record('quality: what the player really reports is read, junk is dropped', () => {
  // A real infoDelivery frame from a measured embed (EF8C4v7JIbA, headless
  // Chrome): the levels and the playing quality both travel here.
  const real = {
    playbackQuality: 'hd1080',
    preferredQuality: 'auto',
    availableQualityLevels: ['hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny', 'auto']
  }
  const seen = quality.fromInfo(real)
  assert.equal(seen.current, 'hd1080')
  assert.equal(seen.preferred, 'auto')
  assert.deepEqual(seen.levels, real.availableQualityLevels)

  assert.deepEqual(quality.fromInfo(null), { current: '', preferred: '', levels: [] })
  assert.deepEqual(quality.fromInfo({ playbackQuality: 42, availableQualityLevels: 'hd1080' }),
    { current: '', preferred: '', levels: [] })
  assert.deepEqual(quality.fromInfo({ availableQualityLevels: ['hd720', 7, '', null] }).levels,
    ['hd720'])
})

await record('quality: a source swap keeps the position and the play state', () => {
  const plan = quality.swapPlan(
    { position: 412.5, playing: true },
    { url: 'https://archive.org/download/x/The_General_512kb.mp4' }
  )
  assert.equal(plan.url, 'https://archive.org/download/x/The_General_512kb.mp4')
  assert.equal(plan.position, 412.5, 'the swap forgot where the film was')
  assert.equal(plan.playing, true, 'the swap forgot that it was playing')

  const paused = quality.swapPlan({ position: 90, playing: false }, { url: 'https://e.org/a.mp4' })
  assert.equal(paused.playing, false)
  assert.equal(paused.position, 90)

  // Nothing known yet, a negative clock, or no target: no invented plan.
  assert.equal(quality.swapPlan(null, { url: 'https://e.org/a.mp4' }).position, 0)
  assert.equal(quality.swapPlan({ position: -5 }, { url: 'https://e.org/a.mp4' }).position, 0)
  assert.equal(quality.swapPlan({ position: 10 }, { url: '' }), null)
  assert.equal(quality.swapPlan({ position: 10 }, null), null)
})

await record('quality: a label says what a choice really is', () => {
  assert.equal(quality.label({ height: 480, width: 640, size_bytes: 412400222, format: 'h.264' }),
    '640×480 · 393 MB · h.264')
  assert.equal(quality.label({ size_bytes: 1048576, format: 'MPEG4' }), '1 MB · MPEG4')
  assert.equal(quality.label({}), 'file')
})

// ---------------------------------------------------------------- the page

await record('quality: the page loads the rules and reports what is really playing', () => {
  assert.match(pageSource, /<script src="quality\.js"><\/script>/,
    'player.html does not load web/quality.js')
  assert.match(pageSource, /AuraQuality\.fromInfo\(/,
    'the page does not read the player\'s own quality report')
  assert.match(pageSource, /quality: state\.quality/, 'the page does not report quality upward')
})

await record('quality: the page swaps the source in place, at the same second', () => {
  assert.match(pageSource, /AuraQuality\.swapPlan\(/,
    'the page does not use the shipped swap rule')
  // What the player publishes is kept as the recorded level, so the app can
  // show what is really playing next to "Auto".
  assert.match(pageSource, /AuraQuality\.fromInfo\(info\)/,
    'the page ignores what the player reports about its quality')
  assert.match(pageSource, /state\.quality\.current/, 'the page never records the level')
  // The swap must seek the NEW element once its metadata is in — that is what
  // makes the switch land at the same second instead of 0:00.
  assert.match(pageSource, /applyVideoQuality[\s\S]{0,1600}?loadedmetadata|loadedmetadata[\s\S]{0,400}?qualityPlan/,
    'the swap never restores the position on the new source')
})

await record('quality: nothing tries to force a YouTube level', () => {
  // The comment in the page names the command (it explains why it is not used),
  // so this checks for a real call: the quoted name, which only code carries.
  assert.ok(!/['"]setPlaybackQuality['"]/.test(pageSource),
    'the page still sends setPlaybackQuality, which the embed ignores')
  assert.ok(!/[?&]vq=/.test(pageSource),
    'the page carries a vq= hack')
  assert.ok(!/['"]setPlaybackQuality['"]/.test(fs.readFileSync(path.join(ROOT, 'web', 'quality.js'), 'utf8')),
    'the rules module sends setPlaybackQuality')
})

// ---------------------------------------------------------------- output

for (const line of results) console.log(line)
console.log(failed ? `\n${failed} failing` : `\nall ${results.length} passing`)
process.exit(failed ? 1 : 0)
