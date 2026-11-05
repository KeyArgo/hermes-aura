# Third-party notices — Aura web vendor bundle

Aura ships the following MIT-licensed JavaScript at `web/vendor/` so the visualizer
works with no npm install and no network access at runtime. Both files are copied
verbatim from the published packages (`butterchurn@2.6.7`, `butterchurn-presets@2.4.7`).

## butterchurn — `web/vendor/butterchurn.min.js`

- Project: Butterchurn — a WebGL implementation of the MilkDrop visualizer
  (https://github.com/jberg/butterchurn, https://butterchurnviz.com)
- Version: 2.6.7
- Licence: MIT
- Copyright (c) 2013-2018 Jordan Berg

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

## butterchurn-presets — `web/vendor/butterchurnPresets.min.js`

- Project: Butterchurn preset packs (https://github.com/jberg/butterchurn-presets)
- Version: 2.4.7
- Licence: MIT (package licence)
- Copyright (c) 2013-2018 Jordan Berg
- Same MIT text as above.

### Preset authors

The individual presets are community MilkDrop conversions. Aura loads only the
curated subset listed in `web/presets.json` (20 presets, ≤20 as shipped), so the
credits below cover the authors of the presets actually used. All are credited by
their preset-name prefix in the upstream pack:

- Flexi (Flexi, flexi)
- Martin (Martin, martin)
- Geiss (Geiss, _Geiss)
- Rovastar
- Unchained
- Zylot
- shifter
- Krash, Phat, Eo.S., Fishbrain, Stahlregen, amandio c, AdamFX, Orb, Illusion,
  Idiot, Goody, Mig, cope, suksma, TonyMilkdrop, Loadus, Fumbling_Foo and the
  MilkDrop community whose `.milk` files these conversions derive from.

MilkDrop itself is Ryan Geiss's original visualizer; Aura only says
"MilkDrop-compatible" in prose and does not use the name as its own.

## Notes

- No runtime npm dependency: these two files are committed and served by the Aura
  server from its own origin.
- `web/presets.json` is Aura's own curation metadata (name / family / strobe flag),
  not part of the upstream packages.
