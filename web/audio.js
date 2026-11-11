/**
 * Aura — the audio channel.
 *
 * One <audio> element, completely independent of the video pane: it plays
 * direct audio URLs (mp3/ogg/aac/opus/flac/wav) and internet radio streams,
 * with its own volume and its own mute. That independence is the point —
 * "music while the film plays muted" is two separate elements, not one.
 *
 * PCM: nothing here feeds the visual. Aura reacts to the system loopback
 * (parec) already, so this file only plays sound.
 *
 * Messages (postMessage from the desktop half, same window.parent check the
 * video transport uses):
 *   { aura: 'audio', cmd: 'play',   url, label }
 *   { aura: 'audio', cmd: 'stop' }
 *   { aura: 'audio', cmd: 'volume', value: 0..1 }
 *   { aura: 'audio', cmd: 'mute' } / { cmd: 'unmute' }
 *   { aura: 'audio', cmd: 'state' }        -> reply with audio-state
 *
 * Upward, at most 4 Hz and on every real change:
 *   { aura: 'audio-state', url, label, playing, volume, muted, error }
 *
 * Loaded by web/index.html (aura mode) and web/player.html (video mode), so
 * the music survives switching between the visual and the film.
 */
(function () {
  'use strict'

  if (window.__auraAudio) return
  var host = window.parent && window.parent !== window ? window.parent : null
  // The desktop half is the only sender whose messages are honoured.
  var audio = null
  var state = { url: '', label: '', playing: false, volume: 0.7, muted: false, error: '' }
  var lastPost = 0

  function el() {
    if (audio) return audio
    audio = document.createElement('audio')
    audio.preload = 'none'
    audio.autoplay = false
    // Radio streams never end; looping would only matter for a file.
    audio.loop = false
    audio.style.display = 'none'
    audio.setAttribute('aria-hidden', 'true')
    audio.volume = state.volume
    audio.addEventListener('playing', function () {
      state.playing = true
      state.error = ''
      postState(true)
    })
    audio.addEventListener('pause', function () {
      state.playing = false
      postState(true)
    })
    audio.addEventListener('ended', function () {
      state.playing = false
      postState(true)
    })
    audio.addEventListener('error', function () {
      state.playing = false
      // Reading audio.error is the only way to say *why*; a bare "it failed"
      // in the UI is what made a bad stream URL look like a broken Aura.
      var code = audio.error && audio.error.code
      state.error = code === 4 ? 'This stream cannot be played (unsupported or offline).'
        : code === 2 ? 'The stream dropped.'
        : 'The stream did not start.'
      postState(true)
    })
    ;(document.body || document.documentElement).appendChild(audio)
    return audio
  }

  function postState(force) {
    if (!host) return
    var now = Date.now()
    if (!force && now - lastPost < 250) return
    lastPost = now
    try {
      host.postMessage({
        aura: 'audio-state',
        url: state.url,
        label: state.label,
        playing: state.playing,
        volume: state.volume,
        muted: state.muted,
        error: state.error
      }, '*')
    } catch (err) { /* the host may be gone */ }
  }

  function streamUrl(url) {
    // [finding 9] Never hand the station hostname to the browser: the server
    // validates, pins and follows only safe redirects, then streams the bytes.
    var path = '/api/radio/stream?url=' + encodeURIComponent(String(url))
    var token = ''
    try {
      token = new URLSearchParams(window.location.search).get('token') || ''
    } catch (err) { /* old browser: fall back to no token */ }
    if (token) path += '&token=' + encodeURIComponent(token)
    return path
  }

  function play(url, label, volume) {
    if (!url) return
    var node = el()
    var src = streamUrl(url)
    // The desktop repeats the last play on its first poll after a reload.
    // Re-assigning src restarts the stream, so keep a live one playing.
    if (node.getAttribute('src') === src && !node.paused && !node.ended) {
      state.url = String(url)
      state.label = typeof label === 'string' ? label : ''
      if (typeof volume === 'number' && Number.isFinite(volume)) {
        state.volume = Math.max(0, Math.min(1, volume))
        node.volume = state.volume
      }
      postState(true)
      return
    }
    state.url = String(url)
    state.label = typeof label === 'string' ? label : ''
    state.error = ''
    // The page can be newer than the channel was: carry the user's volume
    // with the command, or a fresh page would play at its own default.
    if (typeof volume === 'number' && Number.isFinite(volume)) {
      state.volume = Math.max(0, Math.min(1, volume))
    }
    node.src = src
    node.volume = state.volume
    node.muted = state.muted
    // Autoplay may be refused before a user gesture; say so instead of
    // leaving the UI claiming music is on.
    var started = node.play()
    if (started && typeof started.catch === 'function') {
      started.catch(function () {
        state.playing = false
        state.error = 'The browser blocked playback — click anywhere in Aura, then press play again.'
        postState(true)
      })
    }
    postState(true)
  }

  function stop() {
    if (audio) {
      try { audio.pause() } catch (err) { /* already gone */ }
      try { audio.removeAttribute('src'); audio.load() } catch (err) { /* no src */ }
    }
    state.playing = false
    state.url = ''
    state.label = ''
    state.error = ''
    postState(true)
  }

  function setVolume(value) {
    var level = Math.max(0, Math.min(1, Number(value)))
    if (!Number.isFinite(level)) return
    state.volume = level
    // Turning the volume up un-mutes the channel, exactly like the video
    // transport does: a slider at 60% that is silent is a bug, not a state.
    if (level > 0) state.muted = false
    if (audio) {
      audio.volume = level
      audio.muted = state.muted
    }
    postState(true)
  }

  function setMuted(muted) {
    state.muted = Boolean(muted)
    if (audio) audio.muted = state.muted
    postState(true)
  }

  window.addEventListener('message', function (event) {
    if (!host || event.source !== host) return
    var data = event.data
    if (!data || typeof data !== 'object' || data.aura !== 'audio') return
    if (data.cmd === 'play') play(data.url, data.label, data.volume)
    else if (data.cmd === 'stop') stop()
    else if (data.cmd === 'volume') setVolume(data.value)
    else if (data.cmd === 'mute') setMuted(true)
    else if (data.cmd === 'unmute') setMuted(false)
    else if (data.cmd === 'state') postState(true)
  })

  // Exposed for a same-origin page (and for a headless probe) to inspect what
  // the channel is doing without driving it.
  window.__auraAudio = {
    state: function () {
      return { url: state.url, label: state.label, playing: state.playing,
               volume: state.volume, muted: state.muted, error: state.error }
    }
  }
})()
