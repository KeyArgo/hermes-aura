# Reference

One line: every tool, hook, HTTP route and configuration key Aura exposes, with the shapes the code returns.

Applies to Aura 1.0.0 · revised 2026-11-13

## Tools

All three tools return a JSON string. A failure always answers with
`{"ok": false, "error": "..."}` rather than raising.

### `aura_control`

Turn Aura on/off, read status, set intensity/preset/mood, drive the film.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `action` | string enum | yes | `on`, `off`, `status`, `intensity`, `preset`, `mood`, `pause`, `resume`, `next`, `prev`, `seek`, `captions`, `popout`, `popout_inline`, `popin` |
| `intensity` | number 0..1 | for `intensity` | Reaction strength: the fraction of the normalised audio reaction the visualizer draws (`0` = none). A new install starts at `0.25`. |
| `preset` | string or null | for `preset` | Name from `web/presets.json`; `null` resets. |
| `mood` | string enum | for `mood` | `idle`, `thinking`, `tool`, `approval`, `error`, `streaming`, `done` |
| `position` | number ≥ 0 | for `seek` / `popout` | Seconds. |
| `captions` | `on` \| `off` | for `captions` | The film's subtitles; remembered, and applied to whichever player owns the picture. |
| `url` | string | optional for `popout` | Film to open; defaults to the loaded one. |

Return shape (status, abridged): `ok`, `running`, `enabled`, `port`, `capture`,
`mood`, `intensity`, `url` (token redacted), `version`, `pulse_hz`,
`flash_allowed`, `ttl_ms`, and `film` with `player` and `window`. Transport
actions return `ok`, `command`, `seq`, `delivery`, plus the current player
snapshot. `popout` returns `ok`, `open`, `already`; `popin` returns `ok`,
`closed`, `window`.

### `aura_listen`

Internet radio and Aura's separate audio channel.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `action` | string enum | yes | `search_radio`, `play`, `stop`, `volume`, `mute_video`, `unmute_video` |
| `q` | string | for `search_radio` | Station name or keyword. |
| `tag` | string | optional | Genre tag, e.g. `jazz`, `ambient`, `news`. |
| `limit` | integer 1..20 | optional | Choices to return; default 8. |
| `url` | string | for `play` (or use `id`) | Public `http(s)` stream, or a `.pls`/`.m3u` playlist. |
| `id` | string | optional | Id from the last search, a preset or a favourite. |
| `label` | string | optional | What to show the user. |
| `volume` | number 0..1 | for `volume` | Audio-channel volume. |

Search returns `ok`, `count`, `stations` (`n`, `id`, `name`, `url`, `tags`,
`bitrate`, `country`), and `next` (show the numbered choices and wait). `play`
returns `ok`, `playing`, `url`, `label`, `audio_request`, and a note that the
desktop applies it within one poll. Radio Browser failure falls back to the
curated presets and says so in `note`.

### `aura_watch`

Find something to watch, play the user's pick, report what is playing.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `action` | string enum | yes | `search`, `browse`, `play`, `now`, `save`, `remove`, `list`, `quality` |
| `q` | string | for `search` | What the user wants to watch. |
| `limit` | integer 1..10 | optional | Numbered options; default 6. |
| `category` | string | for `browse` | A catalogue category, e.g. `Anime`, `Classic films`, `Slow TV`. |
| `query` | string | for `browse` | Words from a title or its description; also accepted as an alias of `q` for `search`. |
| `url` | string | for `play` | YouTube watch/`youtu.be`/shorts/embed/playlist, or `.mp4`/`.webm`/`.m3u8`/`.mov`. |
| `label` | string | optional | Title to show. |
| `n` | integer ≥ 1 | for `quality` | The number of the option to play, from the `quality` list. |
| `preference` | `auto` \| `smallest` \| `largest` | for `quality` | The standing rule for new archive.org films (and the switch used now). |

