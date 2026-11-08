# Claude (Opus 5.5): council answer

1. **Make the agent-mood moment unmissable (Creativity + Usefulness, ~6 h).** Right now mood shifts are
   subtle and only steer presets/accent. Give each agent state one distinct, readable signature on the
   backdrop: approval waiting = a slow warm "breathing" frame plus a song-title style caption
   ("Hermes needs your OK", via Butterchurn `launchSongTitleAnim`); tool running = faster motion;
   error = a short desaturate; done = a bloom, then settle. This is the only thing no other visualizer
   has, and it reads with the video muted.
2. **Reliability proof on the exact submission revision (~5 h).** Commit tonight's work; clean-profile
   install rehearsal; scripted checks for silence, no capture, reconnect after gateway restart, and
   enable/disable/theme-restore; record the evidence (screenshots + log lines) in docs/STATUS.md, and
   delete the stale claims there. Add the missing regression test for the stale-enabled bug.
3. **Studio, minimal (~8 h).** A closable panel (X/Esc/outside click) with a live preview, design
   browser (search, favourites, lock, next), auto-switch + blend time, and the existing sound controls.
   Remove the stage page + side pane. Skip quality knobs, colour modes and .milk import until after the
   deadline. Port REVamp's MilkDrop UX ideas, not its Webamp window.
4. **Readability/safety polish (~3 h).** Check chat legibility at the default visibility on 2-3 Hermes
   themes, reduced-motion respected, flash cap verified, one-click off (palette command + keybind).
5. **Honest scope.** Claim Linux. Windows "experimental, community-tested" only if the owner's PC test
   passes; macOS "needs BlackHole" in the README.

Split: day 1 reliability + commit, day 2 agent-mood signatures + demo capture, day 3 Studio minimal,
day 4 polish, rehearsal, video, submit. Studio is the most visible to the owner but the least
differentiating to judges.

**Cut:** extra preset packs, .milk import, colour engine, the out-of-process capture refactor (do it
after the deadline; the busy-loop fix already removed the freeze).

**60-second demo:** Hermes chatting normally with music → `/skin aura-live`, the app comes alive
behind the chat → ask the agent a task that needs approval: the backdrop warms and breathes with the
caption "Hermes needs your OK" → approve: it blooms and settles → music stops: designs keep drifting
gently → open Studio, lock a favourite design, close with Esc → switch theme back: Hermes looks exactly
as before.

**Risk not seen:** the theme depends on overriding undocumented Hermes CSS variables and a
click-through iframe; judges may run a newer Hermes Desktop where that breaks. Pin the tested Hermes
version in the README and have the plugin degrade to a plain theme (no backdrop) if the probe fails.
Second risk: two Aura servers with one shared token file → intermittent "unauthorized" depending on
which instance wrote last (seen tonight).
