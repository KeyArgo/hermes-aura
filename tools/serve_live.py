"""Run the real Aura server + capture loop and print a URL you can open.

This is the same code path the plugin's hooks use (ensure_server -> PipeWire
monitor capture -> WS PCM -> page), just started from a shell so it can be looked
at without the desktop app. Stop with Ctrl-C or kill.

Usage: .venv/bin/python tools/serve_live.py
"""
import sys
import time
import urllib.parse

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.dirname(__import__("os").path.abspath(__file__))))

from aura_core import config as cfg
from aura_core import server

server.ensure_server()
port = server.get_port()
token = cfg.read_token()
url = "http://127.0.0.1:%d/?token=%s" % (port, urllib.parse.quote(token))
print("AURA_URL %s" % url, flush=True)
print("capture=%s" % cfg.load_config().get("capture"), flush=True)

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    server.stop_server()
