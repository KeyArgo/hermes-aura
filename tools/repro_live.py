#!/usr/bin/env python3
"""Reproduce the Aura backdrop freeze against a live/local server page over raw CDP.

Usage:
  repro_live.py <url> [--seconds 100] [--interval 5] [--gl swiftshader|angle]
Samples window.__aura snapshots, console errors/exceptions, a full-page
screenshot hash and a WebGL readPixels hash (no forced render) every interval.
"""
import base64, hashlib, json, os, shutil, subprocess, sys, tempfile, time, urllib.parse, urllib.request
import websocket

CHROME_CANDIDATES = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
                     "google-chrome", "chromium", "chromium-browser"]

def chrome_binary():
    for c in CHROME_CANDIDATES:
        if os.path.isabs(c) and os.path.exists(c): return c
        p = shutil.which(c)
        if p: return p
    raise RuntimeError("no chrome")

class Tab:
    def __init__(self, ws_url, target_id, debug_port):
        self.ws = websocket.create_connection(ws_url, timeout=60)
        self.target_id = target_id; self.debug_port = debug_port; self._seq = 0
        self.events = []
    def send(self, method, params=None):
        self._seq += 1
        msg = {"id": self._seq, "method": method}
        if params is not None: msg["params"] = params
        self.ws.send(json.dumps(msg))
        while True:
            raw = self.ws.recv()
            reply = json.loads(raw)
            if reply.get("id") == self._seq:
                if "error" in reply: raise AssertionError("%s failed: %s" % (method, reply["error"]))
                return reply.get("result", {})
            if "method" in reply: self.events.append(reply)
    def ev(self, expr):
        r = self.send("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True})
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            raise AssertionError("JS exception: %s %s" % (d.get("text"), d.get("exception", {}).get("description")))
        return r.get("result", {}).get("value")
    def close(self):
        try:
            urllib.request.urlopen(urllib.request.Request(
                "http://127.0.0.1:%d/json/close/%s" % (self.debug_port, self.target_id)))
        except Exception: pass
        try: self.ws.close()
        except Exception: pass

class Chrome:
    def __init__(self, gl="swiftshader"):
        self.profile = tempfile.mkdtemp(prefix="aura-repro-")
        args = [chrome_binary(), "--headless=new", "--mute-audio",
                "--autoplay-policy=no-user-gesture-required",
                "--user-data-dir=" + self.profile,
                "--remote-debugging-port=0", "--remote-allow-origins=*",
                "--window-size=1200,900", "--no-first-run", "--no-default-browser-check",
                "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows"]
        if gl == "swiftshader":
            args += ["--use-gl=angle", "--use-angle=swiftshader"]
        else:
            args += ["--use-gl=angle"]
        args.append("about:blank")
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pf = os.path.join(self.profile, "DevToolsActivePort")
        for _ in range(150):
            if os.path.exists(pf): break
            if self.proc.poll() is not None: raise RuntimeError("chrome exited early")
            time.sleep(0.2)
        if not os.path.exists(pf): raise RuntimeError("no DevToolsActivePort")
        self.debug_port = int(open(pf).read().split()[0])
    def new_tab(self, url):
        q = urllib.parse.quote(url, safe="")
        info = json.load(urllib.request.urlopen(urllib.request.Request(
            "http://127.0.0.1:%d/json/new?%s" % (self.debug_port, q), method="PUT")))
        t = Tab(info["webSocketDebuggerUrl"], info["id"], self.debug_port)
        for m in ("Page.enable", "Runtime.enable", "Log.enable"):
            try: t.send(m)
            except AssertionError: pass
        try: t.send("Page.bringToFront")
        except AssertionError: pass
        return t
    def close(self):
        try:
            self.proc.terminate(); self.proc.wait(timeout=10)
        except Exception:
            try: self.proc.kill()
            except Exception: pass
        shutil.rmtree(self.profile, ignore_errors=True)

SNAP = """(() => {
  const a = window.__aura;
  if (!a) return null;
  const s = a.snapshot();
  let px = null;
  try {
    const c = document.getElementById('aura-canvas');
    const gl = c && c.getContext('webgl2');
    if (gl) {
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const b = new Uint8Array(w*h*4);
      gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,b);
      let sum=0, lit=0, hash=0; const stride=16;
      for (let i=0;i<b.length;i+=stride){const v=b[i]+b[i+1]+b[i+2];sum+=v;if(v>12)lit++;hash=(hash*31+v)|0;}
      px = {mean: Math.round(sum/(b.length/stride)/3), lit, hash, w, h};
    }
  } catch(e) { px = {error:String(e)}; }
  return {snap:s, px};
})()"""

def main():
    url = sys.argv[1]
    seconds = 100; interval = 5; gl = "swiftshader"
    for i,a in enumerate(sys.argv[2:]):
        if a == "--seconds": seconds = int(sys.argv[i+3])
        elif a == "--interval": interval = float(sys.argv[i+3])
        elif a == "--gl": gl = sys.argv[i+3]
    ch = Chrome(gl)
    tab = ch.new_tab(url)
    t0 = time.time()
    prev_shot = None
    rows = []
    print("chrome port", ch.debug_port, "url", url.split('?')[0])
    while time.time() - t0 < seconds:
        ts = round(time.time()-t0,1)
        try:
            res = tab.ev(SNAP)
        except AssertionError as e:
            res = {"error": str(e)}
        try:
            shot = tab.send("Page.captureScreenshot", {"format": "png"})["data"]
            sh = hashlib.sha1(base64.b64decode(shot)).hexdigest()[:12]
            shot_changed = None if prev_shot is None else (sh != prev_shot)
            prev_shot = sh
        except Exception as e:
            sh = "ERR"; shot_changed = None
        evs = [e for e in tab.events if e.get("method") in ("Runtime.exceptionThrown","Runtime.consoleAPICalled","Log.entryAdded")]
        tab.events = []
        s = (res or {}).get("snap") if isinstance(res, dict) else None
        px = (res or {}).get("px") if isinstance(res, dict) else None
        if s:
            line = ("t=%5.1f frames=%d seq=%d paused=%s blocker=%s preset=%s q=%s/%s syncMs=%s scale=%s errs=%d shot=%s chg=%s px=%s"
                    % (ts, s.get("frames",-1), s.get("lastSeq",-1), s.get("silent"),
                       ",".join(s.get("fallbackReasons") or []) or "-", s.get("preset"),
                       s.get("quality",{}).get("tier"), s.get("quality",{}).get("degradeLevel"),
                       s.get("quality",{}).get("syncMs"), s.get("quality",{}).get("renderScale"),
                       len(s.get("errors") or []), sh, shot_changed, px))
        else:
            line = "t=%5.1f NO __aura res=%r" % (ts, res)
        print(line, flush=True)
        for e in evs:
            print("   EVENT", e.get("method"), json.dumps(e.get("params"))[:400], flush=True)
        rows.append({"t": ts, "snap": s, "px": px, "shot": sh})
        time.sleep(interval)
    print("=== final errors:", json.dumps((rows[-1]["snap"] or {}).get("errors") if rows and rows[-1]["snap"] else None))
    tab.close(); ch.close()

if __name__ == "__main__":
    main()
