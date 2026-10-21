/**
 * Synthesize one line to a file — the smallest useful thing this package does.
 *
 * ```
 * npm run say -- "你好呀,我是库。" out.wav
 * npm run say -- "Hello there." out.wav --voice 申鹤 --speed 1.2
 * TTS_BACKEND=openai OPENAI_API_KEY=sk-… npm run say -- "Hello." hello.wav
 * ```
 */
import { writeFileSync } from 'node:fs';
import { TtsClient } from '../src/index.ts';
import { backendFromEnv, env } from './config.ts';

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const text = argv.find((a) => !a.startsWith('--') && a !== flag('voice') && a !== flag('speed'));
if (!text) {
  console.error('usage: npm run say -- "要念的话" [out.wav] [--voice <名字>] [--speed 1.0]');
  process.exit(2);
}
const out = argv.filter((a) => !a.startsWith('--')).find((a) => a.endsWith('.wav') || a.endsWith('.mp3')) ?? 'out.wav';

const client = new TtsClient(backendFromEnv(), { log: (line) => console.log(line) });
const started = Date.now();
try {
  const clip = await client.speak({ text, voice: flag('voice'), speed: Number(flag('speed', '1')) });
  writeFileSync(out, clip.bytes);
  const took = ((Date.now() - started) / 1000).toFixed(2);
  console.log(`✓ ${out}: ${clip.seconds.toFixed(2)}s 音频 (${clip.mime}), 用时 ${took}s${clip.cached ? ', 来自缓存' : ''}`);
  console.log(`  backend: ${env.backend}, api: ${env.backend === 'openai' ? process.env.OPENAI_BASE_URL ?? 'openai' : env.gptSovitsApi}`);
} catch (err) {
  console.error(`✗ ${(err as Error).message}`);
  process.exit(1);
}
