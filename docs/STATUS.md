# Aura — build status

Machine-readable checklist for the 5-minute progress reports. Weights sum to 120 and are
normalised to 100 %. `done` is the honest completion fraction (0.0 = untouched, 1.0 = verified by
a real command, not by a claim). Remaining % = Σ(weight × (1 − done)) ÷ 120 × 100.

Deadline: hackathon submission **Nov 11, 17:00 EST**; catalog PR target **Nov 9**.
Repo: /mnt/homes/Development/hermes-aura (LOCAL git only — nothing pushed yet).

| # | item | weight | done | evidence / blocker |
|---|---|---|---|---|
| 1 | wire contract + spikes (S1–S5) | 5 | 1.0 | CONTRACT.md §1–§10, SPIKES.md with measured numbers |
| 2 | Linux loopback capture | 10 | 1.0 | S2 probe: 786432 bytes = 4.10 s stereo 48k, RMS rising |
| 3 | server, WS PCM, analysis, redaction | 10 | 1.0 | tests/test_server.py, test_analysis.py green |
| 4 | page, Butterchurn, curated presets | 12 | 0.95 | 21 presets measured; mood→family steering merged but only tested headless |
| 5 | desktop half (stage route, chip, settings, accent pulse, theme) | 12 | 0.70 | plugin.js 30 KB, 35/35 contract tests; never run inside the real app |
| 6 | mood engine + agent hooks | 6 | 0.90 | mood.py + hooks; approval pulse and restore covered by e2e |
| 7 | display controls (opacity, behaviour, 3 switches) | 6 | 0.90 | L6 merged; verified headless + node contract test |
| 8 | silence gate (visual follows audio) | 4 | 1.0 | 21/21 presets dark in silence, mean 0, lit 0.000 |
| 9 | test suite (unit + e2e + integration) | 8 | 1.0 | 178 passed, exit 0 (log: .last-test.log); includes the silence-gate test and a tone-fed degrade test |
| 10 | Windows WASAPI loopback | 7 | 0.20 | implemented, never run on a real Windows machine |
| 11 | macOS capture | 5 | 0.30 | implemented, needs BlackHole/virtual device, unverified |
| 12 | in-app verification (accent pulse, theme restore, iframe sandbox) | 10 | 0.00 | structural only; needs the user to open Aura in Hermes |
| 13 | demo video + stills | 5 | 0.90 | .demo/aura-demo.mp4: 277 frames, 13.8 fps, curated presets, music-only showcase + mood tail; stills dense |
| 14 | docs, notices, plugin validation | 5 | 1.0 | README, THIRD_PARTY_NOTICES, `hermes plugins validate .` passes |
| 15 | publish: repo, catalog PR, X post, submission form | 10 | 0.00 | all need the user's explicit OK |
| 16 | cross-family review round (GLM/Qwen over the merged tree) | 5 | 0.00 | not started |

## Remaining work, in order

1. Finish the full test run and commit the silence gate.
2. Re-record the demo against the curated preset set; capture the stills.
3. Refresh the staged desktop half and have the user open Aura (item 12 is the big unknown:
   accent pulse through `ctx.rest('/state')`, theme restore, iframe sandbox).
4. Windows verification (item 10) — the only claim that would otherwise be unearned.
5. Review round (item 16), then publish (item 15) with explicit approval.

## Rules for the reporter

- Report only what a command shows. If a test run is in flight, say so and quote the last result.
- Never mark an item done because a lane claimed it; only because a command here passed.
- Keep the report to: what changed since the last report, what remains (ordered), remaining %.
