# Third-party notices

Aura ships two JavaScript libraries and a curated subset of visual presets.

## Butterchurn

- `web/vendor/butterchurn.min.js` — Butterchurn 2.6.7, MIT License.
- Upstream: https://github.com/jberg/butterchurn — Copyright (c) Jordan Berg and contributors.
- Used unmodified. Aura wraps it; it is never patched.

## butterchurn-presets

- `web/vendor/butterchurnPresets.min.js` — butterchurn-presets 2.4.7, MIT License (package).
- Upstream: https://github.com/jberg/butterchurn-presets
- The presets inside are conversions of MilkDrop presets originally authored by members of the
  MilkDrop/Winamp community (Ryan Geiss, "Flexi", "Zylot", "Geiss", "Martin", "shifter" and
  others). Individual presets may carry their authors' own attribution; the names are kept
  verbatim and the curated list in `web/presets.json` is a subset, not the whole pack.

Aura's own code is MIT. "MilkDrop" is referenced only in prose ("MilkDrop-compatible"); the
plugin is not called MilkDrop.

## Preset attribution

Preset names in `web/presets.json` are the original butterchurn-presets keys (e.g.
`Flexi - mindblob [shiny mix]`, `Zylot - True Visionary (Final Mix)`), so each preset keeps its
author's credit in its name. Aura selects among them; it does not rename or re-author them.