`search` returns `ok`, `query`, `count`, `items` (`n`, title, channel, length,
url), `text` and `next`. `browse` reads `web/catalog.json` (no network, nothing
plays) and returns `ok`, `count`, `items` (`n`, title, year, category, url),
`text` and `next`; with neither `category` nor `query` it returns `categories`
(`category`, `count`) and lists them. `play` returns `ok`, `playing`, `url`,
`label`, `kind`, `seq`, `delivery`. `now` returns `ok`, `running`, `playing`,
`player`, `window`. `quality` with no arguments returns `ok`, `mode`
(`archive`/`youtube`/`single`), `url`, `current`, `preference`, `count`, `items`
(`n`, `label`, `url`, `height`, `size_bytes`, `current`), `text` and a `next`
line; with `n`, `url` or `preference` it queues one `quality` command and
returns `ok`, `mode`, `url`, `label`, `preference`, `position`, `text`. A
YouTube film cannot be switched: it answers `ok: false` with the measured reason
and queues nothing.

## Hooks

Registered in `__init__.py`; every hook is an observer that returns `None`,
swallows its own exceptions, and cannot block or alter a turn.

| Hook | Mood transition |
|---|---|
| `on_session_start` | reset → `idle` |
| `on_session_end` | reset → `idle` |
| `pre_tool_call` | `tool` |
| `post_tool_call` | `thinking`, or `error` when the result failed |
| `pre_approval_request` | `approval` |
| `post_approval_response` | clears `approval` back to the previous mood |
| `api_request_error` | `error` |
| `on_stream_start` | `streaming` |
| `on_stream_end` | `done` |
| `subagent_start` | `thinking` |
| `subagent_stop` | `thinking` |

Moods have attention floors and finite TTLs (`aura_core/mood.py`): `approval`
and `error` never pulse faster than 2 Hz, `done` settles within 1.5 s, and
restore-on-clear returns the previous non-attention mood.

## Slash commands and CLI commands

None. Aura registers tools, hooks, a dashboard router and a Hermes Desktop
surface. The development scripts under `tools/` are not plugin commands.

## Local server routes

