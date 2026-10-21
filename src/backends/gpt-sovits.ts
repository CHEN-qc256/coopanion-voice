/**
 * GPT-SoVITS, the local voice these files were written for (`api_v2.py`, MIT).
 *
 * Its API takes a *reference recording* per call instead of a voice name: `/tts` wants
 * `ref_audio_path` and the exact text that recording says (`prompt_text`). So a "voice" here is a
 * pair of files, `<voice>.wav` and `<voice>.txt`, in `refDir`; the timbre — and most of the emotion —
 * comes from that recording, which is why the pet picks a file rather than passing a parameter.
 *
 * GPT-SoVITS v3 and newer refuse an empty `prompt_text` (`prompt_text cannot be empty when using
 * SoVITS_V3`), so keep the `.txt` next to every `.wav`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wavSeconds } from '../wav.ts';
import { failure, type BackendCall, type RawClip, type TtsBackend, type TtsRequest } from './types.ts';

/** One reference recording, and the text it says. */
export interface RefVoice {
  id: string;
  audio: string;
  promptText: string;
}

/** The references in `dir`, `default` first; empty when the directory is not there. */
export function refVoices(dir: string): RefVoice[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const voices = names.filter((n) => n.toLowerCase().endsWith('.wav')).map((name): RefVoice => {
    const id = name.slice(0, -4);
    let promptText = '';
    try {
      const txt = join(dir, `${id}.txt`);
      if (existsSync(txt)) promptText = readFileSync(txt, 'utf8').trim();
    } catch {
      promptText = '';
    }
    return { id, audio: join(dir, name), promptText };
  });
  const rank = (v: RefVoice): number => (v.id.toLowerCase() === 'default' ? 0 : 1);
  return voices.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

/** The voice `id`, else `default`, else the first one; null when `dir` holds none. */
export function pickVoice(voices: readonly RefVoice[], id: string | undefined): RefVoice | null {
  return voices.find((v) => v.id === id)
    ?? voices.find((v) => v.id.toLowerCase() === 'default')
    ?? voices[0]
    ?? null;
}

export interface GptSovitsOptions {
  /** The API, e.g. `http://127.0.0.1:9880`. */
  apiBase: string;
  /** Directory of `<voice>.wav` + `<voice>.txt`. */
  refDir: string;
  /** Language of the reference text; the recordings here are Chinese. */
  promptLang?: string;
  /** Language of the text to synthesize; falls back to `req.lang`, then `zh`. */
  textLang?: string;
  /** Voice when the request does not name one. */
  voice?: string;
  /** `cut0`–`cut5`, or `auto`; `cut5` (by punctuation, then 50 characters) suits dialogue. */
  splitMethod?: string;
  /** The audio format, `wav` / `ogg` / `aac`; only `wav` lets the client read its own length. */
  mediaType?: 'wav' | 'ogg' | 'aac';
}

export function gptSovits(opts: GptSovitsOptions): TtsBackend {
  const base = opts.apiBase.trim().replace(/\/+$/, '');
  const media = opts.mediaType ?? 'wav';
  const voices = (): RefVoice[] => refVoices(opts.refDir);

  return {
    name: 'gpt-sovits',
    voices: () => voices().map((v) => v.id),

    async health({ fetch, signal }) {
      try {
        const res = await fetch(`${base}/docs`, { signal });
        return res.ok;
      } catch {
        return false;
      }
    },

    async synthesize(req: TtsRequest, call: BackendCall): Promise<RawClip> {
      const ref = pickVoice(voices(), req.voice ?? opts.voice);
      if (!ref) throw new Error(`没有可用的参考音频：${opts.refDir}`);
      const body = JSON.stringify({
        text: req.text,
        text_lang: req.lang ?? opts.textLang ?? 'zh',
        ref_audio_path: ref.audio,
        prompt_text: ref.promptText,
        prompt_lang: opts.promptLang ?? 'zh',
        text_split_method: opts.splitMethod ?? 'cut5',
        speed_factor: req.speed ?? 1,
        media_type: media,
        streaming_mode: false,
        parallel_infer: false,
        batch_size: 1,
      });
      const res = await call.fetch(`${base}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: call.signal,
      });
      if (!res.ok) throw await failure(res);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (media === 'wav') {
        const seconds = wavSeconds(bytes);
        if (!seconds) throw new Error('答复不是 WAV 音频');
        return { bytes, mime: 'audio/wav', seconds };
      }
      return { bytes, mime: media === 'ogg' ? 'audio/ogg' : 'audio/aac' };
    },

    /** `/control?command=exit` is how `api_v2.py` shuts itself down. */
    async stop() {
      try {
        await fetchLike(`${base}/control?command=exit`);
      } catch {
        /* already gone */
      }
    },
  };
}

/** A tiny GET for `stop`, which must not wait on anything. */
async function fetchLike(url: string): Promise<void> {
  const { request } = await import('node:http');
  await new Promise<void>((done) => {
    const target = new URL(url);
    const req = request({ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: 'GET', timeout: 2500 }, (res) => {
      res.resume();
      res.on('end', () => done());
      res.on('error', () => done());
    });
    req.on('timeout', () => { req.destroy(); done(); });
    req.on('error', () => done());
    req.end();
  });
}
