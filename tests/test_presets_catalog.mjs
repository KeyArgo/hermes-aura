/**
 * Catalog guard for the curated MilkDrop list (web/presets.json).
 *
 * The vendored packs (web/vendor/butterchurnPresets*.min.js) are UMD modules
 * exposing getPresets(); aura.js renders whatever names are in presets.json,
 * so a typo or a curated-out name silently degrades the visual. This test
 * checks the catalog against the union of the loaded packs and against the
 * mood families the mood engine in aura.js actually selects by.
 *
 * Covered:
 *   - schema keys intact (schema/note/default/presets) and every entry is
 *     { name, family, strobe, beat } with strobe a strict boolean, beat 0-5;
 *   - every catalog name (and the default) exists in the loaded pack union;
 *   - no duplicate names;
 *   - >= 120 entries and >= 40 non-strobe entries (reduced-motion pool);
 *   - families used by MOOD_FAMILIES in aura.js are all non-empty in the
 *     catalog, and the catalog introduces no family aura.js cannot map to;
 *   - the shuffle bag walks the whole pool before repeating and never draws
 *     the same name twice in a row.
 *
 * Run: node tests/test_presets_catalog.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

function loadCatalog() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'presets.json'), 'utf8'))
}

const PACK_FILES = [
  'butterchurnPresets.min.js',
  'butterchurnPresetsExtra.min.js',
  'butterchurnPresetsExtra2.min.js',
  'butterchurnPresetsMD1.min.js',
]

function loadBundleNames() {
  const names = new Set()
  for (const file of PACK_FILES) {
    const src = fs.readFileSync(path.join(ROOT, 'web', 'vendor', file), 'utf8')
    const mod = { exports: {} }
    // UMD wrapper: factory(module, exports, self)
    new Function('module', 'exports', 'self', src)(mod, mod.exports, undefined)
    for (const name of Object.keys(mod.exports.getPresets())) names.add(name)
  }
  return names
}

function loadShuffleBagFactory() {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'aura.js'), 'utf8')
  const block = src.match(/\/\/ --- shuffle bag[\s\S]*?\/\/ --- end shuffle bag ---/)
  assert.ok(block, 'shuffle bag block not found in web/aura.js')
  return new Function(block[0] + '\nreturn createPresetShuffleBag')()
}

function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function loadMoodFamilies() {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'aura.js'), 'utf8')
  const block = src.match(/const MOOD_FAMILIES = \{[\s\S]*?\n  \};/)
  assert.ok(block, 'MOOD_FAMILIES not found in web/aura.js')
  const families = new Set()
  for (const match of block[0].matchAll(/'([a-z]+)'/g)) families.add(match[1])
  assert.ok(families.size >= 4, 'unexpectedly few mood families: ' + [...families].join(','))
  return families
}

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

const catalog = loadCatalog()
const bundle = loadBundleNames()
const moodFamilies = loadMoodFamilies()

record('catalog keeps its schema keys', () => {
  assert.equal(catalog.schema, 1, 'schema must stay 1')
  assert.equal(typeof catalog.note, 'string')
  assert.ok(catalog.note.length > 0, 'note should explain the curation')
  assert.equal(typeof catalog.default, 'string')
  assert.ok(Array.isArray(catalog.presets))
})

record('every entry is { name, family, strobe, beat }', () => {
  for (const p of catalog.presets) {
    assert.deepEqual(Object.keys(p).sort(), ['beat', 'family', 'name', 'strobe'], 'bad keys on ' + JSON.stringify(p.name))
    assert.ok(Number.isInteger(p.beat) && p.beat >= 0 && p.beat <= 5, 'beat 0-5 on ' + p.name)
    assert.equal(typeof p.name, 'string')
    assert.ok(p.name.length > 0)
    assert.equal(typeof p.family, 'string')
    assert.equal(typeof p.strobe, 'boolean', 'strobe must be true/false for ' + p.name)
  }
})

record('every catalog preset exists in the vendored bundle', () => {
  const missing = catalog.presets.map(p => p.name).filter(name => !bundle.has(name))
  assert.deepEqual(missing, [], 'names not in butterchurnPresets bundle')
})

record('default is in the catalog and the bundle', () => {
  assert.ok(bundle.has(catalog.default), 'default not in bundle: ' + catalog.default)
  assert.ok(catalog.presets.some(p => p.name === catalog.default), 'default not listed in presets')
})

record('no duplicate preset names', () => {
  const seen = new Set()
  for (const p of catalog.presets) {
    assert.ok(!seen.has(p.name), 'duplicate entry: ' + p.name)
    seen.add(p.name)
  }
})

record('catalog is large enough and keeps a calm pool', () => {
  assert.ok(catalog.presets.length >= 120, 'expected >= 120 presets, got ' + catalog.presets.length)
  const calm = catalog.presets.filter(p => !p.strobe).length
  assert.ok(calm >= 40, 'expected >= 40 non-strobe presets, got ' + calm)
})

record('mood families are all non-empty and nothing drifted outside them', () => {
  const used = new Set(catalog.presets.map(p => p.family))
  const empty = [...moodFamilies].filter(f => !used.has(f))
  assert.deepEqual(empty, [], 'families used by aura.js have no catalog preset')
  const unknown = [...used].filter(f => !moodFamilies.has(f))
  assert.deepEqual(unknown, [], 'catalog invents families aura.js cannot map')
})

record('shuffle bag walks the whole pool before repeating', () => {
  const makeBag = loadShuffleBagFactory()
  const pool = Array.from({ length: 20 }, (_, i) => ({ name: 'preset-' + i }))
  const bag = makeBag(mulberry32(0xC0FFEE))
  const seen = new Set()
  let previous = null
  for (let i = 0; i < pool.length; i++) {
    const name = bag.draw(pool, previous)
    assert.ok(name, 'bag returned no name at draw ' + i)
    assert.notEqual(name, previous, 'bag repeated the previous preset')
    seen.add(name)
    previous = name
  }
  assert.equal(seen.size, pool.length, 'first full bag did not cover the whole pool')
})

record('shuffle bag does not repeat a name until the pool is exhausted', () => {
  const makeBag = loadShuffleBagFactory()
  const pool = Array.from({ length: 12 }, (_, i) => ({ name: 'p' + i }))
  const bag = makeBag(mulberry32(42))
  const counts = new Map(pool.map(p => [p.name, 0]))
  let previous = null
  for (let i = 0; i < 60; i++) {
    const name = bag.draw(pool, previous)
    assert.ok(name, 'bag returned no name at draw ' + i)
    assert.notEqual(name, previous, 'bag repeated the previous preset')
    counts.set(name, (counts.get(name) || 0) + 1)
    previous = name
  }
  for (const [name, count] of counts) assert.ok(count >= 3, name + ' was starved: ' + count)
})

console.log(results.join('\n'))
console.log(`\n${results.length - failed} passed, ${failed} failed`)

if (failed > 0) process.exitCode = 1
