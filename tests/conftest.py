"""Keep the test session away from a live gateway's HERMES_HOME.

The single-server election is per HERMES_HOME, so tests that use the real
default home would otherwise become followers of a running Hermes gateway and
never start their own server. Each test may still override HERMES_HOME (see
tests/test_server.py); this is only the session default.
"""

from __future__ import annotations

import atexit
import os
import shutil
import tempfile

_TEST_HOME = tempfile.mkdtemp(prefix="aura-tests-")
os.environ["HERMES_HOME"] = _TEST_HOME
atexit.register(shutil.rmtree, _TEST_HOME, True)
