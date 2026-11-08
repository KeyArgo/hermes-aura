/**
 * Catalog guard for the curated MilkDrop list (web/presets.json).
 *
 * The vendored bundle (web/vendor/butterchurnPresets.min.js) is a UMD module
 * exposing getPresets(); aura.js renders whatever names are in presets.json,
 * so a typo or a curated-out name silently degrades the visual. This test
 * checks the catalog against the bundle and against the mood families the
 * mood engine in aura.js actually selects by.
 *
 * Covered:
 *   - schema keys intact (schema/note/default/presets) and every entry is
 *     { name, family, strobe, beat } with strobe a strict boolean, beat 0-5;
 *   - every catalog name (and the default) exists in the vendored bundle;
 *   - no duplicate names;
 *   - >= 30 entries and >= 12 non-strobe entries (reduced-motion pool);
 *   - families used by MOOD_FAMILIES in aura.js are all non-empty in the
 *     catalog, and the catalog introduces no family aura.js cannot map to.
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

function loadBundleNames() {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'vendor', 'butterchurnPresets.min.js'), 'utf8')
  const mod = { exports: {} }
  // UMD wrapper: factory(module, exports, self)
  new Function('module', 'exports', 'self', src)(mod, mod.exports, undefined)
  return new Set(Object.keys(mod.exports.getPresets()))
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
  assert.ok(catalog.presets.length >= 30, 'expected >= 30 presets, got ' + catalog.presets.length)
  const calm = catalog.presets.filter(p => !p.strobe).length
  assert.ok(calm >= 12, 'expected >= 12 non-strobe presets, got ' + calm)
})

record('mood families are all non-empty and nothing drifted outside them', () => {
  const used = new Set(catalog.presets.map(p => p.family))
  const empty = [...moodFamilies].filter(f => !used.has(f))
  assert.deepEqual(empty, [], 'families used by aura.js have no catalog preset')
  const unknown = [...used].filter(f => !moodFamilies.has(f))
  assert.deepEqual(unknown, [], 'catalog invents families aura.js cannot map')
})

console.log(results.join('\n'))
console.log(`\n${results.length - failed} passed, ${failed} failed`)

if (failed > 0) process.exitCode = 1
