/**
 * Regression test for the black stage in the desktop controls.
 *
 * "Visual opacity" (Settings) and "Visual strength" (the status-bar quick menu)
 * could both be dragged to 0, and the page then painted an empty canvas: a
 * black stage with no explanation. Neither control may offer a value below the
 * floor, and the writer clamps even if one did, because the saved setting is
 * what the page applies on its next load.
 *
 * The plugin is not imported here (it needs the host SDK); the floor helper is
 * lifted out of the source and evaluated, and the two range inputs are read
 * out of the rendered descriptors.
 *
 * Run: node tests/test_visual_strength_floor.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'desktop', 'plugin.js'), 'utf8')

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

/** Every jsx('input', { ... }) descriptor that is a range slider, with the
 *  aria-label and the min expression it would render. */
function rangeInputs(source) {
  const found = []
  const marker = "type: 'range'"
  let at = source.indexOf(marker)
  while (at >= 0) {
    const open = source.lastIndexOf("jsx('input', {", at)
    const close = source.indexOf('})', at)
    if (open >= 0 && close > open) {
      const body = source.slice(open, close)
      const label = (/'aria-label': '([^']+)'/.exec(body) || [])[1] || ''
      const min = (/min: ([^,\n]+),/.exec(body) || [])[1] || ''
      found.push({ label, min: min.trim(), body })
    }
    at = source.indexOf(marker, at + marker.length)
  }
  return found
}

/** The floor and its helper, evaluated as the page would see them. */
function floorHelper() {
  const start = SOURCE.indexOf('const clamp =')
  const declared = SOURCE.indexOf('const visualOpacity =')
  assert.ok(start >= 0 && declared > start, 'visualOpacity is missing from plugin.js')
  const end = SOURCE.indexOf('\n', declared)
  const snippet = SOURCE.slice(start, end)
  const box = {}
  vm.runInNewContext(
    `${snippet}\nthis.visualOpacity = visualOpacity\nthis.MIN_VISUAL_OPACITY = MIN_VISUAL_OPACITY`,
    box,
    { filename: 'desktop/plugin.js (opacity floor)' }
  )
  return box
}

record('the floor is declared once, at a tenth', () => {
  const declared = SOURCE.match(/const MIN_VISUAL_OPACITY = ([0-9.]+)/g) || []
  assert.equal(declared.length, 1, 'expected exactly one MIN_VISUAL_OPACITY')
  assert.equal(Number(declared[0].split('=')[1]), 0.1, 'the floor is not 0.1')
})

record('visualOpacity never returns less than the floor', () => {
  const box = floorHelper()
  assert.equal(box.visualOpacity(0), 0.1, 'a saved 0 must come back at the floor')
  assert.equal(box.visualOpacity(0.05), 0.1, 'below the floor must be lifted')
  assert.equal(box.visualOpacity(-3), 0.1, 'a negative must be lifted')
  assert.equal(box.visualOpacity('nope'), 0.1, 'a non-number must be lifted')
  assert.equal(box.visualOpacity(0.6), 0.6, 'a real value must be left alone')
  assert.equal(box.visualOpacity(1), 1, 'full strength must stay full')
  assert.equal(box.visualOpacity(4), 1, 'above full must clamp to 1')
})

record('setOpacity writes and pushes the clamped value', () => {
  const body = SOURCE.slice(SOURCE.indexOf('async function setOpacity(next)'))
  const head = body.slice(0, body.indexOf('\n}'))
  assert.match(head, /const opacity = visualOpacity\(next\)/,
    'setOpacity no longer funnels through the floor')
  assert.match(head, /writeSettings\(\{ opacity \}\)/)
  assert.match(head, /pushControl\(\{ opacity \}\)/)
})

record('a saved setting is read back at the floor', () => {
  assert.match(SOURCE, /if \(Number\.isFinite\(raw\.opacity\)\) out\.opacity = visualOpacity\(raw\.opacity\)/,
    'a saved 0 is loaded as-is and shown as 0%')
})

record('the Settings "Visual opacity" slider cannot reach 0', () => {
  const control = rangeInputs(SOURCE).find(input => input.label === 'Visual opacity')
  assert.ok(control, 'the Visual opacity slider is gone')
  assert.equal(control.min, '10', `the Settings slider still starts at ${control.min}`)
  assert.match(control.body, /value: Math\.round\(visualOpacity\(settings\.opacity\) \* 100\)/,
    'the slider shows the saved value instead of the painted one')
})

record('the status-bar "Visual strength" slider cannot reach 0', () => {
  // The shared slider renders min from its own argument (its aria-label is the
  // caller's too), so the floor only holds if this row passes it.
  assert.match(SOURCE, /const slider = \(label, value, onValue, minPercent = 0\)/,
    'the shared slider lost its min argument')
  assert.match(SOURCE, /min: minPercent,/, 'the shared slider hard-codes min 0 again')
  assert.match(SOURCE, /slider\('Visual strength', visualOpacity\(settings\.opacity\), value => \{ void setOpacity\(value\) \}, MIN_VISUAL_OPACITY \* 100\)/,
    'Visual strength does not pass the floor to its slider')
  const box = floorHelper()
  assert.equal(box.MIN_VISUAL_OPACITY * 100, 10, 'the floor is not 10%')
})

record('Intensity keeps its own 0 start', () => {
  // Only the opacity controls are floored: a visual that does not react is fine.
  assert.match(SOURCE, /slider\('Intensity', settings\.intensity, value => applyIntensity\(value\)\)/,
    'Intensity lost its 0 default')
})

console.log(results.join('\n'))
if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log(`\n${results.length} passed`)
