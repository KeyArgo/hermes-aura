# Hermes issues Aura would like to open

Two requests came out of Nous' review of Aura at `90e8b80`. Both are seams the
plugin needed and could not reach through a public API, so the features they
carried were removed rather than kept on a private import. Drafted here instead
of being filed, per the review instructions.

---

## 1. A "backdrop" area for desktop plugins

**What:** a contribution area that renders a plugin's component behind the app's
panes — full-bleed, under the chat/sidebar surfaces, above the window
background.

**Why:** Aura's first feature is a film or a visualiser *behind* your work. The
SDK has panes, pages, routes, the composer, status bar, title bar and themes, but
no surface that sits behind the layout. The only way to draw there today is to
create an `<iframe>` and append it to the app's body with `position: fixed`, which
is app markup no plugin owns — exactly what the review asked us to stop doing.

**What we did instead:** the film and the visualiser now render inside Aura's own
pane, page and pop-out window via `<SandboxedFrame>`. Full-bleed "behind the app"
is gone until there is a slot for it.

**Sketch:**

```ts
// a new area, next to `panes` / `routes`
ctx.register({
  id: 'backdrop',
  area: BACKDROP_AREA,          // 'backdrop'
  data: {
    // the plugin promises it is decoration: no pointer events, no focus
    interactive: false,
    opacityToken: '--plugin-backdrop-opacity'   // host-applied, so the host can
                                                // fade it without plugin styles
  },
  render: () => jsx(SandboxedFrame, { src, title: 'Aura' })
})
```

Host obligations that would make it safe: `pointer-events: none`, not focusable,
hidden while a modal or an approval is up, and torn down with the plugin.

---

## 2. A public active-session count

**What:** a supported way to ask "how many chat sessions are open right now?" —
e.g. `host.state.activeSessionCount` (atom) or a `sessions.activeCount` RPC.

**Why:** Aura used to make the visuals louder as more chats were open. It read
`hermes_cli.active_sessions.active_session_registry_snapshot()` and, when that
import failed, `<HERMES_HOME>/runtime/active_sessions.json` directly. Both are
private: the module moves on any release, and the file layout is nobody's
promise.

**What we did instead:** the per-chat boost is gone; `session_boost` is published
as a constant `1.0` so the wire shape the pages read does not change. The number
of open chats no longer affects the visual.

**Sketch:** an atom the host already knows, next to `busyBySession`:

```ts
host.state.activeSessionCount   // number, reactive
```

Cheap to maintain — the registry the app already keeps is the source — and it
unlocks a visual that is otherwise a private-import temptation for every
"react to what the agent is doing" plugin.
