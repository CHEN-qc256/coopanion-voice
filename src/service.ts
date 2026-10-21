/**
 * A local TTS server as a child of whatever hosts this package — for GPT-SoVITS a Python process that
 * takes 20–60 seconds to load its models, for CosyVoice or XTTS something similar.
 *
 * The order matters, and so does who owns what:
 *
 * - A service already answering is adopted, never started twice: it is either the one an earlier
 *   attempt left behind, or the person's own (`start_api.bat`), which is left running on quit.
 * - A port that accepts connections but does not answer yet is a server still loading: this waits for
 *   it rather than starting a second model on the same port.
 * - Within one process only one attempt runs at a time; `ensure` while starting joins that attempt.
 * - `stop` only touches the child this object started, and asks it to exit first.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';

export type ServicePhase = 'off' | 'starting' | 'ready' | 'failed';

/** What to run: the working directory, the executable and its arguments. */
export interface ServiceCommand {
  cwd: string;
  exe: string;
  args: string[];
}

export interface ServiceStatus {
  phase: ServicePhase;
  /** Why it failed, or that it is loading; empty when fine. */
  detail: string;
  /** This process started it, so `stop` may end it. */
  owned: boolean;
  /** It was already there (running or loading): someone else's, left alone on quit. */
  external: boolean;
  pid: number | null;
  /** The last lines it printed (at most 12). */
  log: string[];
}

export interface LocalServiceOptions {
  /** The command, or null when the host has none configured (then `ensure` fails with a hint). */
  command: () => ServiceCommand | null;
  /** Whether the service answers; usually the backend's `health`. */
  health: () => Promise<boolean>;
  /** Asked when spawning would be a duplicate: is something already listening on that port? */
  listening?: () => Promise<boolean>;
  /** How to ask it to exit cleanly before the process is ended. */
  gracefulStop?: () => Promise<void>;
  /** How long its models may take to load; 180 s by default. */
  timeoutMs?: number;
  /** Readiness poll interval; 1.2 s by default. */
  pollMs?: number;
  /** How long it gets to exit on its own before it is killed; 6 s by default. */
  stopGraceMs?: number;
  log?: (line: string) => void;
  /** Tests pass a fake; the real one is `node:child_process.spawn`. */
  spawnImpl?: typeof spawn;
}

const TAIL_MAX = 12;

export class LocalService {
  private child: ChildProcess | null = null;
  private phase: ServicePhase = 'off';
  private detail = '';
  private external = false;
  private starting: Promise<boolean> | null = null;
  private stopping = false;
  /** Bumped by every stop, so a poll that began before it does not go on. */
  private attempt = 0;
  private readonly tail: string[] = [];

  constructor(private readonly opts: LocalServiceOptions) {}

  status(): ServiceStatus {
    return {
      phase: this.phase,
      detail: this.detail,
      owned: !!this.child && this.child.exitCode === null,
      external: this.external,
      pid: this.child?.pid ?? null,
      log: [...this.tail],
    };
  }

  /**
   * Probes the service once: one that answers counts as ready (and is left alone), one that does not
   * and that this object did not start counts as off. The settings page calls this on load, so a
   * service started by hand shows up as ready.
   */
  async refresh(): Promise<ServiceStatus> {
    if (this.phase === 'starting') return this.status();
    const ready = await this.opts.health();
    if (ready) {
      if (this.child && this.child.exitCode !== null) this.child = null;
      this.external = !this.child;
      this.phase = 'ready';
      if (!this.child) this.detail = '';
    } else if (!this.child) {
      this.phase = 'off';
      this.detail = '';
      this.external = false;
    }
    return this.status();
  }

