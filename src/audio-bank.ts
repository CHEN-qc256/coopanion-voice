/**
 * The audio the page fetches, by content hash: `/api/voice/<id>.wav`. Content addressing means the
 * same line served twice gets the same URL, so the browser decodes it once, and nothing has to be
 * cleaned up by name.
 *
 * Old clips are dropped oldest-first once the bank holds too many or too many bytes — a pet line is a
 * few hundred kilobytes, so 48 MB / 24 clips leaves plenty of room for the ones still on screen.
 */
import { createHash } from 'node:crypto';

export class AudioBank {
  private readonly clips = new Map<string, { bytes: Uint8Array; at: number }>();

  constructor(
    private readonly maxBytes = 48 * 1024 * 1024,
    private readonly maxItems = 24,
  ) {}

  /** Files `bytes` and returns the id the page asks for. */
  put(bytes: Uint8Array): string {
    const id = createHash('sha1').update(bytes).digest('hex').slice(0, 20);
    this.clips.delete(id);
    this.clips.set(id, { bytes, at: Date.now() });
    let total = 0;
    for (const clip of this.clips.values()) total += clip.bytes.byteLength;
    for (const [key, clip] of this.clips) {
      if (this.clips.size <= this.maxItems && total <= this.maxBytes) break;
      this.clips.delete(key);
      total -= clip.bytes.byteLength;
    }
    return id;
  }

  get(id: string): Uint8Array | null {
    return this.clips.get(id)?.bytes ?? null;
  }

  clear(): void {
    this.clips.clear();
  }
}
