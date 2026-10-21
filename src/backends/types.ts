/**
 * What a TTS backend has to provide. Everything above it — the queue, the cache, the audio the pet
 * page fetches — is backend-agnostic, so a new API means one file here and one line where the client
 * is built (see `docs/backends.md`).
 */
import type { FetchLike } from '../no-proxy-fetch.ts';

/** One line to synthesize. */
export interface TtsRequest {
  text: string;
  /** The voice, in whatever the backend calls it: a reference recording's name, OpenAI's `alloy`, Azure's voice id. */
  voice?: string;
  /** Speaking rate, 1 being the recorded pace. */
  speed?: number;
  /** Language of the text (`zh`, `en`, `ja`, `ko`, `yue`, `auto`); the backend uses it if it cares. */
  lang?: string;
}

/** Audio a backend answered with. */
export interface RawClip {
  bytes: Uint8Array;
  /** `audio/wav`, `audio/mpeg` … */
  mime: string;
  /** How long it runs; left out when unknown (the client then estimates from the text). */
  seconds?: number;
}

/** What a backend gets to make its call. */
export interface BackendCall {
  /** Use this rather than the global `fetch`: it never goes through a proxy. */
  fetch: FetchLike;
  signal?: AbortSignal;
}

export interface TtsBackend {
  /** Shown in logs and in the settings page. */
  readonly name: string;
  /** Voices the settings page may offer; empty when the backend has none to pick. */
  voices?(): string[];
  synthesize(req: TtsRequest, call: BackendCall): Promise<RawClip>;
  /** Whether the service answers, for the status line and the 启动 button. */
  health?(call: BackendCall): Promise<boolean>;
  /** Called when the pet stops a local service: give it a chance to exit cleanly. */
  stop?(): Promise<void>;
}

/** Reads a response body as an error message, cut to something a tooltip can hold. */
export async function failure(res: Response): Promise<Error> {
  const said = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
  return new Error(`${res.status}${said ? `: ${said}` : ''}`);
}
