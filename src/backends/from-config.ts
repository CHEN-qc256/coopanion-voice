/**
 * One function from "what the config says" to "a backend", so a pet (or the demo) can switch voices
 * without touching the code that synthesizes. The pet's `worlds.desktop-pet.voice` section maps onto
 * `VoiceBackendConfig` field for field; see `docs/integration.md`.
 */
import { gptSovits } from './gpt-sovits.ts';
import { httpTts, type HttpTtsSpec } from './http.ts';
import { openaiTts } from './openai.ts';
import type { TtsBackend } from './types.ts';

export type BackendKind = 'gpt-sovits' | 'openai' | 'http';

export interface VoiceBackendConfig {
  /** Which family of API; `gpt-sovits` when absent. */
  backend?: BackendKind;
  /** Service address: the GPT-SoVITS API, or the base URL of an OpenAI-compatible one. */
  apiBase?: string;
  /** GPT-SoVITS only: directory of `<voice>.wav` + `<voice>.txt`. */
  refDir?: string;
  /** GPT-SoVITS only: language of the reference text (`zh`). */
  promptLang?: string;
  /** Language of the synthesized text. */
  textLang?: string;
  /** OpenAI-compatible only. */
  apiKey?: string;
  model?: string;
  format?: 'wav' | 'mp3';
  /** OpenAI-compatible only: extra body fields (`instructions`, `language`, …). */
  extra?: Record<string, unknown>;
  /** `http` only: the call, written out (`docs/backends.md`). */
  http?: HttpTtsSpec;
  /** Voices the settings page should offer when the backend cannot list them itself. */
  voices?: string[];
}

/** Builds the backend the config names; throws when it names `http` without a spec. */
export function backendFromConfig(cfg: VoiceBackendConfig): TtsBackend {
  switch (cfg.backend ?? 'gpt-sovits') {
    case 'openai':
      return openaiTts({
        apiBase: cfg.apiBase,
        apiKey: cfg.apiKey,
        model: cfg.model,
        format: cfg.format,
        extra: cfg.extra,
        voice: cfg.voices?.[0],
      });
    case 'http': {
      if (!cfg.http) throw new Error('voice.backend 是 http，但没有给 voice.http 的调用描述');
      const made = httpTts({ voices: cfg.voices, ...cfg.http });
      return {
        ...made,
        // the settings page reads `voices` from the backend; keep the configured list when given
        voices: () => cfg.voices ?? made.voices?.() ?? [],
      };
    }
    default:
      return gptSovits({
        apiBase: cfg.apiBase?.trim() || 'http://127.0.0.1:9880',
        refDir: cfg.refDir?.trim() || 'refs',
        textLang: cfg.textLang,
        promptLang: cfg.promptLang,
      });
  }
}
