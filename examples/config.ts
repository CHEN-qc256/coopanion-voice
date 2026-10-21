/**
 * The demo's configuration, from the environment, so the examples run without editing any file.
 *
 * ```
 * TTS_BACKEND      gpt-sovits | openai | cosyvoice      (default: gpt-sovits)
 *
 * gpt-sovits:      GPT_SOVITS_API  http://127.0.0.1:9880
 *                  REFS_DIR        ./refs        <voice>.wav + <voice>.txt
 *                  GPT_SOVITS_DIR  (optional)    the app directory, to let the demo start it
 *                  GPT_SOVITS_ARGS (optional)    arguments; default api_v2.py -a host -p port -c …
 *
 * openai:          OPENAI_API_KEY, OPENAI_BASE_URL (https://api.openai.com/v1),
 *                  OPENAI_MODEL (gpt-4o-mini-tts), OPENAI_VOICE (alloy), OPENAI_FORMAT (wav|mp3)
 *
 * cosyvoice:       COSYVOICE_API  http://127.0.0.1:50000/inference_sft
 * ```
 */
import { join, resolve } from 'node:path';
import { httpTts, gptSovits, openaiTts, type TtsBackend } from '../src/index.ts';

export type BackendName = 'gpt-sovits' | 'openai' | 'cosyvoice';

export const env = {
  backend: (process.env.TTS_BACKEND ?? 'gpt-sovits') as BackendName,
  gptSovitsApi: process.env.GPT_SOVITS_API ?? 'http://127.0.0.1:9880',
  refsDir: resolve(process.env.REFS_DIR ?? 'refs'),
  gptSovitsDir: process.env.GPT_SOVITS_DIR ?? '',
  gptSovitsArgs: process.env.GPT_SOVITS_ARGS ?? '',
  port: Number(process.env.VOICE_PORT ?? 7999),
};

export function backendFromEnv(): TtsBackend {
  switch (env.backend) {
    case 'openai':
      return openaiTts({
        apiBase: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        apiKey: process.env.OPENAI_API_KEY ?? '',
        model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini-tts',
        voice: process.env.OPENAI_VOICE ?? 'alloy',
        format: (process.env.OPENAI_FORMAT as 'wav' | 'mp3') ?? 'wav',
      });
    case 'cosyvoice':
      return httpTts({
        name: 'cosyvoice',
        url: () => process.env.COSYVOICE_API ?? 'http://127.0.0.1:50000/inference_sft',
        json: (req) => ({ tts_text: req.text, spk_id: req.voice ?? '中文女' }),
        healthUrl: (process.env.COSYVOICE_API ?? 'http://127.0.0.1:50000/inference_sft').replace(/\/inference_sft$/, '/docs'),
        voices: ['中文女', '中文男', '英文女', '英文男', '日语男', '粤语女', '韩语女'],
      });
    default:
      return gptSovits({ apiBase: env.gptSovitsApi, refDir: env.refsDir });
  }
}

/** The command that starts the local GPT-SoVITS, when `GPT_SOVITS_DIR` is set. */
export function gptSovitsCommand(): { cwd: string; exe: string; args: string[] } | null {
  const dir = env.gptSovitsDir.trim();
  if (!dir) return null;
  const target = new URL(env.gptSovitsApi);
  const args = env.gptSovitsArgs.trim()
    ? env.gptSovitsArgs.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? []
    : ['api_v2.py', '-a', target.hostname || '127.0.0.1', '-p', target.port || '9880', '-c', 'GPT_SoVITS/configs/tts_infer.yaml'];
  return { cwd: dir, exe: join(dir, 'runtime', 'python.exe'), args };
}
