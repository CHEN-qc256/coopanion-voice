/**
 * Anything else, as a declarative description of the HTTP call: Azure's SSML endpoint, CosyVoice's
 * `/inference_sft`, Fish Audio, a home-made Flask service, an internal gateway.
 *
 * ```ts
 * httpTts({
 *   name: 'cosyvoice',
 *   url: () => 'http://127.0.0.1:50000/inference_sft',
 *   json: (req) => ({ tts_text: req.text, spk_id: req.voice ?? '中文女' }),
 *   healthUrl: 'http://127.0.0.1:50000/docs',
 * })
 * ```
 *
 * When the body is not JSON — Azure wants SSML and a `X-Microsoft-OutputFormat` header — use `raw`.
 * See `docs/backends.md` for the Azure and CosyVoice cases written out.
 */
import { failure, type BackendCall, type RawClip, type TtsBackend, type TtsRequest } from './types.ts';

export interface HttpTtsSpec {
  /** Shown in logs and the settings page. */
  name: string;
  /** Where to POST the text. */
  url: string | ((req: TtsRequest) => string);
  /** Written as JSON; omit when `raw` builds the body. */
  json?: (req: TtsRequest) => unknown;
  /** A body of your own, with its content type (SSML, form data, a wrapper object). */
  raw?: (req: TtsRequest) => { body: string | Uint8Array; contentType: string };
  /** Headers for the synthesize call, e.g. a key or an output format. */
  headers?: Record<string, string> | ((req: TtsRequest) => Record<string, string>);
  /** MIME of the answer; `audio/wav` when absent. */
  mime?: string | ((req: TtsRequest) => string);
  /** A URL that answers 2xx when the service is up; without it the status line says unknown. */
  healthUrl?: string;
  /** Voices to offer in the settings page. */
  voices?: string[];
}

export function httpTts(spec: HttpTtsSpec): TtsBackend {
  return {
    name: spec.name,
    voices: () => spec.voices ?? [],

    async health({ fetch, signal }) {
      if (!spec.healthUrl) return true;
      try {
        const res = await fetch(spec.healthUrl, { signal });
        return res.ok;
      } catch {
        return false;
      }
    },

    async synthesize(req: TtsRequest, call: BackendCall): Promise<RawClip> {
      const url = typeof spec.url === 'function' ? spec.url(req) : spec.url;
      const headers: Record<string, string> = typeof spec.headers === 'function' ? spec.headers(req) : { ...spec.headers };
      let body: string | Uint8Array | undefined;
      if (spec.raw) {
        const made = spec.raw(req);
        body = made.body;
        headers['content-type'] = made.contentType;
      } else if (spec.json) {
        body = JSON.stringify(spec.json(req));
        headers['content-type'] = 'application/json';
      }
      const res = await call.fetch(url, { method: 'POST', headers, body, signal: call.signal });
      if (!res.ok) throw await failure(res);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mime = typeof spec.mime === 'function' ? spec.mime(req) : spec.mime ?? 'audio/wav';
      return { bytes, mime };
    },
  };
}
