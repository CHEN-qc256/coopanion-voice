/**
 * An OpenAI-compatible speech endpoint (`POST {apiBase}/audio/speech`). Several servers speak the same
 * shape — OpenAI itself, LocalAI, LM Studio with a TTS plugin, vLLM-Omni, and most cloud gateways —
 * so this backend usually works for them by changing `apiBase` and the key.
 *
 * `response_format: 'wav'` is asked for by default: it is the one the client can measure, so the pet
 * knows how long a line runs before playing it.
 */
import { failure, type BackendCall, type RawClip, type TtsBackend, type TtsRequest } from './types.ts';

/** Voices OpenAI ships; a compatible server may take others, so any string is passed through. */
export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

export interface OpenAiTtsOptions {
  /** `https://api.openai.com/v1`, or your gateway's base URL. */
  apiBase?: string;
  /** Bearer token; empty for a local server that wants none. */
  apiKey?: string;
  /** `gpt-4o-mini-tts`, `tts-1`, or whatever your server calls it. */
  model?: string;
  /** Voice used when the request does not name one. */
  voice?: string;
  /** `wav` (measurable) or `mp3` (smaller, duration estimated). */
  format?: 'wav' | 'mp3';
  /** Extra fields the server understands, such as `instructions` or `language`. */
  extra?: Record<string, unknown>;
}

export function openaiTts(opts: OpenAiTtsOptions = {}): TtsBackend {
  const base = (opts.apiBase ?? 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  const format = opts.format ?? 'wav';

  return {
    name: 'openai',

    voices: () => OPENAI_VOICES,

    async health({ fetch, signal }) {
      // /models is the cheapest endpoint every compatible server has
      try {
        const res = await fetch(`${base}/models`, { headers: headers(), signal });
        return res.ok;
      } catch {
        return false;
      }
    },

    async synthesize(req: TtsRequest, call: BackendCall): Promise<RawClip> {
      const body = JSON.stringify({
        model: opts.model ?? 'gpt-4o-mini-tts',
        input: req.text,
        voice: req.voice ?? opts.voice ?? 'alloy',
        response_format: format,
        ...(req.speed && req.speed !== 1 ? { speed: Math.min(4, Math.max(.25, req.speed)) } : {}),
        ...(opts.extra ?? {}),
      });
      const res = await call.fetch(`${base}/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers() },
        body,
        signal: call.signal,
      });
      if (!res.ok) throw await failure(res);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { bytes, mime: format === 'wav' ? 'audio/wav' : 'audio/mpeg' };
    },
  };

  function headers(): Record<string, string> {
    return opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {};
  }
}
