/*
 * Aura PCM sink (L2) — AudioWorkletProcessor.
 *
 * Receives float32 mono frames (CONTRACT §2, 48 kHz nominal) from aura.js over the
 * port and emits them as the node's output so Butterchurn's internal analyser sees
 * them. The node is wired through gain 0 to the destination in aura.js, so this
 * processor is what Aura "plays" and it is inaudible by construction.
 *
 * Back-pressure rule from the contract: drop, never queue. We keep at most
 * maxQueueSamples (~250 ms); when a new frame would overflow, the oldest queued
 * audio is discarded so the visualizer stays in time with what is playing now.
 */

class AuraPcmSink extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.maxQueueSamples = Math.max(2048, opts.maxQueueSamples || 12000);
    this.chunks = [];
    this.queued = 0;
    this.offset = 0;
    this.droppedSamples = 0;
    this.droppedFrames = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data === 'reset' || data.type === 'reset') {
        this.chunks.length = 0;
        this.queued = 0;
        this.offset = 0;
        return;
      }
      if (data.type === 'stats') {
        this.port.postMessage({
          type: 'stats',
          queued: this.queued,
          droppedSamples: this.droppedSamples,
          droppedFrames: this.droppedFrames
        });
        return;
      }
      const samples = data.samples;
      if (!samples || !samples.length) return;

      // Drop oldest queued audio first: never let latency grow.
      while (this.queued + samples.length > this.maxQueueSamples && this.chunks.length) {
        const head = this.chunks[0];
        const lost = head.length - this.offset;
        this.droppedSamples += lost;
        this.droppedFrames += 1;
        this.queued -= lost;
        this.chunks.shift();
        this.offset = 0;
      }
      if (this.queued + samples.length > this.maxQueueSamples) {
        // Single frame larger than the whole budget: keep only its tail.
        const keep = this.maxQueueSamples;
        this.droppedSamples += samples.length - keep;
        this.droppedFrames += 1;
        this.chunks.push(samples.subarray(samples.length - keep));
        this.queued = keep;
        return;
      }
      this.chunks.push(samples);
      this.queued += samples.length;
    };
  }

  process(_inputs, outputs) {
    const out = outputs && outputs[0] && outputs[0][0];
    if (!out) return true;

    let written = 0;
    while (written < out.length) {
      if (!this.chunks.length) {
        out.fill(0, written);
        break;
      }
      const head = this.chunks[0];
      const available = head.length - this.offset;
      const take = Math.min(available, out.length - written);
      out.set(head.subarray(this.offset, this.offset + take), written);
      this.offset += take;
      written += take;
      this.queued -= take;
      if (this.offset >= head.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    // If the queue ran dry mid-block the tail is already zero-filled above.
    return true;
  }
}

registerProcessor('aura-pcm', AuraPcmSink);
