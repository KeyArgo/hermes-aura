/**
 * Caption (CC) rules for Aura's film player.
 *
 * `cc_load_policy=1` asks the embed for captions; the live player answers the
 * documented `loadModule`/`unloadModule` pair, and each new video in a playlist
 * is a fresh captions context, so the module is loaded again per video.
 * Burned-in subtitles are part of the picture: no player API can remove them.
 *
 * Loaded by web/player.html as a plain script, and imported by the contract
 * test as a CommonJS module, so both run these exact rules.
 */
(function (root) {
  'use strict'

  // A language tag YouTube would recognise: `fr`, `en-US`, `pt-BR`, `zh-Hans`.
  // Anything else is dropped rather than sent to a third party.
  function language(value) {
    var text = typeof value === 'string' ? value.trim() : ''
    return /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(text) ? text : ''
  }

  /** The query parts that ask the EMBED for captions.
   *
   *  On is `cc_load_policy=1`, plus the preferred language when there is one.
   *  Off is nothing at all: the parameter has no "off" value, and its absence
   *  is the documented default, so "do not send cc_load_policy" is the rule.
   */
  function embedParams(options) {
    var on = Boolean(options && options.on)
    if (!on) return []
    var parts = ['cc_load_policy=1']
    var lang = language(options && options.lang)
    if (lang) parts.push('cc_lang_pref=' + encodeURIComponent(lang))
    return parts
  }

  /** The commands that tell the LIVE player (postMessage API) what to do.
   *
   *  On loads the captions module and, when a language is known, selects that
   *  track — loading the module alone does not guarantee a track is showing.
   *  Off unloads the module, which is how a running player drops its captions.
   */
  function commands(options) {
    var on = Boolean(options && options.on)
    if (!on) return [{ func: 'unloadModule', args: ['captions'] }]
    var out = [{ func: 'loadModule', args: ['captions'] }]
    var lang = language(options && options.lang)
    if (lang) out.push({ func: 'setOption', args: ['captions', 'track', { languageCode: lang }] })
    return out
  }

  /** One track, normalised: `{code, name, kind}`. Junk is dropped. */
  function track(raw) {
    if (!raw || typeof raw !== 'object') return null
    // `code` is the normalised field: these lists are passed around between
    // the page, the app and the tests, and re-normalising one must be a no-op.
    var code = language(raw.code || raw.languageCode || raw.language || '')
    if (!code) return null
    var name = raw.displayName || raw.languageName || raw.label || raw.name || code
    return {
      code: code,
      name: String(name).slice(0, 80),
      // 'asr' is the auto-generated track: it may not be selectable.
      kind: typeof raw.kind === 'string' ? raw.kind : ''
    }
  }

  /** A list of tracks, normalised and de-duplicated by language code. */
  function normaliseTracks(list) {
    var out = []
    var seen = {}
    if (!Array.isArray(list)) return out
    for (var i = 0; i < list.length; i += 1) {
      var clean = track(list[i])
      if (!clean || seen[clean.code]) continue
      seen[clean.code] = true
      out.push(clean)
      if (out.length >= 60) break
    }
    return out
  }

  /** What an `apiInfoDelivery` message says about captions.
   *
   *  Returns `{tracks, current}` when the player exposed its captions module,
   *  or null when this frame said nothing about captions (a video with no
   *  captions never sends one).
   */
  function tracksFrom(info) {
    if (!info || typeof info !== 'object') return null
    var captions = info.captions
    if (!captions || typeof captions !== 'object') return null
    var list = normaliseTracks(captions.tracklist || captions.tracks || [])
    var playing = track(captions.track)
    return { tracks: list, current: playing ? playing.code : '' }
  }

  /** Does this list offer a caption track at all? */
  function hasCaptions(tracks) {
    return normaliseTracks(tracks).length > 0
  }

  /** Which track to show: the preference, then the same base language, then
   *  English, then whatever the video offers first. Empty string when there is
   *  nothing to pick. */
  function pickTrack(tracks, preferred) {
    var list = normaliseTracks(tracks)
    if (!list.length) return ''
    var want = language(preferred).toLowerCase()
    var i
    if (want) {
      for (i = 0; i < list.length; i += 1) {
        if (list[i].code.toLowerCase() === want) return list[i].code
      }
      var base = want.split('-')[0]
      for (i = 0; i < list.length; i += 1) {
        if (list[i].code.toLowerCase().split('-')[0] === base) return list[i].code
      }
    }
    for (i = 0; i < list.length; i += 1) {
      if (list[i].code.toLowerCase().split('-')[0] === 'en') return list[i].code
    }
    return list[0].code
  }

  var api = {
    embedParams: embedParams,
    commands: commands,
    language: language,
    normaliseTracks: normaliseTracks,
    tracksFrom: tracksFrom,
    pickTrack: pickTrack,
    hasCaptions: hasCaptions
  }

  if (typeof module === 'object' && module && module.exports) module.exports = api
  if (root) root.AuraCaptions = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
