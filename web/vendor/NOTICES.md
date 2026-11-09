# Third-party notices — Aura web vendor bundle

Aura ships the following MIT-licensed JavaScript at `web/vendor/` so the visualizer
works with no npm install and no network access at runtime. Every file is copied
verbatim from the published packages (`butterchurn@2.6.7`,
`butterchurn-presets@2.4.7`) and is served from Aura's own origin.

## butterchurn — `web/vendor/butterchurn.min.js`

- Project: Butterchurn — a WebGL implementation of the MilkDrop visualizer
  (https://github.com/jberg/butterchurn, https://butterchurnviz.com)
- Version: 2.6.7
- Licence: MIT
- Copyright (c) 2013-2018 Jordan Berg
- SHA-256: `4e67421bc18d48fac4a6ff4e69e2778f770737fbdd4e323438da154085b4818d`

## butterchurn-presets packs — `butterchurn-presets@2.4.7`

All four preset packs below are MIT-licensed files from the same published npm
release (`butterchurn-presets@2.4.7`, package shasum
`41e4e37cd3af2aec124fa8062352816100956c29`). The upstream package licence text is
reproduced under "MIT licence text" below.

| File | Pack | Presets | SHA-256 |
| --- | --- | ---: | --- |
| `butterchurnPresets.min.js` | base | 100 | `136c746836aef6dff8a1f6a93ede48c7bbe4da27d2f44de6b59ebc56ffefca10` |
| `butterchurnPresetsExtra.min.js` | Extra | 146 | `af06e7e02a5edcaf766e62abfe0971fe25cd1faa7cba7af1654a969107c11d7e` |
| `butterchurnPresetsExtra2.min.js` | Extra2 | 122 | `e2347c695610f6de9242a1c5a8eb686c809048a628d8c86faf14bb441af67383` |
| `butterchurnPresetsMD1.min.js` | MD1 | 87 | `e2ca0f34a2791245e870fda9dfb403ddaab41451d1d5e9f48488f3b877c2c162` |

The packs overlap: the union of their keys is 395 distinct preset names. Aura
loads the base pack at startup and injects the three extra packs after the first
frame; the curated subset in `web/presets.json` is what the mood engine chooses
from, not the whole union.

### Preset authors

The individual presets are community MilkDrop conversions. Aura credits the
authors through the verbatim preset-name prefixes in the upstream packs:

- Flexi (Flexi, flexi)
- Martin (Martin, martin)
- Geiss (Geiss, _Geiss)
- Rovastar
- Unchained
- Zylot
- shifter
- Krash, Phat, Eo.S., Fishbrain, Stahlregen, amandio c, AdamFX, Orb, Illusion,
  Idiot, Goody, Mig, cope, suksma, TonyMilkdrop, Loadus, Fumbling_Foo, Aderrasi,
  Stahlregen, Hexcollie, LuxXx, Halfbreak, ShadowHarlequin, Pieturp, En D,
  MilkDrop2077 and the MilkDrop community whose `.milk` files these conversions
  derive from.

MilkDrop itself is Ryan Geiss's original visualizer; Aura only says
"MilkDrop-compatible" in prose and does not use the name as its own.

## MIT licence text

```
MIT License

Copyright (c) 2013-2018 Jordan Berg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Notes

- No runtime npm dependency: these files are committed and served by the Aura
  server from its own origin.
- `web/presets.json` is Aura's own curation metadata (name / family / strobe flag),
  not part of the upstream packages.
