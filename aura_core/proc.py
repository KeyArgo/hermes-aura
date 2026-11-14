"""Process liveness that is safe on every OS.

On Windows ``os.kill(pid, 0)`` is not a liveness check: signal 0 is CTRL_C_EVENT, so CPython
sends a console Ctrl+C to the process group instead of asking whether the pid exists. Every
"is this pid alive" question in Aura goes through here.
"""

from __future__ import annotations

import os


def pid_alive_windows(pid: int) -> bool:
    """``OpenProcess`` + ``GetExitCodeProcess``: the Windows liveness probe."""
    if pid == os.getpid():
        return True
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel32.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            # Access denied means the process exists but is beyond our reach (an elevated one).
            return ctypes.get_last_error() == 5
        try:
            code = wintypes.DWORD()
            ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        finally:
            kernel32.CloseHandle(handle)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    except Exception:  # noqa: BLE001 - a probe never takes its caller down
        return False


def pid_alive_posix(pid: int) -> bool:
    """Signal 0 on POSIX: delivered nowhere, only checks that the pid exists."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True
