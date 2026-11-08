# Council synthesis (2026-11-07): Codex, Grok 4.7 High (Cursor), DeepSeek V4.1 Flash, Claude

## All four agree
1. **The agent-aware moment is the entry.** Approval / tool / error / done must be readable with the video
   muted: a big Butterchurn `launchSongTitleAnim` caption ("Needs your OK", "Tool failed", "Done") plus a
   visible preset/colour change, fired by REAL hooks inside Hermes (not a staged mood command). ~5-10 h.
2. **Freeze one Linux commit early, clean-install rehearse it, and record the demo from that exact
   commit.** The judges install a SHA, not tonight's session. ~6-10 h.
3. **Studio stays thin and comes last:** one closable panel (X / Esc / outside click), next/lock design,
   motion, visibility, off. No hard cuts on beat, quality knobs, colour engine, favourites grid, packs
   or .milk import before the deadline.
4. **Claim Linux only.** Windows/macOS "untested". The catalog draft lists `platforms: [linux, windows,
   macos]`; change it to `[linux]`. Pin the tested Hermes version (the backdrop is an unofficial
   CSS-variable override).

## Verified finding (DeepSeek; checked by Claude against the code)
- **"Off" does not stop audio capture.** `aura_core/server.py::_capture_loop` never checks `enabled`; the
  server (and so `parec`) starts at plugin register; `__init__.py:566` defaults the hook gate to `True`.
  A judge who switches Aura off can still see it listening. That contradicts the privacy claim. **Fix
  first** (gate/park capture on enabled; start capture only when enabled; default off everywhere). ~4-6 h.

## Shared risk (Codex + Grok + Claude)
- **Two Aura servers** (gateway + plugin host) can each look healthy while hooks publish mood to one and
  the backdrop listens to the other, so the demo's mood change never reaches the pixels. Trace one real
  hook event → visible backdrop change after a clean restart. Make it one server.

## Disagreements
- Grok: the catalog pin (STATUS says **Nov 9**) is the real clock, not Nov 11. Verify the date in the
  contest rules before planning.
- DeepSeek: spend 0 h on Studio and keep the stage page + pane as fallbacks. Codex/Grok: thin Studio, but
  remove the pane only once Studio works in the real host (closing a plugin's only pane can disable it).
  Owner wants Studio, so: thin Studio last, pane removed only after Studio is proven.
- DeepSeek: publish the repo/catalog PR now (review lead time). Needs owner OK (public action).

## Recommended order (combined)
1. Off-means-off + single server/capture (reliability, privacy).
2. Agent-mood signatures + captions, verified from real hooks on screen.
3. Commit + freeze → clean-profile install rehearsal → fix what breaks.
4. Safe-to-leave-on pass: readable chat on bright presets, silence rests, reduced motion on real frames,
   obvious Off.
5. Thin Studio (closable), then remove the stage page + pane.
6. Record the 60 s demo on the frozen SHA; README/STATUS honest; submit (owner approves public steps).

## 60-second demo (merged)
0-8 s normal readable Hermes → Aura Live on, music moves the glass backdrop. 8-15 s music stops, the
designs rest gently. 15-40 s a real task: tool call → approval: "Needs your OK" caption + warm hold →
approve → "Done" bloom → settle. 40-50 s open Studio, lock a design, lower visibility, Esc. 50-56 s Off:
capture stops, the previous theme returns. 56-60 s card: "Linux · tested with Hermes <version> · loopback,
never mic · nothing recorded".

Answers: codex.md, grok.md, deepseek.md (long; its answer is at the end), claude.md.
