/**
 * A stand-alone demo of the whole thing, without Coopanion: the settings page, the player, the audio,
 * and the four endpoints it talks to. Everything is served on 127.0.0.1 only.
 *
 * ```
 * npm run demo            # http://127.0.0.1:7999/voiceout
 * ```
 *
 * With `GPT_SOVITS_DIR` set and `TTS_BACKEND=gpt-sovits`, the 启动 button (and `auto`) brings the
 * Python model up the same way the pet does — see `docs/integration.md` for the real wiring.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioBank, LocalService, TtsClient, portAnswers } from '../src/index.ts';
import { backendFromEnv, env, gptSovitsCommand } from './config.ts';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const WEB_ROOT = normalize(WEB).replace(/[\\/]+$/, '') + sep;

const backend = backendFromEnv();
const client = new TtsClient(backend, { log: (line) => console.log(`· ${line}`) });
const bank = new AudioBank();
const settings = {
  enabled: true,
  read: 'all' as 'all' | 'speak' | 'off',
  voice: backend.voices?.()[0] ?? 'default',
  speed: 1,
  volume: .85,
  pitch: 0,
  service: { auto: false },
};

const service = new LocalService({
  command: () => (env.backend === 'gpt-sovits' ? gptSovitsCommand() : null),
  health: () => client.health(),
  listening: () => portAnswers(env.gptSovitsApi),
  gracefulStop: async () => { await backend.stop?.(); },
  log: (line) => console.log(`· ${line}`),
});

/** The MIME of an audio clip, by looking at its first bytes. */
function mimeOf(bytes: Uint8Array): string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(12, bytes.byteLength));
  if (b.toString('latin1', 0, 4) === 'RIFF') return 'audio/wav';
  if (b.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg';
  if (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xFF && (b[1] ?? 0) >= 0xE0)) return 'audio/mpeg';
  return 'application/octet-stream';
}

async function state(): Promise<Record<string, unknown>> {
  return {
    settings: {
      enabled: settings.enabled, read: settings.read, voice: settings.voice,
      speed: settings.speed, volume: settings.volume, pitch: settings.pitch,
      apiBase: env.backend === 'openai' ? process.env.OPENAI_BASE_URL ?? 'openai' : env.gptSovitsApi,
      refDir: env.refsDir,
    },
    voices: backend.voices?.() ?? [],
    service: { ...(await service.refresh()), auto: settings.service.auto },
    limits: { speed: [.6, 1.6], pitch: [-6, 6] },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/api/voiceout') return json(res, 200, await state());

    if (req.method === 'POST' && path === '/api/voiceout') {
      const patch = JSON.parse(await body(req) || '{}') as Record<string, unknown>;
      if (typeof patch.enabled === 'boolean') settings.enabled = patch.enabled;
      if (patch.read === 'all' || patch.read === 'speak' || patch.read === 'off') settings.read = patch.read;
      if (typeof patch.voice === 'string' && patch.voice) settings.voice = patch.voice;
      if (typeof patch.speed === 'number') settings.speed = Math.min(1.6, Math.max(.6, patch.speed));
      if (typeof patch.volume === 'number') settings.volume = Math.min(1, Math.max(0, patch.volume));
      if (typeof patch.pitch === 'number') settings.pitch = Math.min(6, Math.max(-6, Math.round(patch.pitch)));
      const svc = patch.service as { auto?: boolean } | undefined;
      if (svc && typeof svc.auto === 'boolean') {
        settings.service.auto = svc.auto;
        if (svc.auto) void service.ensure();
      }
      return json(res, 200, await state());
    }

    if (req.method === 'POST' && path === '/api/voiceout/preview') {
      const { text } = JSON.parse(await body(req) || '{}') as { text?: string };
      if (typeof text !== 'string' || !text.trim()) return json(res, 400, { error: 'text is empty' });
      try {
        const clip = await client.speak({ text, voice: settings.voice, speed: settings.speed });
        const id = bank.put(clip.bytes);
        return json(res, 200, { url: `/api/voice/${id}`, seconds: clip.seconds, mime: clip.mime });
      } catch (err) {
        return json(res, 200, { error: (err as Error).message });
      }
    }

    if (req.method === 'POST' && path === '/api/voiceout/service') {
      const { action } = JSON.parse(await body(req) || '{}') as { action?: string };
      if (action === 'stop') await service.stop();
      else void service.ensure();
      return json(res, 200, { service: { ...service.status(), auto: settings.service.auto } });
    }

    if (req.method === 'GET' && path.startsWith('/api/voice/')) {
      const id = path.slice('/api/voice/'.length).replace(/\.[a-z0-9]+$/i, '');
      const bytes = /^[\da-f]{8,64}$/.test(id) ? bank.get(id) : null;
      if (!bytes) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': mimeOf(bytes), 'content-length': bytes.byteLength, 'cache-control': 'no-store' });
      res.end(Buffer.from(bytes));
      return;
    }

    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (path === '/') { res.writeHead(302, { location: '/voiceout' }).end(); return; }
    const file = path === '/voiceout' ? 'voiceout.html' : path.replace(/^\//, '');
    const full = normalize(join(WEB_ROOT, file));
    if (!full.startsWith(WEB_ROOT)) { res.writeHead(403).end(); return; }
    const bytes = await readFile(full).catch(() => null);
    if (!bytes) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(bytes);
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

server.listen(env.port, '127.0.0.1', () => {
  console.log(`语音输出设置: http://127.0.0.1:${env.port}/voiceout`);
  console.log(`后端: ${backend.name} · 音色: ${(backend.voices?.() ?? []).join(', ') || '(无)'}`);
  console.log(env.backend === 'gpt-sovits'
    ? `服务: ${env.gptSovitsApi}${env.gptSovitsDir ? ` (可由本页启动: ${env.gptSovitsDir})` : ' (手动启动;设 GPT_SOVITS_DIR 后可在本页启动)'}`
    : '服务: 由后端自己管理');
});
