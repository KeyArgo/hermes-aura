# Testing this plugin on another machine

Two ways in: run the script, or hand this file to an agent on that machine and let it follow the
steps. Both end with a `RESULT.txt` you can send back.

## One command (Windows)

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\test-windows.ps1
```

It creates `.venv-win`, installs the declared dependencies plus pytest, finds every `tests` directory
in the repo, runs each one, and writes `RESULT.txt`. It touches nothing outside this folder.

Prerequisite: Python 3.12 from python.org, installed with **"Add python.exe to PATH"** ticked.

## One command (Linux / macOS)

```bash
bash scripts/test.sh
```

## What a good run looks like

- every suite reports `N passed`
- exit code `0`
- `RESULT.txt` lists the commit, the OS and the per-suite counts

A failure is still a useful result — send it. A missing result scores the same as never testing.

## If you are an agent on that machine, do this

1. Confirm `python --version` is 3.10+; if not, stop and ask for Python to be installed.
2. Run `powershell -ExecutionPolicy Bypass -File .\scripts\test-windows.ps1`.
3. Read `RESULT.txt`. Do not paraphrase it — quote the `suites:` lines verbatim.
4. If a suite failed, capture the last 40 lines of that suite's output and the traceback.
5. Report: host name, OS, python version, commit, and one line per suite.

Do not install packages globally, do not modify source to make tests pass, and do not report a pass
you did not see.

## Why this matters

The scoring system reads a recorded suite result at a commit as proof the code runs. A Windows result
is the evidence that turns "Windows untested" into a measured fact.
