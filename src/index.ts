/**
 * coopanion-voice: text-to-speech for the Coopanion desktop pet, with the backend behind an interface.
 *
 * ```ts
 * import { AudioBank, LocalService, TtsClient, gptSovits, portAnswers } from 'coopanion-voice';
 *
 * const client = new TtsClient(gptSovits({ apiBase: 'http://127.0.0.1:9880', refDir: 'D:/GPT-SoVITS-runtime/refs' }));
 * const clip = await client.speak({ text: '你好呀。' });
 * ```
 *
 * The pieces:
 *
 * - `TtsClient` — the queue, the cache, the timeouts (`src/client.ts`).
 * - `gptSovits` / `openaiTts` / `httpTts` — backends (`src/backends/`); add your own in one file.
 * - `LocalService` — starts a local model with the pet and stops it again (`src/service.ts`).
 * - `AudioBank` — hands the page its audio by content hash (`src/audio-bank.ts`).
 * - `web/player.js` — plays it in the pet window, with volume and a pitch shift that keeps the pace.
 * - `web/voiceout.*` — the settings page, served at `/voiceout` (`examples/server.ts` shows the routes).
 */
export { AudioBank } from './audio-bank.ts';
export { TtsClient, type Clip, type TtsClientOptions } from './client.ts';
export { estimateSeconds, wavSeconds } from './wav.ts';
export { localFetch, type FetchLike } from './no-proxy-fetch.ts';
export { LocalService, portAnswers } from './service.ts';
export type { LocalServiceOptions, ServiceCommand, ServicePhase, ServiceStatus } from './service.ts';
export { gptSovits, pickVoice, refVoices } from './backends/gpt-sovits.ts';
export type { GptSovitsOptions, RefVoice } from './backends/gpt-sovits.ts';
export { openaiTts, OPENAI_VOICES } from './backends/openai.ts';
export type { OpenAiTtsOptions } from './backends/openai.ts';
export { httpTts } from './backends/http.ts';
export type { HttpTtsSpec } from './backends/http.ts';
export { backendFromConfig, type BackendKind, type VoiceBackendConfig } from './backends/from-config.ts';
export type { BackendCall, RawClip, TtsBackend, TtsRequest } from './backends/types.ts';