  /** Starts it unless it already answers; true once it is ready. Concurrent calls join. */
  ensure(): Promise<boolean> {
    if (this.starting) return this.starting;
    if (this.phase !== 'ready') this.set('starting', '正在启动语音服务,模型加载约 40–60 秒');
    this.starting = this.run().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async run(): Promise<boolean> {
    const mine = ++this.attempt;
    if (this.child && this.child.exitCode === null && this.phase === 'ready') return true;
    if (await this.opts.health()) {
      if (this.child && this.child.exitCode !== null) this.child = null;
      this.external = !this.child;
      this.set('ready', '');
      return true;
    }
    if (mine !== this.attempt) return false;
    if (this.opts.listening && await this.opts.listening()) {
      this.external = true;
      this.set('starting', '语音服务已在启动中,等待模型加载');
      return this.waitReady(mine);
    }
    const command = this.opts.command();
    if (!command) { this.set('failed', '没有配置启动命令'); return false; }
    this.tail.length = 0;
    this.set('starting', '正在启动语音服务,模型加载约 40–60 秒');
    const child = (this.opts.spawnImpl ?? spawn)(command.exe, command.args, { cwd: command.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.external = false;
    const take = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        const text = line.trim();
        if (!text) continue;
        this.tail.push(text);
        while (this.tail.length > TAIL_MAX) this.tail.shift();
      }
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', (err) => {
      this.child = null;
      this.set('failed', `没能启动:${err.message}`);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;
      // while loading, another service may have won the port: if it answers now, adopt it
      if (this.phase === 'starting') {
        void this.opts.health().then((ok) => {
          if (ok) {
            this.external = true;
            this.set('ready', '');
          } else {
            this.set('failed', `语音服务已退出(${code ?? signal ?? '未知'})`);
          }
        });
        return;
      }
      this.set('failed', `语音服务已退出(${code ?? signal ?? '未知'})`);
    });
    if (mine !== this.attempt) { await this.endChild(); return false; }
    return this.waitReady(mine);
  }

  /** Polls until the service answers; models take a while on a laptop GPU. */
  private async waitReady(mine: number): Promise<boolean> {
    const timeoutMs = this.opts.timeoutMs ?? 180_000;
    const pollMs = this.opts.pollMs ?? 1200;
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (await this.opts.health()) {
        if (mine !== this.attempt) return false;
        this.set('ready', '');
        return true;
      }
      if (mine !== this.attempt || this.phase === 'failed') return false;
      if (Date.now() > until) {
        this.set('failed', `模型加载超时(${Math.round(timeoutMs / 1000)} 秒),可以重试`);
        await this.endChild();
        return false;
      }
      await sleep(pollMs);
    }
  }

  /** Stops the service this object started; one started elsewhere is left running. */
  async stop(): Promise<void> {
    this.attempt++;
    await this.endChild();
    this.external = false;
    this.set('off', '');
  }

  /** Ends the child (gracefully first), leaving the phase alone. */
  private async endChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    this.stopping = true;
    try {
      if (!this.external && this.opts.gracefulStop) await this.opts.gracefulStop();
      if (!(await waitExit(child, this.opts.stopGraceMs ?? 6000))) {
        child.kill();
        if (!(await waitExit(child, 2500))) await killTree(child);
      }
    } finally {
      this.stopping = false;
    }
  }

  private set(phase: ServicePhase, detail: string): void {
    if (phase !== this.phase) this.opts.log?.(`语音服务:${phase}${detail ? ` —— ${detail}` : ''}`);
    this.phase = phase;
    this.detail = detail;
  }
}

/** Whether `url`'s host and port accept a connection (something is listening, maybe still loading). */
export function portAnswers(url: string, timeoutMs = 700): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  return new Promise((done) => {
    const socket = connect({ host: target.hostname || '127.0.0.1', port, timeout: timeoutMs });
    let settled = false;
    const end = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(ok);
    };
    socket.once('connect', () => end(true));
    socket.once('timeout', () => end(false));
    socket.once('error', () => end(false));
  });
}

/** Ends the whole tree: a server that forked would keep its children otherwise. */
async function killTree(child: ChildProcess): Promise<void> {
  if (process.platform === 'win32' && child.pid) {
    await new Promise<void>((done) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('exit', () => done());
      killer.on('error', () => done());
    });
    return;
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((done) => {
    const onExit = (): void => { clearTimeout(timer); done(true); };
    const timer = setTimeout(() => { child.off('exit', onExit); done(child.exitCode !== null); }, ms);
    child.once('exit', onExit);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
