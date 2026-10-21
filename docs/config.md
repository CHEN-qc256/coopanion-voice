# 配置项

分三层：**桌宠**（`config.json` 里的 `worlds.desktop-pet.voice`）、**库**（构造 `TtsClient` / `LocalService` 时传的选项）、**演示脚本**（环境变量）。

## 桌宠：`worlds.desktop-pet.voice`

存于数据目录下的 `home/companion/config.json`（源码运行时是 `build/data/home/companion/config.json`）。全部热生效：改完下一次调用就用新值，不需要重启桌宠。

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 语音总开关。关掉后气泡照常显示、不出声 |
| `read` | `all` \| `speak` \| `off` | `all` | 朗读范围：所有气泡 / 只有 `pet_speak` / 都不念 |
| `voice` | string | `default` | 音色。GPT-SoVITS 下是 `refDir` 里的文件名（不含 `.wav`） |
| `speed` | number | `1` | 语速 0.6–1.6。超过 1.3 音质会明显变差 |
| `volume` | number | `0.85` | 播放音量 0–1，页面侧增益 |
| `pitch` | number | `0` | 音调 −6…+6 半音（页面侧变调，语速不变） |
| `textLang` | string | `""` | `zh`/`en`/`ja`/`ko`/`yue`/`auto`；空 = 跟随应用语言 |
| `apiBase` | string | `http://127.0.0.1:9880` | 服务地址 |
| `refDir` | string | GPT-SoVITS 的 `refs` 目录 | `<音色>.wav` + 逐字的 `<音色>.txt` |
| `timeoutMs` | number | `120000` | 单句合成超时 |

### `voice.service`：本地模型的进程托管

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `auto` | boolean | `true` | 随桌宠启动（面板上可切） |
| `dir` | string | GPT-SoVITS 程序目录 | 子进程的工作目录；`api_v2.py` 与 `GPT_SoVITS/configs/` 在这里 |
| `python` | string | `""` | 空 = `<dir>/runtime/python.exe` |
| `args` | string | `""` | 空 = `api_v2.py -a <host> -p <port> -c GPT_SoVITS/configs/tts_infer.yaml` |
| `timeoutMs` | number | `180000` | 模型加载超时；超时会杀掉半启动的进程并报错 |

`args` 按空格切分，双引号可成组。换成别的本地服务时，把 `python` 指向它的可执行文件、`args` 写成它的启动参数即可——`LocalService` 不认 GPT-SoVITS，只认「跑起来、等 `/docs` 或健康检查通过」。

完整示例：

```jsonc
{
  "worlds": {
    "desktop-pet": {
      "voice": {
        "enabled": true,
        "read": "all",
        "voice": "申鹤",
        "speed": 0.95,
        "volume": 0.8,
        "pitch": 1,
        "textLang": "",
        "apiBase": "http://127.0.0.1:9880",
        "refDir": "D:\\GPT-SoVITS-runtime\\refs",
        "timeoutMs": 120000,
        "service": {
          "auto": true,
          "dir": "D:\\GPT-SoVITS-runtime",
          "python": "",
          "args": "",
          "timeoutMs": 180000
        }
      }
    }
  }
}
```

> 想换成 OpenAI 之类的云服务：把 `voice.backend` 设成 `openai`、`apiBase` 指向网关，并在后端的鉴权处读 Key（见 [integration.md](integration.md) 第 5 节）。**不要把 Key 写进这个文件**——它不加密，且常被一起备份。

## 库：`TtsClient`

```ts
new TtsClient(backend, {
  fetch: localFetch,     // 默认就是不经代理的 localFetch
  cacheMax: 32,          // 缓存几条句子（按 音色+语言+语速+文本 做键）
  timeoutMs: 120_000,    // 单次合成超时
  log: console.log,      // 每条合成的耗时
});
```

`client.speak({ text, voice?, speed?, lang? })` 返回：

```ts
{ bytes, mime, seconds, estimated, cached }
```

- `seconds`：后端给的或 WAV 头读出的时长；`estimated` 为 `true` 表示是按字数估的。
- 失败会 reject，消息形如 `400: {"message":"tts failed",…}`（服务原话，截 300 字）。

## 库：`LocalService`

```ts
new LocalService({
  command: () => ({ cwd, exe, args }),   // null = 没配置，ensure() 直接失败
  health: () => client.health(),         // 就绪判定
  listening: () => portAnswers(apiBase), // 端口已在监听但还没应答 → 等它，不重复启动
  gracefulStop: () => backend.stop?.(),  // 先礼后兵
  timeoutMs: 180_000,
  pollMs: 1200,
  stopGraceMs: 6000,
  log: console.log,
});
```

`status()` 返回 `{ phase, detail, owned, external, pid, log }`：

| phase | 含义 |
|---|---|
| `off` | 没在跑 |
| `starting` | 已启动子进程（或正在等别人的服务加载），轮询健康检查中 |
| `ready` | 健康检查通过 |
| `failed` | 目录/程序缺失、加载超时、或进程自己退了；`detail` 是原因，`log` 是它最后 12 行输出 |

`owned: true` 表示这个进程是本对象启动的，`stop()` 只会关它；`external: true` 表示「来的时候就已在跑」，退出时留着不动。

## 演示脚本的环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `TTS_BACKEND` | `gpt-sovits` | `gpt-sovits` / `openai` / `cosyvoice` |
| `VOICE_PORT` | `7999` | 演示服务器端口 |
| `GPT_SOVITS_API` | `http://127.0.0.1:9880` | GPT-SoVITS 接口 |
| `REFS_DIR` | `./refs` | 参考音频目录 |
| `GPT_SOVITS_DIR` | 空 | 设了之后演示页的「启动」能拉起本地模型 |
| `GPT_SOVITS_ARGS` | 空 | 覆盖默认启动参数 |
| `OPENAI_API_KEY` | 空 | OpenAI 或兼容网关的 Key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | 网关地址 |
| `OPENAI_MODEL` | `gpt-4o-mini-tts` | 模型名 |
| `OPENAI_VOICE` | `alloy` | 默认音色 |
| `OPENAI_FORMAT` | `wav` | `wav` 时长可读，`mp3` 更小 |
| `COSYVOICE_API` | `http://127.0.0.1:50000/inference_sft` | CosyVoice 接口 |