Bound to `127.0.0.1` on a free port. Every data route and the WebSocket require
`Authorization: Bearer <token>` (from `~/.hermes/aura/token`); `/`, `/index.html`
and `/api/player/commands` also accept `?token=`, and `POST /api/window/bootstrap`
redeems a short-lived ticket.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` or `/index.html` | The visualiser page (token required). |
| GET | `/healthz` | `ok`, `version`, `pid`, `capture`, `rate`, `clients`. |
| GET | `/api/state` | Latest features, mood, config-derived display state, audio requests. |
| GET | `/api/presets` | The curated preset catalogue. |
| GET | `/api/catalog` | The shelf catalogue from `web/catalog.json` (read once, cached). |
| GET | `/api/config` | Effective config plus the behaviour profile. |
| GET | `/api/player` | Last player report, command sequence, window status. |
| GET | `/api/quality?url=…` | The film's real versions: archive.org `choices` (url, label, size, resolution), YouTube's `auto` answer, or one file. Short timeout, cached per item. |
| GET | `/api/player/commands?after=N` | Queued transport commands after sequence `N`. |
| GET | `/api/window` | Pop-out status; never returns the token. |
| GET | `/api/stream` | WebSocket: binary PCM frames plus JSON feature/event frames. |
| GET | `/api/radio/stream?url=…` | Validated, pinned radio proxy for the page's `<audio>`. |
| POST | `/api/control` | `enabled`, `intensity`, `preset`, `mood`, `opacity`, `behavior`, `motion`, `idle_motion`, `reduced_motion`, `mood_reactive`, `accent_pulse`, `auto_preset`. |
| POST | `/api/mood` | `mood`, `intensity`, `ttl_ms`. |
| POST | `/api/config/push` | Re-broadcast config to connected pages. |
| POST | `/api/audio` | `action` (`play`, `stop`, `volume`, `mute_video`, `unmute_video`), `url`, `label`, optional `value`. |
| POST | `/api/player/report` | The active player reports `url`, `title`, `playing`, `position`, `duration`, `volume`, `muted`, `videoId`, `kind`, `applied`, `last_command`. |
| POST | `/api/player/command` | Queue one of `play`, `pause`, `toggle`, `next`, `prev`, `seek`, `volume`, `load`, `watch_window`, `bring_back`. |
| POST | `/api/window/open` | Open the film in its own OS window; optional `url`, `position`, `videoId`, `label`, `playing`. |
| POST | `/api/window/close` | Close the pop-out. |
| POST | `/api/window/manage` | Open an `http(s)` page (a playlist) in the pop-out. |
| POST | `/api/window/bootstrap` | Redeem the one-time ticket for the window's token. |
| GET | `/favicon.ico` | 204. |
| GET | `/vendor/*`, `/aura.js`, `/audio.js`, `/player.html`, `/presets.json`, `/pcm-worklet.js` | Whitelisted static files, no token, no secrets. |

## Dashboard routes

Mounted by `dashboard/plugin_api.py` under `/api/plugins/aura/`. These are the
only routes the desktop half calls; it never guesses the server port.

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | `ok`, `port`, `url`, `capture`, `enabled`. |
| GET | `/state` | Proxy of the server's `/api/state`. |
| GET | `/player` | Proxy of `/api/player`. |
| GET | `/catalog` | Proxy of `/api/catalog` (the shelf catalogue). |
| GET | `/quality?url=…` | Proxy of `/api/quality` (the film's real versions). |
| GET | `/player/commands?after=N` | Proxy of the command queue. |
| POST | `/player/report` | Forward the player report. |
| POST | `/player/command` | Forward a transport command. |
| GET | `/window` | Pop-out status. |
| POST | `/window/open` | Open the pop-out. |
| POST | `/window/close` | Close the pop-out. |
| GET | `/version` and `/api/v1/version` | Version, commit, commit date, build date, channel, dirty flag. |
| GET | `/playlist?id=…` | Public YouTube playlist episodes (`videoId`, `title`, `length`), cached five minutes. |
| GET | `/search?q=…&limit=…` | Keyless YouTube results. |
| GET | `/radio/search?q=…&tag=…&limit=…` | Radio Browser search; presets on outage. |
| GET | `/radio/popular?limit=…` | Quality-filtered popular stations. |
| GET | `/radio/presets` | Aura's curated starter stations. |
| GET | `/radio/favorites` | Saved stations. |
| POST | `/radio/favorites` | Add or replace one station. |
| DELETE | `/radio/favorites?id=…` | Remove one station. |
| GET | `/radio/resolve?url=…` | Resolve `.pls`/`.m3u` to a validated stream URL. |
| POST | `/control` | Forward to the server's `/api/control`. |

## Configuration keys

The full table with defaults lives in [CONFIGURATION.md](CONFIGURATION.md).
The short list: `enabled`, `listen_background`, `intensity`, `preset`,
`reduced_motion`, `theme_opt_in`, `opacity`, `behavior`, `mood_reactive`,
`accent_pulse`, `auto_preset`, `motion`, `idle_motion`.

Desktop-side appearance keys are NOT in that file: they live in the plugin's own
`settings` storage record and are documented in
[USAGE.md](USAGE.md#make-the-chat-readable-over-a-film). The Readable group writes
four of them — `readable`, `readableSize` (`s`/`m`/`l`/`xl`), `readableFont`
(`system`/`atkinson`/`inter`/`mono`) and `readableInk`
(`white`/`warm`/`yellow`) — and each one becomes a host theme token
(`typography.baseSize`, `typography.lineHeight`, `typography.fontSans`,
`typography.fontUrl`, `colors.foreground`, `colors.mutedForeground`) on the
`aura-live` contribution.

Subtitles live there too: `videoCaptions` (boolean, default `false`) and
`videoCaptionLang` (a language tag such as `fr` or `en-US`; empty means
"the machine's language, then English"). See
[USAGE.md](USAGE.md#subtitles-cc) and §14 of [CONTRACT.md](../CONTRACT.md).

Quality settings: `videoQuality` — the standing rule for archive.org films,
`auto` (the file the source names), `smallest` or `largest`; default `auto`.
A specific choice for the film playing now is the new `videoUrl`, with its
bookmark copied across. See [USAGE.md](USAGE.md#quality) and §15 of
[CONTRACT.md](../CONTRACT.md).

Environment variables: `HERMES_HOME`, `AURA_CAPTURE`, `AURA_RADIO_BROWSER_SERVERS`,
`AURA_DESKTOP_BROWSER`, `AURA_DESKTOP_GPU`, plus `XDG_SESSION_TYPE` /
`WAYLAND_DISPLAY` for detection.

Back to [docs/README.md](README.md).
