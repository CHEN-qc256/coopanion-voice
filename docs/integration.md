# 接进 Coopanion 桌宠

目标：把 `packages/cortico-world-desktop-pet` 改造成「会说话的库」。按下面的顺序做，**不需要重新构建 `build/cortico`**，改完重启桌宠即可。

> 版本：对着 Coopanion `0.2.5`（`main`，Cortico `469f496`）写的。你的 `world.ts` 行号会变，函数名和锚点不会。

## 0. 先把文件放进去

```bash
PET=Coopanion/packages/cortico-world-desktop-pet

mkdir -p $PET/src/voice/backends
cp src/client.ts src/audio-bank.ts src/wav.ts src/no-proxy-fetch.ts src/service.ts  $PET/src/voice/
cp src/backends/*.ts                                                                 $PET/src/voice/backends/
cp web/player.js web/voiceout.html web/voiceout.css web/voiceout.js                   $PET/web/
```

这些文件一个字符都不用改——它们不认「桌宠」，只认接口。

## 1. `src/config.ts`：一节配置

```ts
export interface VoiceSettings {
  enabled: boolean;
  read: 'all' | 'speak' | 'off';
  backend: 'gpt-sovits' | 'openai' | 'http';
  apiBase: string;
  refDir: string;
  voice: string;
  textLang: string;
  speed: number;
  volume: number;
  pitch: number;
  timeoutMs: number;
  service: { auto: boolean; dir: string; python: string; args: string; timeoutMs: number };
}
```

默认值（写进 `DESKTOP_PET_DEFAULTS`）：

```ts
voice: {
  enabled: true, read: 'all', backend: 'gpt-sovits',
  apiBase: 'http://127.0.0.1:9880', refDir: 'D:\\GPT-SoVITS-runtime\\refs',
  voice: 'default', textLang: '', speed: 1, volume: .85, pitch: 0, timeoutMs: 120_000,
  service: { auto: true, dir: 'D:\\GPT-SoVITS-runtime', python: '', args: '', timeoutMs: 180_000 },
},
```

再补三个纯函数（`world.ts` 与设置页都要用）：

```ts
export function voiceFor(s: VoiceSettings | undefined, language: Language) { /* 夹取范围、补默认值、推断 textLang */ }
export function readsOut(v: { enabled: boolean; read: 'all' | 'speak' | 'off' }, kind: 'say' | 'speak' | 'ask' | 'dialog'): boolean {
  if (!v.enabled || v.read === 'off') return false;
  return v.read === 'all' || kind === 'speak';
}
export function serviceFor(v: VoiceSettings) { /* 补默认值，返回 LocalService 要的 {auto,dir,python,args,timeoutMs} */ }
```

菜单项：`PET_ACTIONS` 里加 `'voiceout'`（右键菜单与悬停按钮都从这里来）。

## 2. `src/tools.ts`：新工具

```ts
{
  name: 'pet_speak',
  tags: ['speak'],
  description: 'Say something in a bubble and speak it aloud in the pet\'s own voice, the bubble typing along with the recording. Same script markers as pet_say. Use it for a line that must certainly be heard and spoken exactly; when every bubble is already read out, pet_say is enough.',
  parameters: {
    type: 'object',
    properties: {
      script: { type: 'string', description: 'What to say aloud, with optional 【expression, motion】 and <expression> markers. One or two sentences.' },
      speed: { type: 'number', minimum: 0.6, maximum: 1.6, description: 'Speaking rate for this line, 1 being the configured one.' },
    },
    required: ['script'],
  },
},
```

## 3. `src/world.ts`：核心，约 150 行

### 3.1 字段与构造

```ts
private readonly tts = new TtsClient(backendFromConfig(this.cfg.voice));   // 后端变了要重建，见 §5
private readonly audio = new AudioBank();
private readonly voiceService: VoiceService;                                // src/voice/service.ts 的 LocalService
private autoService: boolean | null = null;

constructor(opts) {
  ...
  this.voiceService = new LocalService({
    command: () => {
      const s = serviceFor(this.cfg.voice);
      return s.dir ? { cwd: s.dir, exe: s.python || join(s.dir, 'runtime', 'python.exe'),
                       args: s.args ? splitArgs(s.args) : defaultGptSovitsArgs(voiceFor(this.cfg.voice)) } : null;
    },
    health: () => this.tts.health(),
    listening: () => portAnswers(voiceFor(this.cfg.voice).apiBase),
    gracefulStop: async () => { await this.tts.backend.stop?.(); },
    timeoutMs: serviceFor(this.cfg.voice).timeoutMs,
    log: (line) => this.log?.info(line),
  });
}
```

### 3.2 生命周期

```ts
async start(host) {
  ...
  this.autoService = this.cfg.voice.enabled && serviceFor(this.cfg.voice).auto;
  if (this.autoService) void this.voiceService.ensure();   // 20–60 秒，不阻塞启动
}

async stop() {
  ...
  await this.voiceService.stop();   // 只关自己起的；手动 start_api.bat 起的不碰
}

private syncPrefs() {   // 已经每 150ms 跑一次
  ...
  const auto = this.cfg.voice.enabled && serviceFor(this.cfg.voice).auto;
  if (auto !== this.autoService) { this.autoService = auto; if (auto) void this.voiceService.ensure(); }
}
```

