# coopanion-voice

给 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 桌宠接上**可插拔的语音合成**：气泡里的字不光能看，还能用本机模型念出来；后端可以换成本地 GPT-SoVITS、OpenAI、CosyVoice，或者你自己那套 HTTP 接口。

> 这个仓库是从实际运行的桌宠里抽出来的语音模块 + 接入说明，**不含任何模型权重、参考音频或 API Key**。默认后端是本机 GPT-SoVITS，但整套东西对后端一无所知——换后端只需要写一个几十行的文件。

---

## 它解决什么

桌宠原本只会「冒泡」：文字一行行打在气泡里，最多配一段合成的叽咕声。想让它真的说话，中间有几件不体面的事要处理：

| 问题 | 这个仓库的做法 |
|---|---|
| 各家 TTS 的请求格式完全不同 | `TtsBackend` 一个接口，内置 GPT-SoVITS / OpenAI / 任意 HTTP 三种 |
| 合成要 1–3 秒，气泡不能干等 | 「先显示、后附音」：气泡立即出现，音频好了再补（`pet_speak` 例外，它先合成、字音严格同步） |
| 本地模型要 20–60 秒加载 | `LocalService` 随桌宠拉起、等它就绪、退出时只关自己启动的那个 |
| 同一句话反复合成 | `TtsClient` 串行队列 + 内容缓存（32 条） |
| 系统代理把 `127.0.0.1` 也劫走 | `localFetch` 直连本机，永不经过代理 |
| 音色、语速、音量、音调散落各处 | 一个设置页（`/voiceout`），改完即时生效 |

---

## 目录

```
src/                     Node 侧（TypeScript，无运行时依赖）
  client.ts              TtsClient：队列、缓存、超时
  backends/
    types.ts             TtsBackend 接口（加新后端的唯一契约）
    gpt-sovits.ts        本机 GPT-SoVITS：参考音频 + /tts
    openai.ts            OpenAI 兼容的 /audio/speech
    http.ts              任意 HTTP：JSON / 自定义 body（SSML 等）
  service.ts             LocalService：本地模型进程的启停与就绪等待
  audio-bank.ts          按内容哈希保存音频，交给页面
  wav.ts                 WAV 时长、按字数估时长
  no-proxy-fetch.ts      不经代理的 fetch
web/                     浏览器侧（原生 ESM，无需构建）
  player.js              播放器：音量、变调（不变速）、逐段回调
  voiceout.html/.css/.js 设置页：音色、语速、音量、音调、朗读范围、服务启停
examples/
  say.ts                 CLI：合成一句话到文件
  server.ts              独立演示：设置页 + 四个接口 + 本地服务托管
docs/
  backends.md            接别的 TTS：OpenAI / Azure / CosyVoice / 自建
  integration.md         接进 Coopanion 桌宠：要改的 11 处
  config.md              配置项与环境变量全表
  troubleshooting.md     听不到声音时按顺序查
tests/                   vitest：后端请求形状、队列与缓存、进程启停
```

---

## 快速开始

需要 Node 20+（开发时用 22）。

```bash
npm install

# 1. 先确认你的 TTS 服务在线
curl --noproxy '*' http://127.0.0.1:9880/docs      # GPT-SoVITS
export REFS_DIR=/path/to/refs                      # 里面是 <音色>.wav + <音色>.txt
npm run say -- "你好呀，我是库。" out.wav

# 2. 起一个带设置页的演示（不需要 Coopanion）
npm run demo
#   → http://127.0.0.1:7999/voiceout
```

`npm run say` 的输出大概是这样：

```
合成 8 字 → 2.13s (audio/wav)
✓ out.wav: 2.13s 音频 (audio/wav), 用时 3.42s
```

> 第一次合成通常要 5–15 秒（显卡预热），之后按 RTF ≈ 0.5–0.8 走。

---

## 换一个后端

内置三种，用环境变量或代码二选一。

### GPT-SoVITS（默认，本机）

```bash
GPT_SOVITS_API=http://127.0.0.1:9880 REFS_DIR=./refs npm run say -- "你好"
```

```ts
import { TtsClient, gptSovits } from './src/index.ts';

const client = new TtsClient(gptSovits({
  apiBase: 'http://127.0.0.1:9880',
  refDir: 'D:/GPT-SoVITS-runtime/refs',   // <音色>.wav + 逐字的 <音色>.txt
  textLang: 'zh',
}));
const clip = await client.speak({ text: '你好呀', voice: '申鹤', speed: 1.05 });
```

GPT-SoVITS 的音色就是**参考音频文件**：`refs/申鹤.wav` 配 `refs/申鹤.txt`（必须逐字一致）。v3/v4 模型会拒绝空 `prompt_text`，`.txt` 别漏。

### OpenAI（或任何兼容 `/audio/speech` 的服务）

```bash
TTS_BACKEND=openai OPENAI_API_KEY=sk-… npm run say -- "Hello there." hi.wav
```

```ts
import { openaiTts } from './src/index.ts';
const backend = openaiTts({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini-tts', format: 'wav' });
```

`apiBase` 指向 LocalAI、LM Studio、vLLM-Omni、OneAPI 之类的网关即可，`format: 'wav'` 让时长可读，`'mp3'` 更小但时长靠估算（播放时浏览器会校正）。

### 别的 HTTP 接口

