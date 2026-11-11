/**
 * Regression test for the dark stage: every same-origin request the page makes
 * must be bounded. The page is served by the same server it talks to, so an
 * endpoint that accepts the connection and then never answers is wedged, not
 * slow — and an unbounded fetch stalls boot() before connect(), which leaves a
 * dark stage with a perfectly healthy /api/stream and no way back.
 *
 * Run: node tests/test_web_fetch.mjs
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

/** A fetch that accepts and then hangs until its signal aborts. */
function hangingFetch(calls) {
  return (url, init) => new Promise((resolve, reject) => {
    calls.push({ url, signal: init && init.signal })
    const signal = init && init.signal
    if (!signal) return // no signal: this request can hang forever
    signal.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })
}

function freshAura(calls) {
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
      matchMedia: () => ({ matches: false, addEventListener() {} })
    },
    performance: { now: () => 0 },
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: hangingFetch(calls),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {}
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'web/aura.js' })
  const aura = sandbox.window.__aura
  assert.ok(aura, 'window.__aura test hook missing')
  assert.equal(typeof aura._getJson, 'function', 'the _getJson hook is missing')
  assert.equal(typeof aura._setFetchTimeoutMs, 'function', 'the timeout hook is missing')
  return aura
}

await record('a request to a wedged endpoint gives up instead of hanging', async () => {
  const calls = []
  const aura = freshAura(calls)
  aura._setFetchTimeoutMs(50)
  const started = Date.now()
  const res = await aura._getJson('/api/state')
  const elapsed = Date.now() - started
  assert.equal(res.ok, false, 'a wedged request must not report success')
  assert.equal(res.status, 0, 'a wedged request must report status 0')
  assert.ok(/abort/i.test(String(res.error)), `expected an abort, got ${res.error}`)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].signal, 'the request carried no abort signal')
  assert.ok(elapsed < 2000, `the request took ${elapsed} ms; it was not bounded`)
})

await record('every fetch in the page is the bounded one', () => {
  // No bare fetch() may survive outside fetchWithTimeout: a single unbounded
  // call is enough to keep the stage dark.
  const body = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const bare = body.split('\n')
    .filter(line => /(^|[^.\w])fetch\(/.test(line))
    .filter(line => !/function fetchWithTimeout|return fetch\(path, init\)/.test(line))
  assert.deepEqual(bare, [], `unbounded fetch call(s): ${bare.join(' | ')}`)
})

for (const line of results) console.log(line)
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
