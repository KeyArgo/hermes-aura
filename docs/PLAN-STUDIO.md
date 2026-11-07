# Aura Studio plan: MilkDrop's controls, no stuck frame

Status: proposal, 2026-11-07. Owner approval needed before building. Hackathon deadline: 2026-11-11 15:00 Denver.

## Goal
- Aura Live is a **theme**: MilkDrop visuals behind the whole app (working as of 2026-11-07).
- Every control lives in one place, **Aura Studio**: a panel over the app that closes with X, Esc or
  a click outside. No permanent pane, no separate page.
- Bring over as much of MilkDrop's control set as the engine (Butterchurn) supports.

## How people open and close it
| Way in | What happens |
|---|---|
| Sidebar "Aura" | Opens Aura Studio (panel over the app, dimmed behind) |
| Command palette "Aura: Studio" / "Aura: next design" / "Aura: lock design" | Studio, or a direct action |
| Settings → Plugins → Aura | On/off, Aura Live theme switch, an "Open Aura Studio" button |
| `/skin aura-live` (built into Hermes) | Selects the theme; Studio can stay closed |
| X, Esc, or a click outside the panel | Closes Studio. Nothing stays open |

Removed: the /aura full page, the compact right-hand pane (closing a plugin's only pane can disable
the plugin in Hermes core), and the stage's in-page control bar.

## Studio layout (four tabs)
1. **Designs**: a live preview at the top. A browser with search, thumbnails, favourites (★),
   hide (🚫), previous/next/random, and **lock current design**.
2. **Transitions**: auto-switch on/off, the time between switches (seconds) plus randomness,
   shuffle vs. in order (favourites only, optionally), blend time, and **hard cuts on the beat** with
   beat sensitivity (MilkDrop's "hard cut" behaviour).
3. **Sound**: motion (Designs only / Designs + music / Music only), reaction strength, what it
   follows (bass / mids / highs / everything), settle speed, mood reactions to agent events, and the
   capture device.
4. **Look & window**: background visibility, colour mode (Aura purple / match my current theme /
   custom tint, plus hue, saturation and brightness), quality (mesh size, texture resolution,
   anti-aliasing, frame-rate cap), song-title style text for agent events (Butterchurn
   `launchSongTitleAnim`), calm/balanced/intense, and reduced motion.

## MilkDrop feature map (verified against the vendored Butterchurn API)
| MilkDrop option | Engine support | Effort |
|---|---|---|
| Preset browse / next / prev / random / lock | `loadPreset(preset, blendSeconds)` | easy |
| Favourites, hide, shuffle, favourites-only | Aura-side list logic | easy |
| Auto-switch time + randomness, blend time | Aura timer + `loadPreset` blend | easy |
| Hard cut on beat + sensitivity | Aura beat detector already has onsets → `loadPreset(p, 0)` | medium |
| Song-title animation | `launchSongTitleAnim(text)` | easy |
| Mesh size, texture size, FXAA, pixel ratio | `setInternalMeshSize`, `textureRatio`, `setOutputAA`, `pixelRatio` | easy |
| Brightness / hue / saturation | CSS filter on the canvas | easy |
| Frame-rate cap | Aura render loop | easy |
| More preset packs (beyond the ~100 shipped) | butterchurn-presets extra packs; **licence review first** | medium |
| Import your own .milk files | needs .milk→JSON conversion; HLSL shaders don't convert reliably | hard, phase 3 |
| Live preset editing (MilkDrop's editor) | not supported by the engine | no |
| Custom sprites / Winamp menus | not supported | no |

## Phases (built by Spark/DeepSeek lanes; Claude reviews, tests and checks on screen)
- **P1 Studio shell** (~½ day): panel over the app (X/Esc/outside click), sidebar/palette/settings
  entry points, remove page + pane, Designs tab with preview, browse, search, favourites and lock.
  *Done when:* the owner opens and closes it three ways, picks a design, and the backdrop changes.
- **P2 MilkDrop controls** (~1 day): Transitions + Sound + Look tabs, hard cuts on the beat, quality,
  colour modes, song-title text for agent events. Server config keys, validated, persisted.
  *Done when:* every control visibly changes the backdrop (screenshots before and after).
- **P3 Extras** (optional, after the deadline): more preset packs (licence), .milk import.
- **Windows** in parallel: soundcard capture lane (`.lanes-windows-TASK.md`) + owner test on the PC.

## Risks
- Theme glass and the backdrop rely on overriding Hermes CSS variables (no official backdrop API), so
  a Hermes Desktop update can break them. Mitigation: fall back to a plain theme; propose a backdrop
  slot upstream.
- Two Aura servers run today (gateway and plugin host) with a shared token file. Studio talks to
  whichever server `/status` returns; moving capture out of process fixes this properly later.
- GPU cost: the backdrop and the Studio preview both render. The preview pauses when Studio closes.
