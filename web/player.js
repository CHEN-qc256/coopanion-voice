/**
 * The browser side: the recordings the server synthesized, decoded and played, with the volume and the
 * pitch the person picked.
 *
 * `play(url)` returns at once with a clip the caller watches:
 *
 * - `started` — its first sample is playing (the fetch and decode are async);
 * - `seconds` — its length, from the decoded buffer, so it is exact;
 * - `elapsed` — how far it has got, updated 25 times a second;
 * - `ended` — it finished, or it could not play at all (`failed` says which).
 *
 * That is everything a speech bubble needs: type the text along `seconds`, keep the bubble up until
 * `ended`, move the mouth on `onFrame`.
 *
 * Pitch: `shiftPitch` moves the recording up or down in semitones **without changing its length**, by
 * resampling (which moves both) and then stretching the result back with overlapping grains. 0 returns
 * the buffer untouched; ±6 semitones still sounds like speech.
 */

/** How often the clip's elapsed time is taken, in ms; the mouth moves on every third. */
const TICK_MS = 40;
const MOUTH_TICKS = 3;

/**
 * `buffer` a few semitones higher or lower, at the same length and sample count.
 * `ctx` only needs `createBuffer`.
 */
export function shiftPitch(ctx, buffer, semitones) {
  const ratio = 2 ** (semitones / 12);
  const n = buffer.length, chs = buffer.numberOfChannels, sr = buffer.sampleRate;
  if (Math.abs(ratio - 1) < .003 || n < 512) return buffer;
  // 1. read `ratio` samples per output sample: pitch up by `ratio`, length divided by it
  const m = Math.max(256, Math.round(n / ratio));
  const middle = [];
  for (let c = 0; c < chs; c++) {
    const src = buffer.getChannelData(c), out = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      const p = i * ratio, j = Math.floor(p), f = p - j;
      out[i] = (src[j] ?? 0) * (1 - f) + (src[j + 1] ?? src[j] ?? 0) * f;
    }
    middle.push(out);
  }
  // 2. overlap-add back to `n`: Hann grains at half overlap add up to one
  const out = ctx.createBuffer(chs, n, sr);
  const G = Math.max(256, Math.round(sr * .04));
  const hop = G >> 1;
  const step = m / n;
  const win = new Float32Array(G);
  for (let j = 0; j < G; j++) win[j] = .5 - .5 * Math.cos(2 * Math.PI * j / G);
  for (let c = 0; c < chs; c++) {
    const src = middle[c], dst = out.getChannelData(c);
    for (let k = 0; k * hop < n; k++) {
      const from = Math.round(k * hop * step), to = k * hop;
      for (let j = 0; j < G; j++) {
        const i = from + j, o = to + j;
        if (i >= m || o >= n) break;
        dst[o] += src[i] * win[j];
      }
    }
  }
  return out;
}

/**
 * `audio()` returns `{ ctx, master }` — the audio context and the gain node the voice plays into — or
 * null while it would not be heard (window hidden, context not unlocked yet). `onFrame` runs while a
 * clip plays, for a mouth that moves with it. `keep` clips are decoded and kept, most recent last.
 */
export function createPlayer({ audio, onFrame = () => {}, keep = 24, volume = 1, pitch = 0 } = {}) {
  /** The clip playing; its timer moves the mouth and keeps `elapsed` current. */
  let current = null, ticker = null, ticks = 0;
  /** Bumped by every stop: a clip whose fetch lands after that is dropped. */
  let seq = 0;
  let gain = volume, semitones = pitch;
  /** `url|pitch` → decoded audio (already shifted), most recently used last. */
  const decoded = new Map();

  function load(url, ctx) {
    const key = `${url}|${semitones}`;
    let p = decoded.get(key);
    if (p) {
      decoded.delete(key);
      decoded.set(key, p);
      return p;
    }
    p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((bytes) => ctx.decodeAudioData(bytes))
      .then((buf) => (semitones ? shiftPitch(ctx, buf, semitones) : buf));
    p.catch(() => decoded.delete(key));
    decoded.set(key, p);
    while (decoded.size > keep) decoded.delete(decoded.keys().next().value);
    return p;
  }

  function stop() {
    seq++;
    if (ticker) { clearInterval(ticker); ticker = null; }
    const c = current;
    current = null;
    if (c) {
      try { c.src.stop(); } catch { /* never started */ }
      c.clip.ended = true;
    }
  }

  return {
    play(url) {
      stop();
      const mine = seq;
      const clip = { url, seconds: 0, elapsed: 0, started: false, ended: false, failed: false };
      const out = audio?.();
      if (!out) { clip.ended = true; clip.failed = true; return clip; }
      load(url, out.ctx).then((buf) => {
        if (mine !== seq) { clip.ended = true; return; }
        const src = out.ctx.createBufferSource(), g = out.ctx.createGain();
        src.buffer = buf;
        g.gain.value = gain;
        src.connect(g);
        g.connect(out.master);
        src.onended = () => {
          clip.ended = true;
          clip.elapsed = clip.seconds;
          if (current?.clip === clip) {
            current = null;
            clearInterval(ticker);
            ticker = null;
          }
        };
        current = { src, gain: g, clip };
        clip.seconds = buf.duration;
        clip.started = true;
        ticks = 0;
        const began = out.ctx.currentTime;
        src.start();
        ticker = setInterval(() => {
          clip.elapsed = Math.max(0, out.ctx.currentTime - began);
          if (++ticks % MOUTH_TICKS === 0) onFrame();
        }, TICK_MS);
      }, (err) => {
        console.error('语音没能播放:', err);
        clip.failed = true;
        clip.ended = true;
      });
      return clip;
    },
    stop,
    /** The volume now (on the clip playing too), and the pitch for the next one. */
    set({ volume: v, pitch: p } = {}) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        gain = Math.min(1, Math.max(0, v));
        if (current) current.gain.gain.value = gain;
      }
      if (typeof p === 'number' && Number.isFinite(p) && Math.round(p) !== semitones) semitones = Math.round(p);
    },
    get settings() { return { volume: gain, pitch: semitones }; },
  };
}