### 3.3 `pet_speak`：先合成、后显示

```ts
private async speak(args) {
  const { beats, dropped } = parseScript(String(args.script ?? ''), this.vocab());
  const withText = beats.filter((b) => b.text.trim());
  if (!withText.length) return { text: this.t.speakEmpty, failed: true };
  const v = voiceFor(this.cfg.voice, this.appLanguage);
  const speed = clamp(Number(args.speed) || v.speed, .6, 1.6);
  // 逐段合成（TtsClient 内部串行，不会抢显卡）
  const clips = await Promise.all(beats.map(async (b) => {
    if (!b.text.trim()) return null;
    try {
      const clip = await this.tts.speak({ text: b.text.trim().slice(0, 200), voice: v.voice, speed, lang: v.textLang });
      return { id: this.audio.put(clip.bytes), seconds: clip.seconds };
    } catch (err) { this.log?.warn(`语音合成失败:${(err as Error).message}`); return null; }
  }));
  const out = beats.map((b, i) => clips[i] ? { ...b, voice: { url: `/api/voice/${clips[i]!.id}`, seconds: clips[i]!.seconds } } : b);
  if (!this.server.sendPet({ t: 'say', id, beats: out })) return this.notConnected('pet_speak');
  ...
  return { text: this.t.speakReceipt({ ... }) };
}
```

### 3.4 所有气泡都念：合成完再发气泡

```ts
// say()：先把每段合成好，再把它们挂在这条消息上一起发出去
const aloud = spoken && readsOut(v, 'say') && !!this.tts.voices.length;
const clips = aloud ? await this.clipsOf(beats.map((b) => b.text), v) : [];
const out = aloud ? beats.map((b, i) => (clips[i] ? { ...b, voice: clips[i] } : b)) : beats;
const id = nextId('s');
if (spoken && !this.server.sendPet({ t: 'say', id, beats: out })) return this.notConnected('pet_say');

/** 逐段合成，一次一个（TtsClient 内部串行，不抢显卡）；失败的那段是 null，气泡照出，只是没声。 */
private async clipsOf(texts: string[], v) {
  const out: Array<{ url: string; seconds: number } | null> = [];
  for (const text of texts) {
    if (!text.trim()) { out.push(null); continue; }
    try {
      const clip = await this.tts.speak({ text, voice: v.voice, speed: v.speed, lang: v.textLang });
      out.push({ url: `/api/voice/${this.audio.put(clip.bytes)}`, seconds: clip.seconds });
    } catch (err) { this.log?.warn(`语音合成失败:${(err as Error).message}`); out.push(null); }
  }
  return out;
}

// askUser() 与 dialog() 同理：合成好再 sendPet，把 voice 挂在消息上
const clip = readsOut(v, 'ask') ? (await this.clipsOf([question], v))[0] : null;
this.server.sendPet({ t: 'ask', id, question, options, own, ...(clip ? { voice: clip } : {}) });
```

不要"先发气泡、再补一条 `{t:'voice'}`"：那样页面必须设一个等待上限，而任何超过上限的句子都会出现
"字说完了声音才追上"甚至干脆没声。让发送等合成，代价是气泡晚一两秒，换来字音严格对齐——气泡和
第一帧声音同时开始，念完才进下一段。

### 3.5 快照与设置接口

```ts
private snapshot() {
  ...
  voiceOut: { enabled: v.enabled && v.read !== 'off', read: v.read, volume: v.volume, pitch: v.pitch },
}

async voiceOutState() {
  const v = voiceFor(this.cfg.voice, this.appLanguage);
  return {
    settings: { enabled: v.enabled, read: v.read, voice: v.voice, speed: v.speed, volume: v.volume, pitch: v.pitch, apiBase: v.apiBase, refDir: v.refDir },
    voices: this.tts.voices,
    service: { ...(await this.voiceService.refresh()), auto: serviceFor(this.cfg.voice).auto },
    limits: { speed: [.6, 1.6], pitch: [-6, 6] },
  };
}

saveVoiceOut(patch) {
  // 只接受白名单字段并夹取范围，然后 persist 完整的 voice 一节（避免浅合并丢 apiBase/refDir）
  this.opts.persist({ voice: { ...DESKTOP_PET_DEFAULTS.voice, ...this.cfg.voice, ...clean } });
  this.syncPrefs();
}

async voiceServiceAction(action) {
  if (action === 'stop') { await this.voiceService.stop(); return this.voiceService.status(); }
  void this.voiceService.ensure();
  return this.voiceService.status();
}
```

## 4. `src/server.ts`：两个路由组

