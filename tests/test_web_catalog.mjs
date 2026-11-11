/**
 * Regression test for the blank stage in the preset catalog.
 *
 * presets.json can load successfully and still carry nothing playable. The old
 * loadCatalog only fell back to the vendored pack when the request THREW, so a
 * 200 with an empty list left the page with no presets at all: nothing could be
 * picked and the canvas stayed a blank frame with no message.
 *
 * Run: node tests/test_web_catalog.mjs
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

async function record(name, fn) {
  try {
    await fn()
    results.push(`PASS ${name}`)
  } catch (error) {
    failed += 1
    results.push(`FAIL ${name}: ${error && error.message ? error.message : error}`)
  }
}

const VENDORED = {
  getPresets: () => ({ 'alpha preset': {}, 'beta preset': {}, 'gamma preset': {} })
}

function freshAura(payload) {
  const sandbox = {
    location: { search: '?token=test-token' },
    URLSearchParams,
    AbortController,
    document: {
      readyState: 'loading',
      documentElement: { classList: { add() {} } },
      body: { classList: { add() {} } },
      addEventListener() {},
      getElementById() { return null }
    },
    window: {
      addEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      butterchurnPresets: VENDORED
    },
    performance: { now: () => 0 },
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => payload }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {}
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'web/aura.js' })
  const aura = sandbox.window.__aura
  assert.ok(aura, 'window.__aura test hook missing')
  assert.equal(typeof aura._loadCatalog, 'function', 'the _loadCatalog hook is missing')
  assert.equal(typeof aura._catalog, 'function', 'the _catalog hook is missing')
  return aura
}

await record('a loaded catalog with presets is used as-is', async () => {
  const aura = freshAura({ presets: [{ name: 'mine', family: 'liquid', strobe: false, beat: 1 }] })
  await aura._loadCatalog()
  const cat = aura._catalog()
  assert.equal(JSON.stringify(cat.presets.map(p => p.name)), '["mine"]',
    'the served catalog was not used')
  assert.equal(cat.default, null)
})

await record('an empty presets.json falls back to the vendored pack', async () => {
  const aura = freshAura({ presets: [] })
  await aura._loadCatalog()
  const cat = aura._catalog()
  assert.equal(cat.presets.length, 3, `expected the vendored pack, got ${cat.presets.length}`)
  // Cross-realm arrays from the vm sandbox fail deepEqual's reference checks.
  assert.equal(JSON.stringify(cat.presets.map(p => p.name).sort()),
    JSON.stringify(['alpha preset', 'beta preset', 'gamma preset']))
  assert.equal(cat.default, cat.presets[0].name, 'no default preset after the fallback')
})

await record('a catalog whose entries are all unusable also falls back', async () => {
  const aura = freshAura({ presets: [{ nope: true }, null, { name: 42 }] })
  await aura._loadCatalog()
  const cat = aura._catalog()
  assert.equal(cat.presets.length, 3, 'unusable entries did not trigger the vendored fallback')
})

for (const line of results) console.log(line)
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
