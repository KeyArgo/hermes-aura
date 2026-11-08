# Council brief: how does Aura become the #1 entry?

You are one voice in a 4-model council (Codex, Grok, DeepSeek V4.1 Flash, Claude). Answer independently.
READ-ONLY: do not edit, create, run installs, or start/stop anything. Reading files in this repo is fine.
Answer in <= 600 words, plain language, ranked recommendations, each with "why it moves the score" and
"rough effort (hours)". Be concrete and skeptical; disagree with the brief where you think it's wrong.

## The contest
Nous Research Hermes plugin hackathon, due 2026-11-11 15:00 America/Denver (~4 days). Judged on four
criteria, 25 points each: Usefulness, Reliability, Polish, Creativity. A competitor-watch sample (two
models scoring short excerpts) put Aura at 80/100 (Usefulness 20, Reliability 20, Polish 17.5,
Creativity 22.5) vs 82.5 for the sample leaders. Treat that as weak signal only.

Competitor-watch advice (summarised): the unique thing is visuals that react to music AND to what the
Hermes agent is doing (thinking, tools, approval requests, errors, finishing). Prove the full flow in
the real app; make the agent reaction the memorable demo moment (works even with video muted); make it
safe to live with (obvious off switch, reduced motion, flash limits, readable chat, failure cases);
claim only Linux unless Windows/macOS are really tested; do a clean-install rehearsal on the exact
submission revision.

## What Aura is now (repo: /mnt/homes/Development/hermes-aura, local git, uncommitted work)
- Hermes plugin: Python server captures system audio (pipewire/pulse on Linux; Windows backend
  unverified; macOS needs BlackHole) → analysis → WebSocket → Butterchurn (MilkDrop in WebGL) page.
- Agent hooks set a "mood" (thinking / tool / approval / error / done) that steers presets/accent.
- As of 2026-11-07 it WORKS in the real Hermes Desktop on Linux: "Aura Live" theme puts animated
  MilkDrop behind the whole app (click-through iframe at z-index -1 + translucent panels), motion
  modes (Designs only / Designs+music / Music only), background visibility, reaction strength,
  calm/balanced/intense. Tonight's fixes: capture busy-loop that froze the gateway, backend import bug
  (capture never worked in Hermes), missing dashboard manifest (stage never loaded), autoplay lock in
  the click-through backdrop, stale enabled flag.
- Known weak spots: relies on overriding Hermes CSS variables (no official backdrop API); two Aura
  server instances run (gateway + plugin host); capture runs inside the gateway (~4% CPU, more with
  music); a separate stage page + side pane still exist (owner wants them gone).
- Owner wants: "Aura Studio" — a closable panel (X / Esc / click outside) to preview and design the
  look, with MilkDrop's controls (preset browse/search/favourites/lock, auto-switch + blend, hard cut
  on beat, quality, colour). Plan: docs/PLAN-STUDIO.md. The owner's other plugin REVamp
  (/mnt/homes/Development/revamp, web/player.js ~L737-790) embeds Webamp's MilkDrop with the controls
  they like.

## Questions
1. What 3-5 things, done by the deadline, most raise the judged score? Rank them.
2. Studio vs. agent-aware demo vs. reliability hardening: how should ~4 days be split?
3. What should be CUT or not claimed?
4. The single 60-second demo script you'd submit.
5. One risk the owner is probably not seeing.