```ts
// 1) 音频（同源，CSP 的 media-src 'self' 已放行）
if (req.method === 'GET' && path.startsWith('/api/voice/')) {
  const id = path.slice('/api/voice/'.length).replace(/\.[a-z0-9]+$/i, '');
  const bytes = /^[\da-f]{8,64}$/.test(id) ? this.opts.voice?.(id) ?? null : null;
  if (!bytes) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': bytes.length, 'cache-control': 'no-store' }).end(bytes);
  return;
}

// 2) 设置页与它的接口
const PAGES = { '/pet': 'pet.html', '/dress': 'dress.html', '/voiceout': 'voiceout.html' };
// GET  /api/voiceout       → voiceOut.state()
// POST /api/voiceout       ← 设置补丁 → voiceOut.save() → 再返回 state
// POST /api/voiceout/preview  ← { text } → { url, seconds } | { error }
// POST /api/voiceout/service  ← { action } → { service }
```

`PetServerOptions` 里加 `voice?(id): Buffer | null` 与 `voiceOut?: { state, save, preview, service }`，再从 `world.ts` 的 `new PetServer({...})` 里接上。

## 5. 换后端

`TtsClient` 的后端在构造时确定。做法是加一个工厂，让配置挑后端：

```ts
// src/voice/backends-select.ts
import { backendFromConfig } from './backends/from-config.ts';

export const backendFor = (v: VoiceSettings) => backendFromConfig({
  backend: v.backend,
  apiBase: v.apiBase,
  refDir: v.refDir,
  textLang: v.textLang,
  apiKey: process.env.TTS_API_KEY,       // Key 走环境变量，别写进 config.json
  voices: v.voices,
});
```

然后 `world.ts` 里把 `this.tts` 从 `readonly` 改成按配置缓存：

```ts
private ttsCache: { key: string; client: TtsClient } | null = null;
private get tts(): TtsClient {
  const key = `${this.cfg.voice.backend}|${this.cfg.voice.apiBase}|${this.cfg.voice.refDir}`;
  if (this.ttsCache?.key !== key) {
    this.ttsCache = { key, client: new TtsClient(backendFor(this.cfg.voice), { log: (l) => this.log?.info(l) }) };
  }
  return this.ttsCache.client;
}
```

改配置里的 `backend` / `apiBase` 就换服务，不需要重启桌宠。`LocalService` 只对本地服务有意义：云 API 时把 `command` 返回 `null`、`auto` 设 `false` 即可（`ensure()` 会直接报「没有配置」，面板也不会显示「启动」按钮）。

## 6. `web/pet-app.js`：页面收音频

```js
const voice = createPlayer({ audio: () => sfx.outputVoice(), onFrame: () => body?.talk() });

// prefs
if (p.voiceOut) { prefs.voiceOut = { ...prefs.voiceOut, ...p.voiceOut }; voice.set(prefs.voiceOut); }

// 声音随消息一起来，不需要第二条消息
case 'say': queue.push({ kind: 'say', id: m.id, beats: m.beats, i: -1 }); break;
case 'ask': queue.push({ kind: 'ask', id: m.id, question: m.question, options: m.options || [], own: m.own !== false, clip: m.voice }); break;
case 'dialog': queue.push({ kind: 'dialog', id: m.id, d: m }); break;
```

打字与停留（`stepDialog` / `typeText`）：

- `say` 的 beat 有 `voice.url` → 开气泡的同一帧 `voice.play(url)`，文字按 `clip.elapsed / clip.seconds` 铺开，
  `clip.ended` 之前不进入下一段；
- `ask` / `dialog` 的 `voice.url` → 开气泡时开始播；`stepTalkRead` 在录音播完前不结束这一步。
- 播放器里 `clip.ended` 是唯一"这一段说完了"的信号；不要用字数或定时器替代它，那正是截断的来源。

菜单项：

```js
voiceout: {
  icon: () => ICONS.voiceOut,
  state: () => t('action.voiceout', { state: voiceOutName() }),
  run: () => { if (host?.openVoiceOut) host.openVoiceOut(); else window.open('/voiceout', '_blank'); },
},
```

## 7. 独立窗口

`web/voiceout.*` 自带文案与 AudioContext，不需要桌宠的 `i18n.js` / `sound.js`。只要：

- `host/preload.cjs`：`openVoiceOut: () => ipcRenderer.send('pet:openVoiceOut'),`
- `host/electron-main.cjs`：一个 `voiceout` 的 `BrowserWindow`（460×760，`sandbox: true`），`ipcMain.on('pet:openVoiceOut', () => openVoiceOut())`，托盘菜单加一项。

## 8. 文案

- `src/model-text.ts`：`speakEmpty / speakOff / speakNoRef / speakFailed / speakReceipt / speakPrompt`；
- `src/definition.ts`：`DESCRIBE.tools` 加 `pet_speak`；
- `src/ENV_PROMPT(.en).md`：新增一节讲 `pet_speak` 与「什么时候不必用它」；
- `src/i18n/*.ts`：配置项标题（不写也能跑，只是设置页显示英文/中文回退）。

## 9. 验证

```bash
cd packages/cortico-world-desktop-pet
pnpm run typecheck
pnpm vitest run tests/voice-out.test.ts     # 若你把测试一起搬过去
```

然后重启桌宠，`curl http://127.0.0.1:7797/api/voiceout` 应看到 `service.phase: "ready"`，进 `/voiceout` 点「试听」应听到声音。
