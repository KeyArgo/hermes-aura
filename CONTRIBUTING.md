# Contributing to Aura

Thanks for helping. Bug reports, small focused fixes and new ideas are all welcome.

## Report a bug or ask for a feature

Open an issue with the template. For a bug, include your OS, your Hermes Agent
version (`hermes --version`), the Aura version shown in the plugin, the steps,
and what you expected.

## Send a change

1. Fork, then branch from `main`.
2. Run the checks before you push:

   ```bash
   python3 -m venv .venv
   .venv/bin/python -m pip install pytest
   .venv/bin/python -m pytest tests -q --ignore=tests/e2e --ignore=tests/integration
   node --test tests/test_desktop_plugin.mjs
   ```

   The e2e suite needs Chrome and an audio loopback; it is excluded above.
3. Keep the pull request to one logical change, with a test that fails before it
   and passes after. Never weaken a test to make it pass.
4. Describe what changed and why. If the change touches privacy, network calls
   or capabilities, say so in the description — those are reviewed first.

## Ground rules

- Plugins extend Hermes only through public hooks, `ctx.register_*` APIs and the
  Desktop SDK.
- New Python dependencies need an upper bound (`>=X,<Y`).
- Runtime code is stdlib only; keep it that way.
- By contributing you agree your work is released under this repository's MIT
  licence.
- Be kind; see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the repo layout and how CI is
wired.
