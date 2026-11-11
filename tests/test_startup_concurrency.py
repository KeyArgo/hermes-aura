import threading
import time
from concurrent.futures import ThreadPoolExecutor

from aura_core import server


def test_concurrent_start_requests_share_one_server(monkeypatch):
    server.stop_server()
    entered = threading.Event()
    starts = []

    class Alive:
        def is_alive(self):
            return True

    def start():
        starts.append(1)
        entered.set()
        time.sleep(0.15)
        with server._STATE.lock:
            server._STATE.httpd = object()
            server._STATE.thread = Alive()

    monkeypatch.setattr(server, '_start_server', start)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(server.ensure_server)
            assert entered.wait(1)
            second = pool.submit(server.ensure_server)
            first.result(timeout=2)
            second.result(timeout=2)
        assert len(starts) == 1
    finally:
        with server._STATE.lock:
            server._STATE.httpd = None
            server._STATE.thread = None


def test_stop_waits_for_start_to_finish(monkeypatch):
    server.stop_server()
    entered = threading.Event()
    release = threading.Event()

    class FakeServer:
        def shutdown(self): pass
        def server_close(self): pass

    class Alive:
        def is_alive(self): return True
        def join(self, timeout=None): pass

    def start():
        entered.set()
        assert release.wait(2)
        with server._STATE.lock:
            server._STATE.httpd = FakeServer()
            server._STATE.thread = Alive()
            server._STATE.port = 1234
            server._STATE.token = 'test'

    monkeypatch.setattr(server, '_start_server', start)
    with ThreadPoolExecutor(max_workers=2) as pool:
        starting = pool.submit(server.ensure_server)
        assert entered.wait(1)
        stopping = pool.submit(server.stop_server)
        time.sleep(0.1)
        assert not stopping.done()
        release.set()
        starting.result(timeout=2)
        stopping.result(timeout=2)
    assert server.get_port() is None
    assert server.get_token() is None
