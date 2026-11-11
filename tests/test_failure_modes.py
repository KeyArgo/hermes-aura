"""Failure-mode coverage (plan v2 item 5: "survive being broken").

Every test here drives the real capture loop (or a real server) with a fake
backend swapped in through ``capture.open_capture``, exactly the way
``test_null_capture_pacing.py`` and ``test_capture_gate.py`` do.  A fake exposes
``name``, ``read(n)`` and ``close()``; nothing needs a sound card, a device or a
browser.

Covered:

* (a) no audio backend at all -> capture reports "none" and the server still
  serves every endpoint;
* (b) ``read()`` raising -> the loop keeps running, no crash;
* (c) the device disappearing mid-playback -> exactly one ``capture_lost``
  error event, never repeated while the loss lasts;
* (d) a silent stream -> features report silence with level 0;
* (e) reduced motion / the calm profile -> no strobe preset is ever chosen
  (server profile plus the real filter code in web/aura.js).
"""

from __future__ import annotations

import http.client
import json
import shutil
import subprocess
import threading
import time
from pathlib import Path

import pytest

from aura_core import analysis, behavior, config
from aura_core import server
from aura_core.capture import base as capture

ROOT = Path(__file__).resolve().parents[1]


# ---------------------------------------------------------------------------
# fakes / helpers
# ---------------------------------------------------------------------------

def _reset_state() -> None:
    """Start each test from a known capture state (the server keeps globals)."""
    with server._STATE.lock:
        server._STATE.capture_obj = None
        server._STATE.capture_name = "none"
        server._STATE.features = analysis.silence_features()
        server._STATE.feature_seq = 0
        server._STATE.pcm_seq = 0
        server._STATE.capture_lost_reported = False


class FakeCapture:
    """Minimal backend: ``read`` is supplied per test, ``name`` looks real."""

    def __init__(self, read, name: str = "pulse"):
        self.name = name
        self._read = read
        self.closed = False

    def read(self, n: int = capture.FRAME_SAMPLES):
        return self._read(n)

    def close(self) -> None:
        self.closed = True


def _start_loop(monkeypatch, fake, events=None):
    _reset_state()
    monkeypatch.setattr(capture, "open_capture", lambda preferred=None: fake)
    monkeypatch.setattr(server, "_audio_wanted", lambda: True)
    monkeypatch.setattr(server, "publish_config", lambda: None)
    recorded = [] if events is None else events
    monkeypatch.setattr(server, "_broadcast_event", lambda obj: recorded.append(dict(obj)))
    stop = threading.Event()
    worker = threading.Thread(target=server._capture_loop, args=(stop,), daemon=True)
    worker.start()
    return worker, stop, recorded


def _stop_loop(worker, stop) -> None:
    stop.set()
    worker.join(2)
    assert not worker.is_alive()


def _frames_since(start: int) -> int:
    with server._STATE.lock:
        return server._STATE.pcm_seq - start


def _pcm_seq() -> int:
    with server._STATE.lock:
        return server._STATE.pcm_seq


def http_get(port: int, path: str, token: str):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", path, headers={"Authorization": f"Bearer {token}"})
    resp = conn.getresponse()
    payload = resp.read()
    conn.close()
    return resp.status, json.loads(payload.decode("utf-8"))


# ---------------------------------------------------------------------------
# (a) no audio backend found: report "none", keep serving
# ---------------------------------------------------------------------------

