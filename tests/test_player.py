"""The film endpoints: player reports, the command queue, and the pop-out.

The window itself is faked (no browser is launched); what is proved here is the
wire: report merge, seq ordering, query-token auth for the window's own page,
and the agent-facing window endpoints.
"""

from __future__ import annotations

import http.client
import json
from pathlib import Path

import pytest

from aura_core import server


@pytest.fixture()
def live(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("AURA_CAPTURE", "none")
    server.stop_server()
    server.ensure_server()
    port = server.get_port()
    token = server.get_token()
    assert port and token, "server did not start"
    try:
        yield {"port": port, "token": token, "home": tmp_path}
    finally:
        server.stop_server()


def call(port, method, path, token=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(data))
    conn.request(method, path, body=data, headers=headers)
    resp = conn.getresponse()
    payload = resp.read()
    conn.close()
    return resp.status, json.loads(payload.decode("utf-8") or "{}")


# ---------------------------------------------------------------------------
# the player report
# ---------------------------------------------------------------------------

def test_report_is_merged_and_readable(live):
    port, token = live["port"], live["token"]
    status, body = call(port, "POST", "/api/player/report", token, {
        "url": "https://example.test/film.mp4", "playing": True,
        "position": 12.5, "duration": 600, "title": "Octopus", "desktop": True,
    })
    assert status == 200 and body["ok"] is True
    assert isinstance(body["seq"], int) and body["seq"] >= 1

    status, payload = call(port, "GET", "/api/player", token)
    assert status == 200
    player = payload["player"]
    assert player["url"] == "https://example.test/film.mp4"
    assert player["playing"] is True
    assert player["position"] == 12.5
    assert player["title"] == "Octopus"
    assert player["desktop"] is True
    assert player["ts"] > 0

    # A second report omitting title keeps what was known.
    call(port, "POST", "/api/player/report", token, {"playing": False, "position": 20})
    _s, payload = call(port, "GET", "/api/player", token)
    assert payload["player"]["playing"] is False
    assert payload["player"]["position"] == 20.0
    assert payload["player"]["title"] == "Octopus"


def test_report_carries_an_unapplied_transport_command(live):
    # [finding 7] A single-file film cannot skip; the page says so and the
    # agent's next status must be able to read it instead of guessing.
    port, token = live["port"], live["token"]
    status, _body = call(port, "POST", "/api/player/report", token, {
        "url": "https://example.test/film.mp4", "kind": "video",
        "applied": False, "last_command": "next",
    })
    assert status == 200
    _status, payload = call(port, "GET", "/api/player", token)
    assert payload["player"]["applied"] is False
    assert payload["player"]["last_command"] == "next"


def test_report_rejects_non_object(live):
    port, token = live["port"], live["token"]
    status, body = call(port, "POST", "/api/player/report", token, [1, 2])
    assert status == 400
    assert body["ok"] is False


def test_player_page_reports_whether_a_transport_command_applied():
    # [finding 7] The page itself is what knows a single-file film has no
    # next/prev; a static check keeps that wire from being dropped silently.
    html = (Path(__file__).resolve().parents[1] / "web" / "player.html").read_text()
    assert "markCommand(name, canSkip)" in html
    assert "applied: lastApplied" in html
    assert "last_command: lastCommand" in html


def test_player_page_may_report_with_the_query_token(live):
    port, token = live["port"], live["token"]
    status, body = call(port, "POST", f"/api/player/report?token={token}",
                        None, {"playing": True, "position": 3})
    assert status == 200 and body["ok"] is True


def test_player_page_without_any_token_is_refused(live):
    port = live["port"]
    status, body = call(port, "POST", "/api/player/report", None, {"playing": True})
    assert status == 401 and body["error"] == "unauthorized"


# ---------------------------------------------------------------------------
# subtitles (CC)
# ---------------------------------------------------------------------------

def test_player_page_has_one_caption_rule_and_no_hand_written_query():
    # The embed query and the toggle commands are decided in web/captions.js so
    # the page cannot drift from the thing the tests exercise. cc_load_policy and
    # loadModule/unloadModule therefore appear nowhere in the page itself.
    root = Path(__file__).resolve().parents[1]
    page = (root / "web" / "player.html").read_text()
    assert '<script src="captions.js"></script>' in page
    assert "AuraCaptions.embedParams(" in page
    assert "AuraCaptions.commands(" in page
    assert "cc_load_policy" not in page, "the page hand-writes the caption query"
    assert "loadModule" not in page and "unloadModule" not in page, \
        "the page hand-writes the caption commands"
    rule = (root / "web" / "captions.js").read_text()
    assert "cc_load_policy" in rule and "loadModule" in rule and "unloadModule" in rule


def test_captions_rule_file_is_served(live):
    # The page loads it by relative path; an unlisted file is a 404, so the
    # static whitelist is part of the feature.
    port = live["port"]
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", "/captions.js")
    resp = conn.getresponse()
    body = resp.read().decode("utf-8")
    conn.close()
    assert resp.status == 200
    assert "text/javascript" in (resp.getheader("Content-Type") or "")
    assert "AuraCaptions" in body


def test_command_queue_carries_the_captions_switch(live):
    port, token = live["port"], live["token"]
    status, body = call(port, "POST", "/api/player/command", token,
                        {"cmd": "captions", "value": 1})
    assert status == 200 and body["ok"] is True
    _s, listing = call(port, "GET", "/api/player/commands?after=0", token)
    assert listing["commands"][-1]["cmd"] == "captions"
    assert listing["commands"][-1]["value"] == 1
    # A language travels with it, validated as a language code.
    status, _body = call(port, "POST", "/api/player/command", token,
                         {"cmd": "captions", "value": 1, "lang": "fr"})
    assert status == 200
    _s, listing = call(port, "GET", f"/api/player/commands?after={body['seq']}", token)
    assert listing["commands"][-1]["lang"] == "fr"
    status, _body = call(port, "POST", "/api/player/command", token,
                         {"cmd": "captions", "value": 1, "lang": "fr; drop"})
    assert status == 200
    _s, listing = call(port, "GET", "/api/player/commands?after=0", token)
    assert "lang" not in listing["commands"][-1], "a junk language code was queued"


# ---------------------------------------------------------------------------
# the command queue
# ---------------------------------------------------------------------------

def test_commands_are_ordered_and_cursor_is_exclusive(live):
    port, token = live["port"], live["token"]
    seqs = []
    for cmd, extra in (("pause", {}), ("next", {}), ("seek", {"value": 90.0})):
        status, body = call(port, "POST", "/api/player/command", token,
                            {"cmd": cmd, **extra})
        assert status == 200 and body["ok"] is True
        seqs.append(body["seq"])
    assert seqs == sorted(seqs) and len(set(seqs)) == 3

    _s, first = call(port, "GET", "/api/player/commands?after=0", token)
    assert [c["cmd"] for c in first["commands"]] == ["pause", "next", "seek"]
    assert [c["seq"] for c in first["commands"]] == seqs

    _s, later = call(port, "GET", f"/api/player/commands?after={seqs[0]}", token)
    assert [c["cmd"] for c in later["commands"]] == ["next", "seek"]

    _s, none = call(port, "GET", f"/api/player/commands?after={seqs[-1]}", token)
    assert none["commands"] == []
    assert none["seq"] == seqs[-1]


def test_command_queue_polls_with_the_query_token(live):
    port, token = live["port"], live["token"]
    call(port, "POST", "/api/player/command", token, {"cmd": "pause"})
    status, body = call(port, "GET", f"/api/player/commands?after=0&token={token}")
    assert status == 200
    assert [c["cmd"] for c in body["commands"]] == ["pause"]


def test_commands_query_without_token_is_refused(live):
    port = live["port"]
    status, _body = call(port, "GET", "/api/player/commands?after=0")
    assert status == 401


@pytest.mark.parametrize("body", [
    {"cmd": "explode"},
    {"cmd": "seek"},
    {"cmd": "seek", "value": "soon"},
    {"cmd": "volume"},
    {"cmd": "load"},
    {"cmd": "save"},
    {"cmd": "remove"},
    {},
])
def test_bad_commands_are_rejected(live, body):
    status, payload = call(live["port"], "POST", "/api/player/command",
                           live["token"], body)
    assert status == 400
    assert payload["ok"] is False


def test_library_commands_are_queued_with_their_url(live):
    """save/remove reach the desktop on the same queue."""
    token, port = live["token"], live["port"]
    _s, saved = call(port, "POST", "/api/player/command", token,
                     {"cmd": "save", "url": "https://example.test/octopus.mp4",
                      "label": "Secrets of the Octopus"})
    assert saved["ok"] is True
    _s, removed = call(port, "POST", "/api/player/command", token,
                       {"cmd": "remove", "url": "https://example.test/octopus.mp4"})
    assert removed["ok"] is True
    assert removed["seq"] > saved["seq"]
    _s, queued = call(port, "GET", f"/api/player/commands?after={saved['seq'] - 1}&token={token}")
    assert [(c["cmd"], c.get("url")) for c in queued["commands"]] == [
        ("save", "https://example.test/octopus.mp4"),
        ("remove", "https://example.test/octopus.mp4"),
    ]
    assert queued["commands"][0]["label"] == "Secrets of the Octopus"


def test_a_reported_library_is_readable_and_sanitised(live):
    """The desktop's saved list rides the player report."""
    port, token = live["port"], live["token"]
    status, _body = call(port, "POST", "/api/player/report", token, {
        "library": [
            {"label": "Full octopus documentaries", "kind": "playlist",
             "url": "https://www.youtube.com/playlist?list=PLabcdefghijklmnop"},
            {"label": "  ", "url": "https://example.test/octopus.mp4"},
            {"label": "no url"},
            "junk",
        ]})
    assert status == 200
    status, body = call(port, "GET", "/api/player", token)
    assert status == 200
    assert body["library"] == [
        {"label": "Full octopus documentaries", "kind": "playlist",
         "url": "https://www.youtube.com/playlist?list=PLabcdefghijklmnop"},
        # A missing label falls back to the url; a missing kind is a film.
        {"label": "https://example.test/octopus.mp4", "kind": "film",
         "url": "https://example.test/octopus.mp4"},
    ]


def test_no_library_before_the_first_report(live):
    _s, body = call(live["port"], "GET", "/api/player", live["token"])
    assert body["library"] is None


def test_volume_is_clamped(live):
    _s, body = call(live["port"], "POST", "/api/player/command", live["token"],
                    {"cmd": "volume", "value": 4})
    assert body["command"]["value"] == 1.0


def test_queue_is_bounded(live):
    port, token = live["port"], live["token"]
    for _ in range(server.MAX_QUEUED_COMMANDS + 5):
        call(port, "POST", "/api/player/command", token, {"cmd": "toggle"})
    _s, payload = call(port, "GET", "/api/player/commands?after=0", token)
    assert len(payload["commands"]) == server.MAX_QUEUED_COMMANDS
    newest = payload["commands"][-1]["seq"]
    assert newest == server._STATE.command_seq


# ---------------------------------------------------------------------------
# the pop-out window endpoints
# ---------------------------------------------------------------------------

def test_window_status_answers_without_a_browser(live, monkeypatch):
    monkeypatch.setattr(server.desktop_window, "find_browser", lambda: None)
    status, body = call(live["port"], "GET", "/api/window", live["token"])
    assert status == 200
    assert body["ok"] is True
    assert body["open"] is False
    assert body["available"] is False
    assert "token" not in json.dumps(body)


def test_window_open_refuses_with_no_film(live):
    status, body = call(live["port"], "POST", "/api/window/open", live["token"], {})
    assert status == 400
    assert "no film" in body["error"]


def test_window_open_reports_a_missing_browser(live, monkeypatch):
    def no_browser(*args, **kwargs):
        raise server.desktop_window.WindowError("no Chrome or Chromium found")

    monkeypatch.setattr(server.desktop_window, "open_window", no_browser)
    status, body = call(live["port"], "POST", "/api/window/open", live["token"],
                        {"url": "https://example.test/film.mp4"})
    assert status == 503
    assert body["ok"] is False
    assert "Chrome" in body["error"]


def test_window_open_passes_token_and_position(live, monkeypatch):
    seen = {}

    def fake_open(port, token, url, position=0.0, label=""):
        seen.update(port=port, token=token, url=url, position=position, label=label)
        return {"open": True, "already": False, "url": url, "pid": 1234}

    monkeypatch.setattr(server.desktop_window, "open_window", fake_open)
    monkeypatch.setattr(server.desktop_window, "status",
                        lambda: {"open": True, "available": True, "url": "", "pid": 1234,
                                 "browser": "chromium"})
    status, body = call(live["port"], "POST", "/api/window/open", live["token"],
                        {"url": "https://example.test/film.mp4", "position": 42,
                         "label": "Octopus"})
    assert status == 200 and body["ok"] is True
    assert seen["port"] == live["port"]
    assert seen["token"] == live["token"]
    assert seen["url"] == "https://example.test/film.mp4"
    assert seen["position"] == 42.0
    assert seen["label"] == "Octopus"
    assert body["window"]["open"] is True
    assert live["token"] not in json.dumps(body)


def test_window_open_falls_back_to_the_reported_film(live, monkeypatch):
    seen = {}

    def fake_open(port, token, url, position=0.0, label=""):
        seen["url"] = url
        return {"open": True, "already": False, "url": url, "pid": 1}

    monkeypatch.setattr(server.desktop_window, "open_window", fake_open)
    monkeypatch.setattr(server.desktop_window, "status", lambda: {"open": True, "available": True})
    call(live["port"], "POST", "/api/player/report", live["token"],
         {"url": "https://example.test/reported.mp4"})
    status, _body = call(live["port"], "POST", "/api/window/open", live["token"], {})
    assert status == 200
    assert seen["url"] == "https://example.test/reported.mp4"


@pytest.mark.parametrize("url,needle", [
    ("ftp://example.test/film.mp4", "http(s)"),
    ("file:///tmp/film.mp4", "http(s)"),
])
def test_window_open_rejects_a_non_http_film(live, url, needle):
    # [finding 8] Chrome loads this URL itself, so only http(s) is safe.
    status, body = call(live["port"], "POST", "/api/window/open", live["token"],
                        {"url": url})
    assert status == 400
    assert needle in body["error"]


def test_window_open_rejects_auras_own_token_url(live):
    # [finding 8] The token-bearing player URL is not a film; it also points
    # the window back at the server, which is never what popout means.
    own = f"http://127.0.0.1:{live['port']}/?token={live['token']}"
    status, body = call(live["port"], "POST", "/api/window/open", live["token"],
                        {"url": own})
    assert status == 400
    assert "own page" in body["error"]


def test_window_open_allows_another_lan_film(live, monkeypatch):
    seen = {}

    def fake_open(port, token, url, position=0.0, label=""):
        seen["url"] = url
        return {"open": True, "already": False, "url": url, "pid": 1}

    monkeypatch.setattr(server.desktop_window, "open_window", fake_open)
    monkeypatch.setattr(server.desktop_window, "status",
                        lambda: {"open": True, "available": True})
    status, _body = call(live["port"], "POST", "/api/window/open", live["token"],
                         {"url": "http://192.168.1.5:8080/nas/film.mp4"})
    assert status == 200
    assert seen["url"] == "http://192.168.1.5:8080/nas/film.mp4"


def test_window_close_reports_what_happened(live, monkeypatch):
    monkeypatch.setattr(server.desktop_window, "close_window", lambda: True)
    monkeypatch.setattr(server.desktop_window, "status",
                        lambda: {"open": False, "available": True})
    status, body = call(live["port"], "POST", "/api/window/close", live["token"], {})
    assert status == 200
    assert body == {"ok": True, "closed": True,
                    "window": {"open": False, "available": True}}


def test_window_open_needs_the_bearer_token(live):
    status, body = call(live["port"], "POST", "/api/window/open", None,
                        {"url": "https://example.test/film.mp4"})
    assert status == 401


def test_queue_exposes_head_for_new_consumers():
    queued = server.enqueue_command({'cmd': 'pause'})
    assert server.pending_commands(0)['head_seq'] == queued['seq']


def test_window_receives_reported_playlist_episode(monkeypatch):
    seen = {}
    def fake_open(port, token, url, **kwargs):
        seen.update(kwargs)
        return {'open': True}
    monkeypatch.setattr(server.desktop_window, 'open_window', fake_open)
    monkeypatch.setattr(server.desktop_window, 'status', lambda: {'open': True})
    monkeypatch.setattr(server._STATE, 'port', 4321)
    server.report_player({'url': 'https://youtube.com/playlist?list=abc',
                          'videoId': 'abcdefghijk', 'position': 42})
    server.open_window({})
    assert seen['video_id'] == 'abcdefghijk'
    assert seen['position'] == 42


def test_desktop_queue_skips_history_and_acknowledges_load():
    """Exercise the actual page poller with delayed and overlapping responses."""
    import subprocess
    from pathlib import Path
    page = (Path(__file__).resolve().parents[1] / 'web/player.html').read_text()
    start = page.index('  function pollDesktopCommands() {')
    end = page.index('\n  function startDesktopMode()', start)
    script = '''
let desktopMode = true, authToken = 'x', commandCursor = null, commandPolling = false;
let calls = [], applied = [], replies = [];
function desktopApi(path) { calls.push(path); return new Promise(resolve => replies.push(resolve)); }
function applyDesktopCommand(command) { applied.push(command.seq); }
''' + page[start:end] + '''
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  pollDesktopCommands(); pollDesktopCommands();
  if (calls.length !== 1) throw Error('overlapping polls');
  replies.shift()({head_seq: 2, commands: [{seq: 1, cmd: 'pause'}, {seq: 2, cmd: 'load'}]});
  await tick();
  if (applied.length || commandCursor !== 2) throw Error('replayed history');
  pollDesktopCommands();
  replies.shift()({head_seq: 4, commands: [{seq: 2, cmd: 'pause'}, {seq: 3, cmd: 'load'}, {seq: 4, cmd: 'play'}]});
  await tick();
  if (String(applied) !== '3' || commandCursor !== 3) throw Error('load not acknowledged before navigation');
})().catch(e => { console.error(e); process.exitCode = 1; });
'''
    result = subprocess.run(['node', '-e', script], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_changing_reported_source_clears_old_episode():
    server.report_player({'url': 'https://example.test/first', 'videoId': 'abcdefghijk'})
    server.report_player({'url': 'https://example.test/second'})
    assert not server.player_payload()['player'].get('videoId')


def test_bootstrap_ticket_is_single_use(live):
    ticket = server.desktop_window.issue_ticket(live['token'])
    status, result = call(live['port'], 'POST', '/api/window/bootstrap', body={'ticket': ticket})
    assert status == 200 and result['token'] == live['token']
    status, _ = call(live['port'], 'POST', '/api/window/bootstrap', body={'ticket': ticket})
    assert status == 401


def test_bootstrap_ticket_expires(monkeypatch):
    monkeypatch.setattr(server.desktop_window, 'TICKET_TTL', 0)
    ticket = server.desktop_window.issue_ticket('secret')
    assert server.desktop_window.redeem_ticket(ticket) is None


def test_desktop_reload_reuses_session_credential_without_url_token():
    import subprocess
    from pathlib import Path
    page = (Path(__file__).resolve().parents[1] / 'web/player.html').read_text()
    start = page.index('  var desktopMode =')
    end = page.index('  var commandCursor =', start)
    script = '''
const params = new URLSearchParams('desktop=1');
const sessionStorage = { getItem: () => 'session-secret' };
''' + page[start:end] + '''
if (authToken !== 'session-secret') throw Error('reload lost its credential');
'''
    result = subprocess.run(['node', '-e', script], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
