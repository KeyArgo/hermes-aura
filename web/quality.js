/**
 * Quality rules for Aura's film player.
 *
 * What each source allows, measured rather than assumed:
 *
 *   - **YouTube** publishes the level it is playing and the levels it has
 *     (`infoDelivery`: `playbackQuality`, `availableQualityLevels`,
 *     `preferredQuality`) but ignores the command to select one: measured in
 *     headless Chromium against this very page, sending `setPlaybackQuality`
 *     with `small`, `medium`, `hd720`, `hd1080`, `large` and `default` left
 *     `playbackQuality` at `hd1080` and `preferredQuality` at `auto` every
 *     time. So there is no `vq=` parameter here and no fake level list: the one
 *     honest answer is "Auto (YouTube decides)".
 *   - **archive.org** films have real files (the server lists them from the
 *     item's metadata), so a switch is a real source swap — and a source swap
 *     mid-film is only acceptable if it keeps the second the viewer is at.
 *     That rule lives here, in one place, because both the in-app page and the
 *     headless contract test run it.
 *
 * Loaded by web/player.html as a plain script, and imported by the headless
 * contract test as a CommonJS module, so both run these exact rules.
 */
(function (root) {
  'use strict'

  var AUTO_YOUTUBE = 'Auto (YouTube decides)'

  // Kinds the page can swap the source of (a native <video>). A YouTube embed
  // or an unknown iframe cannot be told what quality to show.
  function autoOnly(kind) {
    return kind === 'youtube' || kind === 'playlist'
  }

  /** What the live player says about quality, made safe.
   *
   *  A frame that says nothing about quality (most of them do) leaves these
   *  empty; nothing is inferred from a missing field.
   */
  function fromInfo(info) {
    var out = { current: '', preferred: '', levels: [] }
    if (!info || typeof info !== 'object') return out
    if (typeof info.playbackQuality === 'string' && info.playbackQuality) {
      out.current = info.playbackQuality.slice(0, 20)
    }
    if (typeof info.preferredQuality === 'string' && info.preferredQuality) {
      out.preferred = info.preferredQuality.slice(0, 20)
    }
    var levels = info.availableQualityLevels
    if (Array.isArray(levels)) {
      for (var i = 0; i < levels.length; i += 1) {
        if (typeof levels[i] === 'string' && levels[i]) out.levels.push(levels[i].slice(0, 20))
      }
    }
    return out
  }

  /** How to swap the film onto another one of its files: where it was and
   *  whether it was playing. `null` when there is nothing to swap to, so a
   *  caller can never blank the film by accident.
   */
  function swapPlan(current, next) {
    var url = next && typeof next.url === 'string' ? next.url.trim() : ''
    if (!url) return null
    var position = current && typeof current.position === 'number' ? current.position : 0
    if (!isFinite(position) || position < 0) position = 0
    return {
      url: url,
      position: position,
      playing: Boolean(current && current.playing)
    }
  }

  /** One line describing a choice a human can read: resolution, size, format. */
  function label(choice) {
    var bits = []
    if (choice && typeof choice === 'object') {
      var width = Number(choice.width) || 0
      var height = Number(choice.height) || 0
      if (width && height) bits.push(width + '×' + height)
      else if (height) bits.push(height + 'p')
      var size = Number(choice.size_bytes) || 0
      if (size >= 1048576) bits.push(Math.round(size / 1048576) + ' MB')
      else if (size >= 1024) bits.push(Math.round(size / 1024) + ' KB')
      if (typeof choice.format === 'string' && choice.format) bits.push(choice.format)
    }
    return bits.length ? bits.join(' · ') : 'file'
  }

  var api = {
    autoLabel: AUTO_YOUTUBE,
    autoOnly: autoOnly,
    fromInfo: fromInfo,
    swapPlan: swapPlan,
    label: label
  }

  if (typeof module === 'object' && module && module.exports) module.exports = api
  if (root) root.AuraQuality = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
