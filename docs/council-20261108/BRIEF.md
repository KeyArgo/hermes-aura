# Council brief: make Aura win the Nous Hermes plugin hackathon (due 2026-11-11 15:00 MT)

Answer in <= 400 words, as a ranked list. Be concrete and buildable in ~2 days by a small team.
Do not edit any files. Read README.md and LIMITS.md in /mnt/homes/Development/hermes-aura for context if
you can.

## What Aura is today
A Hermes desktop plugin: a MilkDrop (Butterchurn/WebGL) visual drawn BEHIND the whole Hermes desktop app
(panels go see-through). It captures system audio (PulseAudio) and gets agent "moods" from Hermes hooks
(idle, thinking, tool, approval, error, streaming, done). Settings: on/off, intensity, transparency
(opacity), style calm/balanced/intense, reduced motion, motion source (ambient / music / agent / agent+music),
auto preset rotation over 20 curated presets (butterchurn-presets bundle, MIT). A status-bar "A" quick menu
is being built. Music reactivity is being fixed now (bass/treble/beat feed into Butterchurn).

## Owner's open questions — answer each
1. Out-of-the-box DEFAULT (user changes nothing): which motion source (agent / music / agent+music /
   ambient), intensity (owner leans 50%), style, opacity? What's most useful AND most "wow" on first launch?
2. Theme coexistence: user keeps their normal Hermes theme, and Aura only fades in while the agent works or
   music plays, then fades back out. Good idea or trouble? How to make it safe?
3. A motion-sickness-friendly mode: what exactly should it change?
4. Top 5 ideas to step this up and win (judges = Nous/Hermes community). Think: agent-state visual language
   (e.g. tool calls = distinct look, approval = attention, error = red glitch), preset variety, demo moment,
   shareable clip, agent tool `aura_control` already lets the agent change the visual.
5. Biggest risk that could lose us the hackathon.
