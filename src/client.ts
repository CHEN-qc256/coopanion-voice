/**
 * The client the pet talks to: one synthesis at a time, a small cache, and errors that say what the
 * service said.
 *
 * Why one at a time: a local model on one GPU gains nothing from parallel requests (they fight for the
 * same memory), and a cloud API is usually rate limited per key. The queue also keeps the order the
 * lines were asked for, which matters when a bubble holds two sentences.
 *
 * Why a cache: a pet repeats itself ("早呀"、"我在这儿"), and a repeated line that costs nothing to
 * play is what makes the feature feel free. The key is backend + voice + language + speed + text.
 */
import { localFetch, type FetchLike } from './no-proxy-fetch.ts';
import type { TtsBackend, TtsRequest } from './backends/types.ts';
import { estimateSeconds, wavSeconds } from './wav.ts';

export interface Clip {
  bytes: Uint8Array;
  mime: string;
  /** Seconds it runs; a guess when the backend could not say. */
  seconds: number;
  /** `seconds` was estimated from the text, not read from the audio. */
  estimated: boolean;
  /** It came from the cache rather than from the service. */
  cached: boolean;
}

export interface TtsClientOptions {
  /** Defaults to `localFetch` (no proxy). Pass `fetch` to use the global one. */
  fetch?: FetchLike;
  /** Lines kept in memory, most recently used last; 32 by default. */
  cacheMax?: number;
  /** How long one synthesis may take; 120 s by default. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export class TtsClient {
  /** Requests run one after another; this is the tail of that chain. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<string, Omit<Clip, 'cached'>>();
  private readonly fetchImpl: FetchLike;
  private readonly cacheMax: number;
  private readonly timeoutMs: number;

  constructor(readonly backend: TtsBackend, opts: TtsClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? localFetch;
    this.cacheMax = opts.cacheMax ?? 32;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.log = opts.log;
  }

  private readonly log?: (line: string) => void;

  /** The voices the settings page may offer. */
  get voices(): string[] {
    return this.backend.voices?.() ?? [];
  }

  /** Whether the service answers. Backends without a health check count as up. */
  async health(): Promise<boolean> {
    if (!this.backend.health) return true;
    try {
      return await this.backend.health({ fetch: this.fetchImpl, signal: AbortSignal.timeout(2000) });
    } catch {
      return false;
    }
  }

  /** Synthesizes `req`, or returns the cached copy of the same line. */
  speak(req: TtsRequest): Promise<Clip> {
    const key = [this.backend.name, req.voice ?? '', req.lang ?? '', req.speed ?? 1, req.text].join('\u0000');
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve({ ...hit, cached: true });
    }
    const run = this.chain.then(async (): Promise<Clip> => {
      const again = this.cache.get(key);
      if (again) return { ...again, cached: true };
      const raw = await this.backend.synthesize(req, {
        fetch: this.fetchImpl,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const read = raw.mime.startsWith('audio/wav') ? wavSeconds(raw.bytes) : 0;
      const seconds = raw.seconds ?? (read || estimateSeconds(req.text, req.speed));
      const clip = { bytes: raw.bytes, mime: raw.mime, seconds, estimated: raw.seconds === undefined && !read };
      this.cache.set(key, clip);
      while (this.cache.size > this.cacheMax) this.cache.delete(this.cache.keys().next().value as string);
      this.log?.(`合成 ${req.text.length} 字 → ${seconds.toFixed(2)}s (${raw.mime})`);
      return { ...clip, cached: false };
    });
    // a failure must not break the queue for the lines after it
    this.chain = run.catch((err) => {
      this.log?.(`合成失败:${(err as Error).message}`);
      return undefined;
    });
    return run;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
