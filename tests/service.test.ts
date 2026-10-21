import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalService, portAnswers } from '../src/index.ts';

/** A stand-in for a local model server: answers /docs, exits on /control, notes each start. */
const FAKE_API = `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
fs.appendFileSync(path.join(__dirname, 'starts.txt'), 'x');
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/docs')) { res.writeHead(200).end('docs'); return; }
  if (req.url.startsWith('/control')) { res.writeHead(200).end('bye'); setTimeout(() => process.exit(0), 20); return; }
  res.writeHead(404).end();
});
server.listen(port, '127.0.0.1');
`;

const children: ChildProcess[] = [];
const services: LocalService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  for (const c of children.splice(0)) { try { c.kill(); } catch { /* gone */ } }
});

function fixture(port: number) {
  const dir = mkdtempSync(join(tmpdir(), 'svc-'));
  writeFileSync(join(dir, 'api.cjs'), FAKE_API);
  const base = `http://127.0.0.1:${port}`;
  const service = new LocalService({
    command: () => ({ cwd: dir, exe: process.execPath, args: ['api.cjs', '--port', String(port)] }),
    health: () => portAnswers(base, 300),
    listening: () => portAnswers(base, 300),
    gracefulStop: async () => {
      await fetch(`${base}/control?command=exit`).catch(() => undefined);
    },
    timeoutMs: 15_000,
    pollMs: 200,
    stopGraceMs: 3000,
  });
  services.push(service);
  return { dir, base, service };
}

const starts = (dir: string): number => {
  try { return readFileSync(join(dir, 'starts.txt'), 'utf8').length; } catch { return 0; }
};

describe('a local speech service', () => {
  it('starts once, waits for it, and stops it again', async () => {
    const port = 43981;
    const { dir, base, service } = fixture(port);
    expect(service.status().phase).toBe('off');
    expect(await service.ensure()).toBe(true);
    expect(service.status()).toMatchObject({ phase: 'ready', owned: true });
    expect(starts(dir)).toBe(1);
    // a second ask joins the ready one
    expect(await service.ensure()).toBe(true);
    expect(starts(dir)).toBe(1);

    await service.stop();
    expect(service.status().phase).toBe('off');
    await expect.poll(() => portAnswers(base, 300), { timeout: 5000 }).toBe(false);
  }, 30_000);

  it('adopts a service someone else started, and leaves it running', async () => {
    const port = 43982;
    const { dir, base, service } = fixture(port);
    const own = spawn(process.execPath, [join(dir, 'api.cjs'), '--port', String(port)], { cwd: dir, stdio: 'ignore' });
    children.push(own);
    await expect.poll(() => portAnswers(base, 300), { timeout: 8000 }).toBe(true);

    expect(await service.ensure()).toBe(true);
    expect(service.status()).toMatchObject({ phase: 'ready', owned: false, external: true });
    expect(starts(dir)).toBe(1);

    await service.stop();
    expect(service.status().phase).toBe('off');
    expect(await portAnswers(base, 300)).toBe(true);
  }, 30_000);

  it('fails with a reason when there is nothing to run', async () => {
    const port = 43983;
    const { base } = fixture(port);
    const broken = new LocalService({
      command: () => null,
      health: () => portAnswers(base, 200),
      timeoutMs: 5000,
      pollMs: 200,
    });
    services.push(broken);
    expect(await broken.ensure()).toBe(false);
    expect(broken.status()).toMatchObject({ phase: 'failed', owned: false });
    expect(broken.status().detail).toContain('没有配置');
    // and it does not claim to be ready when asked again by the settings page
    expect((await broken.refresh()).phase).toBe('off');
  }, 20_000);
});
