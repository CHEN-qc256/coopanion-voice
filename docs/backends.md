# 接入别的语音合成 API

整套东西对「谁在合成」一无所知。你只需要让新的 API 满足一个接口。

## 0. 先看一眼契约

```ts
export interface TtsBackend {
  readonly name: string;                                  // 日志与设置页里显示的名字
  voices?(): string[];                                    // 设置页下拉框的选项
  synthesize(req: TtsRequest, call: BackendCall): Promise<RawClip>;
  health?(call: BackendCall): Promise<boolean>;           // 服务在不在
  stop?(): Promise<void>;                                 // 只对本地服务有意义
}

export interface TtsRequest { text: string; voice?: string; speed?: number; lang?: string }
export interface RawClip { bytes: Uint8Array; mime: string; seconds?: number }
export interface BackendCall { fetch: FetchLike; signal?: AbortSignal }
```

三个要点：

- **`seconds` 能给就给**。给了，桌宠在播放前就知道这句多长（`pet_speak` 要用它把字和声音对齐）；不给也不会坏，`TtsClient` 会按字数估，浏览器解码后会用真实时长。
- **用 `call.fetch`**，不要用全局 `fetch`：它直连本机、永不经过系统代理（`src/no-proxy-fetch.ts`）。
- **失败了就 throw**，消息里带上服务自己说的话。`TtsClient` 会把这条消息一路带到设置页和工具回执里，是排障时唯一的线索。

## 1. 兼容 OpenAI 的，直接用

绝大多数自建网关（OneAPI、LocalAI、LM Studio、vLLM-Omni）都是这个形状：

```ts
import { openaiTts } from '../../src/index.ts';

const backend = openaiTts({
  apiBase: 'http://127.0.0.1:8080/v1',
  apiKey: process.env.MY_KEY ?? '',
  model: 'tts-1',
  format: 'wav',            // 'mp3' 更小，但时长靠估算
});
```

它发的是：

```http
POST /v1/audio/speech
{ "model": "tts-1", "input": "你好", "voice": "nova", "response_format": "wav" }
```

服务只认 `mp3`？把 `format` 设成 `'mp3'`，并确认返回的 MIME 是 `audio/mpeg`（`TtsClient` 靠 MIME 决定要不要读 WAV 头）。

## 2. 不兼容的，用 `httpTts` 描述出来

`httpTts` 把一个 HTTP 调用拆成四件事：**地址、头、body、MIME**。大部分 API 都能这么写完。

### CosyVoice

```ts
import { httpTts } from '../../src/index.ts';

const backend = httpTts({
  name: 'cosyvoice',
  url: () => 'http://127.0.0.1:50000/inference_sft',
  json: (req) => ({
    tts_text: req.text,
    spk_id: req.voice ?? '中文女',
    speed: req.speed ?? 1,
  }),
  healthUrl: 'http://127.0.0.1:50000/docs',
  voices: ['中文女', '中文男', '英文女', '英文男'],
});
```

### Azure 语音（SSML + 自定义头）

Azure 不吃 JSON，它要 SSML，还得指定输出格式，所以用 `raw` 自己拼 body：

```ts
const backend = httpTts({
  name: 'azure',
  url: () => 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1',
  raw: (req) => ({
    body: `<speak version='1.0' xml:lang='zh-CN'>
             <voice name='zh-CN-XiaoxiaoNeural'>${escapeXml(req.text)}</voice>
           </speak>`,
    contentType: 'application/ssml+xml',
  }),
  headers: (req) => ({
    'ocp-apim-subscription-key': process.env.AZURE_TTS_KEY ?? '',
    'x-microsoft-outputformat': 'riff-24khz-16bit-mono-pcm',
  }),
  healthUrl: 'https://eastasia.api.cognitive.microsoft.com/sts/v1.0/issueToken',
  mime: 'audio/wav',
  voices: ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'en-US-JennyNeural'],
});

const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
```

> Azure 免费层是 0.5 MB / 50 秒一次；长句子请先按标点切开再合成，别指望一次念完。

### 需要先换 token 的

`httpTts` 的 `url` / `headers` 都是函数，可以在里面读一个你自己维护的变量：

```ts
let token = { value: '', expires: 0 };
const backend = httpTts({
  name: 'token-api',
  url: () => 'https://api.example.com/tts',
  headers: async () => ({ authorization: `Bearer ${await ensureToken()}` }),  // 也可以 await
  json: (req) => ({ text: req.text, voice: req.voice }),
});
```

（`headers` 若写成 async，`httpTts` 不会 await——请在外部缓存 token，让 `headers` 保持同步。）

## 3. 干脆自己写一个 backend

当 API 需要多步（提交任务 → 轮询 → 取音频）、要流式、或者要签名时，别硬套 `httpTts`，写文件更清楚：

```ts
// src/backends/my-tts.ts
import { failure, type BackendCall, type RawClip, type TtsBackend, type TtsRequest } from './types.ts';

export function myTts({ apiBase, apiKey }: { apiBase: string; apiKey: string }): TtsBackend {
  const base = apiBase.replace(/\/+$/, '');
  return {
    name: 'my-tts',

    voices: () => ['female-1', 'male-1'],

    async health({ fetch, signal }) {
      try { return (await fetch(`${base}/health`, { signal })).ok; } catch { return false; }
    },

    async synthesize(req: TtsRequest, call: BackendCall): Promise<RawClip> {
      // 1. 提交
      const post = await call.fetch(`${base}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ text: req.text, voice: req.voice, rate: req.speed }),
        signal: call.signal,
      });
      if (!post.ok) throw await failure(post);
      const { id } = await post.json() as { id: string };

      // 2. 轮询（记得给上限，别把工具调用拖死）
      for (let i = 0; i < 60; i++) {
        const job = await call.fetch(`${base}/jobs/${id}`, { headers: { 'x-api-key': apiKey }, signal: call.signal });
        const state = await job.json() as { status: string; url?: string; error?: string };
        if (state.status === 'done' && state.url) {
          const audio = await call.fetch(state.url, { signal: call.signal });
          if (!audio.ok) throw await failure(audio);
          return {
            bytes: new Uint8Array(await audio.arrayBuffer()),
            mime: audio.headers.get('content-type') ?? 'audio/mpeg',
            // 服务报了时长就填上，字音对齐会准很多
            seconds: Number(job.headers.get('x-duration')) || undefined,
          };
        }
        if (state.status === 'failed') throw new Error(state.error ?? '合成失败');
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('合成超时');
    },
  };
}
```

最后把它接上：改 `src/backends/from-config.ts` 的 `switch`，加一个分支；或者在你自己的启动代码里直接

```ts
const client = new TtsClient(myTts({ apiBase, apiKey }));
```

不用改 `TtsClient`、不用改播放器、不用改设置页。

## 4. 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 本机服务明明在跑，却报连接失败 / 502 | 系统代理劫持了 `127.0.0.1` | 用 `call.fetch`（本仓库的 `localFetch` 直连，不过代理） |
| 声音有了，但气泡和声音对不上 | 后端没给 `seconds`，估算偏了 | 返回 `seconds`，或者让格式是 WAV（`TtsClient` 会读头） |
| 设置页的下拉框是空的 | 后端没实现 `voices()` | 实现它，或者在 `voice.voices` 里写死列表 |
| 第二句开始明显变慢 | 服务端串行 + 每次都新请求 | 正常；重复的句子会命中 `TtsClient` 的缓存 |
| 长文本被截断 | 单次请求有上限（Azure 50s、有些 API 2000 字） | 在 backend 里先按标点切段，逐段合成后拼接 WAV |