```ts
import { httpTts } from './src/index.ts';

// CosyVoice
const cosy = httpTts({
  name: 'cosyvoice',
  url: () => 'http://127.0.0.1:50000/inference_sft',
  json: (req) => ({ tts_text: req.text, spk_id: req.voice ?? '中文女' }),
  healthUrl: 'http://127.0.0.1:50000/docs',
});

// Azure：SSML + 自定义头
const azure = httpTts({
  name: 'azure',
  url: () => 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1',
  raw: (req) => ({
    body: `<speak version='1.0' xml:lang='zh-CN'><voice name='zh-CN-XiaoxiaoNeural'>${req.text}</voice></speak>`,
    contentType: 'application/ssml+xml',
  }),
  headers: { 'x-microsoft-outputformat': 'riff-24khz-16bit-mono-pcm' },
  healthUrl: 'https://eastasia.api.cognitive.microsoft.com/sts/v1.0/issueToken',
  mime: 'audio/wav',
});
```

更细的写法（流式、鉴权、错误处理）见 **[docs/backends.md](docs/backends.md)**。

---

## 接回桌宠

完整步骤在 **[docs/integration.md](docs/integration.md)**，概述：

1. 把 `src/*` 放进 `packages/cortico-world-desktop-pet/src/voice/`，`web/*` 放进它的 `web/`；
2. `config.ts` 加一段 `voice` 配置（含 `service`）；
3. `tools.ts` 加 `pet_speak` 工具；
4. `world.ts` 里：`say/ask/dialog` 在 `read: all` 时附音、`pet_speak` 先合成后显示、语音设置读写、随启动拉起服务；
5. `server.ts` 加 `/api/voice/<id>`、`/voiceout` 页面和 `/api/voiceout` 三个接口；
6. `pet-app.js` 收音频、按音频长度铺字、念完再进下一段；
7. `host/preload.cjs` + `host/electron-main.cjs` 加一个「语音输出」窗口；
8. 文案（`i18n/*`、`model-text.ts`、`ENV_PROMPT*.md`）。

不改 Cortico 内核，也不需要重新构建 `build/cortico`——重启桌宠即可。

---

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `voice.enabled` | `true` | 语音总开关 |
| `voice.read` | `all` | `all` 所有气泡都念 / `speak` 只念 `pet_speak` / `off` 都不念 |
| `voice.voice` | `default` | 音色：参考音频名（GPT-SoVITS）或后端自己的名字 |
| `voice.speed` | `1` | 语速 0.6–1.6 |
| `voice.volume` | `0.85` | 播放音量，页面侧生效 |
| `voice.pitch` | `0` | 音调 ±6 半音，页面侧变调、不改语速 |
| `voice.textLang` | 空 | 合成语言；空 = 跟随应用语言 |
| `voice.apiBase` | `http://127.0.0.1:9880` | 服务地址 |
| `voice.refDir` | `D:\GPT-SoVITS-runtime\refs` | 参考音频目录 |
| `voice.timeoutMs` | `120000` | 单句合成超时 |
| `voice.service.auto` | `true` | 随桌宠启动本地模型 |
| `voice.service.dir` | GPT-SoVITS 程序目录 | 子进程的工作目录 |
| `voice.service.python` | 空 | 空 = `<dir>\runtime\python.exe` |
| `voice.service.args` | 空 | 空 = `api_v2.py -a <host> -p <port> -c GPT_SoVITS/configs/tts_infer.yaml` |
| `voice.service.timeoutMs` | `180000` | 模型加载超时 |

安装包/移植到别人机器时，路径类配置（`refDir`、`service.dir`）在 `config.json` 里改；界面上的可调项都在 `/voiceout`。全部键与示例环境变量见 **[docs/config.md](docs/config.md)**。

---

## 设计上的几个决定

- **协议只加一个字段**：`say` 的每段带 `voice:{url,seconds}`，`ask` / `dialog` 各带一个；合成在发送之前完成。页面不需要知道后端是什么，也不会出现「字说完了声音才追上」或「只念了一半」。
- **进程归属**：只关自己启动的服务。你手动 `start_api.bat` 起的那份会被识别为 `external`，桌宠退出时不碰它。
- **变调用颗粒重叠相加**（重采样 + Hann 窗 50% 重叠），保持时长不变——不是 `playbackRate` 那种连语速一起变的做法。
- **音频走 HTTP，不走 WebSocket**：页面自己解码、自己缓存，几百 KB 的音频不进 JSON。

---

## 许可与致谢

- 本仓库：**AGPL-3.0-or-later**（与 Coopanion 一致），见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
- [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 与 [Cortico](https://github.com/Pal-AI-Lab/Cortico) — Pal AI Lab，MIT / AGPL-3.0；本模块是它们的扩展，接口（World、页面协议）沿用其约定。
- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) — MIT，本机语音合成的后端。
- 变调的思路来自经典的颗粒合成 / OLA 时间伸缩，没有第三方音频库。

---

### English

`coopanion-voice` gives the Coopanion desktop pet a real voice. The Node side is a small, dependency-free TTS client with a pluggable backend (GPT-SoVITS locally, OpenAI-compatible endpoints, or any HTTP API), a serial queue with a content cache, a content-addressed audio bank, and a supervisor that starts a local model with the pet and stops the one it started. The browser side is a player with volume and a pitch shift that keeps the pace, plus a settings page at `/voiceout`. Nothing here ships a model: point `refDir` / `apiBase` at your own service, or write a ~40-line backend for the API you have. See [docs/backends.md](docs/backends.md) and [docs/integration.md](docs/integration.md).

Licensed under AGPL-3.0-or-later.
