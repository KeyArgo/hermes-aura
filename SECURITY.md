# Security

## Reporting a vulnerability
Please report security problems privately through GitHub: **Security → Report a vulnerability** on
this repository. Do not open a public issue. You will get an answer as soon as possible.

## What Aura touches
- **Audio:** system output loopback only (PipeWire/PulseAudio monitor on Linux, WASAPI loopback on
  Windows). Never the microphone. Samples are analysed in memory for the visualiser and discarded;
  nothing is recorded, written to disk or uploaded.
- **Network:** the local Aura server binds `127.0.0.1` and requires a per-launch token. Films are
  fetched from the URLs you choose. Keyless search reads YouTube's public results page and caches it
  for five minutes. No account, no telemetry, no self-updater.
- **Files:** Aura writes only its own settings and source list in the plugin data folder.

## Supported versions
Only the latest release receives fixes.
