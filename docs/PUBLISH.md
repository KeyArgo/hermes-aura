# Publishing Aura — drafts to approve

Nothing here has been executed. Every step below is a public action and needs an explicit
"go" from Daniel first (standing rule: ask before any public commit/PR/repo/post/form).

## 0. Preconditions

- Repo `/mnt/homes/Development/hermes-aura` is **local-only** (no remote configured). Check:
  `git remote -v` (currently empty).
- The catalog requires a **public** repo and an **exact 40-char SHA** pin, submitted by the
  repository owner or a major contributor.
- `hermes plugins validate .` passes (desktop-surface + security scan included).
- Platform honesty: Linux verified; Windows and macOS implemented but **not** verified — the
  catalog description and README must say so.

## 1. Create and push the repo (needs OK)

Suggested name: `hermes-aura` under the user's account. Description:

> Audio-reactive visualizer and living theme for Hermes Desktop: it listens to whatever your
> computer is playing (system loopback, never the microphone), draws a MilkDrop-compatible
> stage, pulses the app accent with the music, and reacts to what the agent is doing. Local
> only — no account, no network, no audio recorded.

Topics: `hermes-plugin`, `visualizer`, `butterchurn`, `milkdrop`, `audio-reactive`, `pipewire`.

Before pushing: rotate nothing (no secrets in the tree — verified: token lives in
`$HERMES_HOME/aura/token` at runtime and is never committed), and confirm `.gitignore` covers
`.demo/`, `.last-test.log`, `.venv/`, `*.pyc`.

## 2. Catalog entry (draft YAML — pin the SHA only after the push)

Path in the hermes-agent repo: `plugin-catalog/aura.yaml`

```yaml
name: aura
repo: https://github.com/<owner>/hermes-aura
sha: <40-char commit SHA from the pushed default branch>
description: >-
  Audio-reactive visualizer and living theme for Hermes Desktop. It captures system audio
  loopback (what the machine is already playing — never the microphone), streams it locally
  to an Aura stage that renders a MilkDrop-compatible visualization, pulses the app accent
  colour with the music, and shifts mood with what the agent is doing (thinking, tools,
  approval, error, streaming, done). Display controls: opacity, calm/balanced/intense
  behaviour profiles (calm is reduced-motion safe and never uses strobe presets), and
  switches for agent-mood reactions, accent pulse and automatic preset rotation. Starts off,
  never plays or ducks sound, and does everything on the machine: no account, no network,
  nothing recorded. Linux verified; Windows (WASAPI loopback) and macOS (virtual audio
  device) are implemented but unverified.
maintainer: <owner>
tier: community
category: appearance
docs_url: https://github.com/<owner>/hermes-aura#readme
version: "0.1.1"
platforms: [linux, windows, macos]
capabilities:
  provides_tools: [aura_control]
  provides_hooks:
    - on_session_start
    - on_session_end
    - pre_tool_call
    - post_tool_call
    - pre_approval_request
    - post_approval_response
    - api_request_error
    - on_stream_start
    - on_stream_end
    - subagent_start
    - subagent_stop
  provides_middleware: []
  requires_env: []
```

## 3. PR title and body (draft)

Title: `catalog: add aura — audio-reactive visualizer and living theme`

Body:

```
Adds `aura` to the catalog.

What it does: captures system audio loopback (PipeWire/Pulse on Linux, WASAPI on Windows,
virtual device on macOS) and renders it as a MilkDrop-compatible visualizer in a full-window
stage, pulses the app accent colour with the music, and reacts to agent state. It never plays,
pauses or ducks audio; capture is loopback only, never the microphone; all analysis is local.

Safety posture:
- Turn Aura off using the stage control or Aura settings.
- Random ephemeral port on 127.0.0.1 with a per-process token file (0600). Static assets are
  public (a browser cannot attach a bearer to <script src>); every data endpoint and the
  WebSocket require the token. Host-header guard against DNS rebinding.
- No network egress of any kind; nothing recorded to disk.
- Desktop half stays inside the plugin SDK surface; `hermes plugins validate` passes including
  the security scan and the desktop-surface check.
- Reduced-motion: a dedicated `calm` profile with no strobe presets and no hard pulses.

Verified: 178 tests (unit + real-Chrome e2e + integration), measured on Linux. Windows (WASAPI)
and macOS capture are implemented but **unverified** — flagged in the description.

No self-updater; the SHA pin is the update mechanism.
```

## 4. Submission blurb (hackathon form / README summary)

> Aura turns Hermes Desktop into a room that reacts to your music and to what the agent is
> doing. It listens to whatever the machine is already playing — no account, no integration,
> no audio leaving the box — and draws it: a full-window MilkDrop stage, an accent colour that
> breathes with the beat, and a mood that shifts when the agent thinks, runs a tool, waits for
> approval or finishes. Opacity, behaviour and reaction switches are yours to set; it starts
> off, and it never makes or ducks a sound.

## 5. X post (draft, 280 chars)

> Built Aura for @NousResearch Hermes: it listens to whatever your machine is playing (loopback,
> never the mic), draws a MilkDrop stage, pulses the app accent with the beat, and shifts mood
> when the agent thinks or waits for approval. Local only, starts off, version 0.1.1.

## 6. Approval checklist

- [ ] repo create + push (public)
- [ ] catalog PR opened against `hermes-agent`
- [ ] X post
- [ ] submission form
- [ ] (after merge) `hermes plugins update aura` sanity check
