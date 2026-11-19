/**
 * Regression test for the player page's resume nudge (web/player.html).
 *
 * The page kept asking its player to seek to the saved position every 500 ms for
 * up to 20 s, because a freshly created player ignores commands for a while. A
 * user who seeked while that was still running was dragged back: the nudge had
 * no idea the position was now the user's own choice.
 *
 * The fix is one pure decision, `resumeAfterCommand(cmd, at)`, read out of the
 * shipped page and exercised here as written (the page itself needs a DOM and a
 * player, so it is not bootable in Node). The wiring around it — that the
 * transport handler and the desktop window's seek both use it — is pinned by the
 * text checks at the end.
 *
 * Run: node tests/test_player_resume.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PAGE = path.join(ROOT, 'web', 'player.html')
const source = fs.readFileSync(PAGE, 'utf8')

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

const helperMatch = /function resumeAfterCommand\(cmd, at\) \{[\s\S]*?\n  \}/.exec(source)
const resumeAfterCommand = helperMatch
  ? new Function(`${helperMatch[0]}\nreturn resumeAfterCommand;`)()
  : null

record('the page ships one resume decision, resumeAfterCommand(cmd, at)', () => {
  assert.ok(helperMatch, 'no resumeAfterCommand() in web/player.html')
  assert.equal(typeof resumeAfterCommand, 'function')
})

record('a user seek drops the pending resume point', () => {
  assert.ok(resumeAfterCommand, 'resumeAfterCommand() is missing')
  // Backward and forward alike: whatever the user picked wins over the bookmark.
  assert.equal(resumeAfterCommand('seek', 120), 0, 'a relative seek left the resume point alive')
  assert.equal(resumeAfterCommand('seekTo', 120), 0, 'an absolute seek left the resume point alive')
})

record('every other command leaves the resume point alone', () => {
  assert.ok(resumeAfterCommand, 'resumeAfterCommand() is missing')
  for (const cmd of ['play', 'pause', 'volume', 'mute', 'unmute', 'next', 'prev', 'toggle', undefined, null]) {
    assert.equal(resumeAfterCommand(cmd, 120), 120, `"${cmd}" threw the resume point away`)
  }
  assert.equal(resumeAfterCommand('seek', 0), 0)
})

record('the transport handler applies it before either player branch', () => {
  const handler = /\/\/ Transport commands from the host app\.[\s\S]*?\/\/ --- desktop window mode/.exec(source)
  assert.ok(handler, 'the transport handler could not be found')
  const body = handler[0]
  assert.match(body, /resumeAt = resumeAfterCommand\(cmd, resumeAt\)/,
    'the transport handler never clears the resume point on a seek')
  const clearAt = body.indexOf('resumeAt = resumeAfterCommand(cmd, resumeAt)')
  const videoAt = body.indexOf("if (kind === 'video' && video)")
  const youtubeAt = body.indexOf("if ((kind === 'youtube' || kind === 'playlist') && frame)")
  assert.ok(videoAt > 0 && youtubeAt > 0, 'the video/youtube branches moved')
  assert.ok(clearAt < videoAt && clearAt < youtubeAt,
    'the resume point is cleared after a branch handled the seek, so the nudge races it')
})

record('the desktop window seek clears it too', () => {
  const desktopSeek = /function desktopSeek\(target\) \{[\s\S]*?\n  \}/.exec(source)
  assert.ok(desktopSeek, 'no desktopSeek() in web/player.html')
  assert.match(desktopSeek[0], /resumeAt = 0/, 'the desktop window seek leaves the nudge chasing the bookmark')
})

record('the nudge still stops itself once the position is reached', () => {
  // The fix must not disable the resume itself: the 500 ms interval and its
  // own stop conditions stay exactly where they were.
  assert.match(source, /setInterval\(function \(\) \{ maybeResume\(state\.position\) \}, 500\)/)
  assert.match(source, /if \(resumeAt <= 0\) return false/)
})

// --------------------------------------------------------------------- report

console.log(results.join('\n'))
console.log(`\n${results.length - failed} passed, ${failed} failed`)

if (failed > 0) process.exitCode = 1