@pytest.fixture()
def server_without_audio(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("AURA_CAPTURE", "")

    def no_backend(preferred=None):
        raise ImportError("no sounddevice module and no pactl on this host")

    monkeypatch.setattr(capture, "open_capture", no_backend)
    server.stop_server()
    server.ensure_server()
    port = server.get_port()
    token = server.get_token()
    assert port and token, "server did not start with a broken capture backend"
    try:
        yield {"port": port, "token": token}
    finally:
        server.stop_server()


def test_no_audio_backend_reports_none_and_keeps_serving(server_without_audio):
    port, token = server_without_audio["port"], server_without_audio["token"]

    # The capture thread must survive the failed probe and keep pacing silence:
    # a frozen pcm_seq would mean the loop died and only the startup value
    # ("none") is left behind.
    start = _pcm_seq()
    time.sleep(0.4)
    thread = server._STATE.capture_thread
    assert thread is not None and thread.is_alive(), "the capture thread died on a missing backend"
    assert _frames_since(start) > 3, "the loop stopped publishing silence frames"

    status, health = http_get(port, "/healthz", token)
    assert status == 200
    assert health["ok"] is True
    assert health["capture"] == "none"

    # Serving continues: features are silent, not missing.
    status, state = http_get(port, "/api/state", token)
    assert status == 200
    assert state["silence"] is True
    assert state["level"] == 0.0
    assert len(state["bands"]) == 8

    status, cfg = http_get(port, "/api/config", token)
    assert status == 200
    assert cfg["capture"] == "none"


# ---------------------------------------------------------------------------
# (b) the capture read raises: the loop survives
# ---------------------------------------------------------------------------

def test_capture_read_exception_does_not_kill_the_loop(monkeypatch):
    def boom(n):
        time.sleep(0.01)
        raise RuntimeError("device unplugged")

    worker, stop, events = _start_loop(monkeypatch, FakeCapture(boom))
    start = _pcm_seq()
    time.sleep(0.6)
    assert worker.is_alive(), "the capture loop died on a raising backend"
    frames = _frames_since(start)
    with server._STATE.lock:
        feat = dict(server._STATE.features)
    _stop_loop(worker, stop)

    assert frames > 5, frames  # silence keeps flowing to the page
    assert feat["silence"] is True
    assert feat["level"] == 0.0
    assert events, "features must still be published while read() raises"


# ---------------------------------------------------------------------------
# (c) the device disappears mid-playback: one capture_lost, never repeated
# ---------------------------------------------------------------------------

def test_device_lost_mid_playback_reports_capture_lost_once(monkeypatch):
    opened = time.monotonic()

    def read(n):
        time.sleep(0.02)
        if time.monotonic() - opened < 0.2:
            return b"\x01\x00\x00\x00" * n
        return None  # the device is gone

    worker, stop, events = _start_loop(monkeypatch, FakeCapture(read))
    start = _pcm_seq()
    time.sleep(3.0)  # the loss threshold is >2 s of no data

    lost = [e for e in events if e.get("code") == "capture_lost"]
    assert len(lost) == 1, lost
    assert lost[0]["type"] == "error"
    assert lost[0]["message"]
    assert worker.is_alive(), "losing the device must not stop the loop"
    assert _frames_since(start) > 50  # silence keeps the page alive

    # Still lost: the error is not repeated.
    time.sleep(0.6)
    assert len([e for e in events if e.get("code") == "capture_lost"]) == 1
    _stop_loop(worker, stop)


# ---------------------------------------------------------------------------
# (d) silence: silence flag true, level 0
# ---------------------------------------------------------------------------

def test_silent_stream_publishes_silent_features(monkeypatch):
    def zeros(n):
        time.sleep(0.01)
        return b"\x00" * (n * 4)

    worker, stop, events = _start_loop(monkeypatch, FakeCapture(zeros))
    time.sleep(0.7)
    assert worker.is_alive()
    with server._STATE.lock:
        feat = dict(server._STATE.features)
    _stop_loop(worker, stop)

    assert feat["silence"] is True
    assert feat["level"] == 0.0
    assert all(b == 0.0 for b in feat["bands"])
    assert feat["onset"] is False

    features = [e for e in events if e.get("type") == "features"]
    assert features, "no features event was published"
    assert features[-1]["silence"] is True
    assert features[-1]["level"] == 0.0


# ---------------------------------------------------------------------------
# (e) reduced_motion / calm never pick strobe presets
# ---------------------------------------------------------------------------

def _preset_catalogue() -> dict:
    return json.loads((ROOT / "web" / "presets.json").read_text(encoding="utf-8"))


def test_calm_and_reduced_motion_are_published_strobe_free(monkeypatch):
    catalogue = _preset_catalogue()
    strobe_presets = [p["name"] for p in catalogue["presets"] if p.get("strobe")]
    assert strobe_presets, "no preset is flagged strobe: the filter has nothing to filter"
    calm_family = behavior.profile("calm")["preset_family"]
    calm_pool = [p for p in catalogue["presets"]
                 if p.get("family") == calm_family and not p.get("strobe")]
    assert calm_pool, f"calm family {calm_family!r} has no non-strobe preset to fall back to"

    cfg = config.normalise({"behavior": "calm", "reduced_motion": True})
    monkeypatch.setattr(server.config, "load_config", lambda: cfg)
    event = server._config_event()
    assert event["reduced_motion"] is True
    profile = event["behavior_profile"]
    assert profile["allow_strobe"] is False
    assert profile["hard_pulse"] is False
    assert profile["preset_family"] == calm_family


_HARNESS = r"""
import fs from 'node:fs';

const [auraPath, presetsPath, profilesPath, combosPath] = process.argv.slice(2);
const src = fs.readFileSync(auraPath, 'utf8');
const catalogue = JSON.parse(fs.readFileSync(presetsPath, 'utf8'));
const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
const combos = JSON.parse(fs.readFileSync(combosPath, 'utf8'));

function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('aura.js: function ' + name + ' not found');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('aura.js: unbalanced body for ' + name);
}

const NAMES = ['strobeAllowed', 'allowedPresets', 'availableAllowedPresets',
               'pickPresetForFamily', 'pickInitialPreset', 'loadPresetByName'];
const body = NAMES.map(extract).join('\n');

const presets = (catalogue.presets || []).map((p) => ({
  name: String(p.name), family: String(p.family || 'misc'), strobe: !!p.strobe }));
const byName = Object.create(null);
for (const p of presets) byName[p.name] = p;

const state = { reducedMotion: false, autoPreset: true, presetName: null,
                presetFamily: null, presetStrobe: false, presetAnchor: null };
const catalog = { presets, byName,
                  default: typeof catalogue.default === 'string' ? catalogue.default : null };
let active = null;
const activeProfile = () => active;
const viz = { loadPreset() {} };
const presetMap = () => { const m = {}; for (const p of presets) m[p.name] = {}; return m; };
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const recordError = () => {};

const api = new Function('state', 'catalog', 'activeProfile', 'viz', 'presetMap',
  'num', 'clamp', 'recordError',
  body + '\nreturn { strobeAllowed, allowedPresets, pickPresetForFamily, pickInitialPreset, loadPresetByName };'
)(state, catalog, activeProfile, viz, presetMap, num, clamp, recordError);

const strobeName = (presets.find((p) => p.strobe) || {}).name || null;
const out = [];
for (const combo of combos) {
  active = profiles[combo.profile];
  state.reducedMotion = !!combo.reduced_motion;
  state.presetName = null;
  state.presetFamily = null;
  state.presetStrobe = false;
  state.presetAnchor = null;
  const allowed = api.allowedPresets().map((p) => p.name);
  const allowedStrobe = allowed.filter((n) => byName[n] && byName[n].strobe);
  const initial = api.pickInitialPreset();
  const familyPick = api.pickPresetForFamily(active.preset_family);
  const strobeAccepted = strobeName ? api.loadPresetByName(strobeName, 1200) : null;
  out.push({
    profile: combo.profile,
    reduced_motion: !!combo.reduced_motion,
    strobe_allowed: api.strobeAllowed(),
    allowed_strobe: allowedStrobe,
    initial,
    initial_strobe: initial ? !!byName[initial].strobe : null,
    family_pick: familyPick,
    family_pick_strobe: familyPick ? !!byName[familyPick].strobe : null,
    strobe_load_accepted: strobeAccepted,
    final_strobe: !!state.presetStrobe
  });
}
process.stdout.write(JSON.stringify(out));
"""


def test_reduced_motion_and_calm_never_pick_strobe_presets(tmp_path):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed: the page-side preset filter cannot be exercised")

    combos = [
        {"profile": "calm", "reduced_motion": True},
        {"profile": "calm", "reduced_motion": False},
        {"profile": "balanced", "reduced_motion": True},
        {"profile": "intense", "reduced_motion": True},
        {"profile": "balanced", "reduced_motion": False},
        {"profile": "intense", "reduced_motion": False},
    ]
    profiles = {name: behavior.profile(name) for name in behavior.BEHAVIORS}
    harness = tmp_path / "aura_preset_probe.mjs"
    harness.write_text(_HARNESS, encoding="utf-8")
    profiles_path = tmp_path / "profiles.json"
    profiles_path.write_text(json.dumps(profiles), encoding="utf-8")
    combos_path = tmp_path / "combos.json"
    combos_path.write_text(json.dumps(combos), encoding="utf-8")

    completed = subprocess.run(
        [node, str(harness), str(ROOT / "web" / "aura.js"), str(ROOT / "web" / "presets.json"),
         str(profiles_path), str(combos_path)],
        capture_output=True, text=True, timeout=60,
    )
    assert completed.returncode == 0, completed.stderr
    results = json.loads(completed.stdout)
    assert len(results) == len(combos)

    by_combo = {(r["profile"], r["reduced_motion"]): r for r in results}
    for combo in combos:
        result = by_combo[(combo["profile"], combo["reduced_motion"])]
        if combo["reduced_motion"] or combo["profile"] == "calm":
            where = f"{combo['profile']} reduced_motion={combo['reduced_motion']}"
            assert result["strobe_allowed"] is False, where
            assert result["allowed_strobe"] == [], where
            assert result["initial_strobe"] is False, where
            assert result["family_pick_strobe"] is False, where
            assert result["strobe_load_accepted"] is False, where
            assert result["final_strobe"] is False, where
        else:
            # Sanity: without the restriction strobe presets really are in play,
            # so the assertions above are not passing on an empty pool.
            assert result["allowed_strobe"], result
            assert result["strobe_load_accepted"] is True, result
