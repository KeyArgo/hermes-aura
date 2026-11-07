import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def test_backends_load_when_package_is_namespaced():
    # Hermes loads the plugin as a sub-package (e.g. hermes_plugins.aura), so
    # top-level ``aura_core`` is not importable there. Regression: every Aura
    # start inside Hermes silently got zero capture backends.
    with tempfile.TemporaryDirectory() as tmp:
        os.symlink(REPO, Path(tmp) / "plugpkg")
        code = (
            "import sys\n"
            "sys.path = [p for p in sys.path if p not in ('', %r)]\n"
            "try:\n"
            "    import aura_core\n"
            "    raise SystemExit('top-level aura_core must not be importable')\n"
            "except ImportError:\n"
            "    pass\n"
            "from plugpkg.aura_core.capture import base\n"
            "print(sorted(c.name for c in base._backend_classes()))\n"
        ) % str(REPO)
        env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
        env["PYTHONPATH"] = tmp
        out = subprocess.run([sys.executable, "-I", "-c",
                              "import sys; sys.path.insert(0, %r)\n" % tmp + code],
                             capture_output=True, text=True, cwd=tmp, env=env, timeout=30)
        assert out.returncode == 0, out.stderr
        assert out.stdout.strip() == "['macos', 'pipewire', 'pulse', 'wasapi']", out.stdout
