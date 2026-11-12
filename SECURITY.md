# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's private
vulnerability reporting: **Security → Report a vulnerability** on this
repository. Do not open a public issue. You will get an answer as soon as
possible.

## Supported versions

The 1.0.x line receives fixes. Older versions are not supported.

## What Aura touches

- **Audio:** system output loopback only (PipeWire/PulseAudio monitor on Linux,
  WASAPI loopback on Windows). Never the microphone. Samples are analysed in
  memory for the visualiser and discarded; nothing is recorded, written to disk
  or uploaded.
- **Network:** the local Aura server binds `127.0.0.1` and requires a per-launch
  token. Films are fetched from the URLs you choose. Keyless search reads
  YouTube's public results page and caches it for five minutes. Radio search
  queries the public Radio Browser directory; the stream proxy validates and
  pins the resolved host. No account, no telemetry, no self-updater.
- **Files:** Aura writes only its own settings, token, lease/lock and radio
  favourites in `~/.hermes/aura/`.

## Scope

A report that Aura leaks audio, runs a command it was not asked to run, lets a
third-party page execute in Aura's origin, or exposes the local token is in
scope. A report about a third-party site refusing to be embedded is a product
limit, not a vulnerability.
