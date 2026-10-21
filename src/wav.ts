/**
 * The speech audio itself: how long a WAV runs, and a guess for the others.
 *
 * There is no audio decoder in this package on purpose. A WAV header is enough for the one thing the
 * pet needs from the server — how long the line will take — and every other backend either reports a
 * duration or is decoded by the browser, which knows the real length once the bytes are decoded
 * (`web/player.js` uses `AudioBuffer.duration`, so a guessed value only affects the first frame).
 */

/** Seconds of a PCM WAV, from its `fmt ` and `data` chunks; 0 when it is not one. */
export function wavSeconds(bytes: Uint8Array): number {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return 0;
  let channels = 0, rate = 0, bits = 0, dataLen = 0;
  for (let off = 12; off + 8 <= buf.length;) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      rate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      dataLen = Math.min(size, buf.length - off - 8);
      break;
    }
    off += 8 + size + (size % 2);
  }
  const frame = channels * (bits / 8);
  return frame > 0 && rate > 0 ? dataLen / (frame * rate) : 0;
}

/** Characters a second, as a rough speaking rate: CJK about five, Latin letters about fourteen. */
const CJK_PER_SECOND = 5;
const LETTERS_PER_SECOND = 14;

/**
 * Roughly how long `text` takes to say when the backend cannot tell: counted as CJK characters at
 * 5/s and everything else at 14/s, divided by `speed`. Only used for backends whose audio is not a
 * WAV (the browser corrects it once the clip is decoded).
 */
export function estimateSeconds(text: string, speed = 1): number {
  const dense = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) ?? []).length;
  const rest = text.length - dense;
  const seconds = dense / CJK_PER_SECOND + rest / LETTERS_PER_SECOND;
  return Math.max(.3, seconds / (speed > 0 ? speed : 1));
}
