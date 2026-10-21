# 听不到声音时按顺序查

链路上有四段，**先确定断在哪一段**，比看日志猜快得多：

```
① 服务在不在     curl --noproxy '*' http://127.0.0.1:9880/docs
② 能不能合成     npm run say -- "测试一下" test.wav
③ 音频有没有到页面  开发者工具 Network 里看 /api/voice/…
④ 能不能播      音量、静音、音频上下文有没有解锁
```

## 症状与处理

| 症状 | 多半是 | 怎么办 |
|---|---|---|
| 工具回执说「服务没开」 | ① 服务没起来 | 面板点「启动」，或手动跑 `start_api.bat`；`service.dir` / `python` 路径对不对 |
| 回执说「本机语音服务没能合成:… 400 …」 | ② 参数被服务拒绝 | 看后面那串原文。`prompt_text cannot be empty` 最常见（见下） |
| 回执说「参考音频目录…里没有可用的音色」 | `refDir` 指错了，或里面没有 `.wav` | 检查路径；每个音色要 `<名字>.wav` **和** `<名字>.txt` |
| 回执说「没能合成:connect ECONNREFUSED」 | 服务没在监听（或端口不对） | `netstat -ano \| grep 9880`；`apiBase` 端口与实际一致吗 |
| 回执说「502」或「Unexpected token」 | 系统代理劫持了 `127.0.0.1` | 用本仓库的 `localFetch`；临时验证加 `--noproxy '*'`；设 `NO_PROXY=127.0.0.1,localhost` |
| 气泡有字没声，页面不报错 | ③ 音频没请求到 | DevTools → Network 看 `/api/voice/...`：404 = 页面与服务不是同一个实例；200 但没播 = ④ |
| `GET /api/voice/...` 返回 404 | 音频已被回收，或 URL 里的 id 不对 | 音频只保留 24 条 / 48 MB，通常是页面拿着旧 id；重启桌宠 |
| 有请求、有音频，就是听不见 | ④ 音频上下文没解锁 | 在页面上点一下（浏览器要求用户手势）；桌宠窗口隐藏时不发声 |
| 音量拉到 100% 还是小 | 参考音频本身电平低 / 系统音量 | 换一段 3–10 秒、无 BGM、未削波的参考音频 |
| 声音发闷、发脆、像在抖 | 变调拉太多 | `pitch` 收回到 ±3 以内；`speed` 别超过 1.3 |
| 首句要等 10 秒以上 | 模型刚加载，显卡预热 | 正常；之后按 RTF 0.5–0.8 走。嫌慢就缩短句子，或改用缓存命中率高的固定话术 |
| 加载 3 分钟还没好 | 显存不足 / 首次加载要编译 | 面板会报「模型加载超时」；关掉占显存的程序，或把 `service.timeoutMs` 调大 |
| 两个声音重叠 | 上一句还没念完就来了下一句 | 新一句会 `stop()` 掉旧的；若仍重叠，检查是不是开了两个桌宠实例 |
| 面板显示「这个服务是别处启动的」 | 你手动起过（或上次强杀桌宠留下的） | 它不会被桌宠关掉。用完手动关那个 python 进程；想让它归桌宠管，先关掉再点「启动」 |

## `prompt_text cannot be empty when using SoVITS_V3`

GPT-SoVITS v3/v4 必须给参考音频的**逐字文本**。`refDir` 里每个 `<voice>.wav` 都要有同名 `<voice>.txt`，内容与录音一字不差（含标点）。少一个 `.txt`，那个音色就用不了。

## 端口与实例

- 默认 `9880`。改端口要同时改 `voice.apiBase`（客户端）与启动参数 `-p`（服务端），两边不一致就是 `ECONNREFUSED`。
- 桌宠的 `LocalService` 会先探端口：能连但 `/docs` 还没应答 ≈ 有人正在加载，它会等，不会起第二个。
- 想彻底重来：`taskkill /PID <pid> /T /F`，或 `curl http://127.0.0.1:9880/control?command=exit`。

## 本地服务的一次完整自检

```bash
# 1. 端口在哪
netstat -ano | findstr :9880

# 2. 服务活着吗（注意 --noproxy）
curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9880/docs

# 3. 合成一句
curl -s --noproxy '*' -X POST http://127.0.0.1:9880/tts \
  -H "content-type: application/json" \
  -d '{"text":"测试","text_lang":"zh","ref_audio_path":"D:\\refs\\default.wav","prompt_text":"参考文本","prompt_lang":"zh","media_type":"wav"}' \
  -o test.wav
ls -l test.wav        # 有 44 字节以上、以 RIFF 开头就是对的

# 4. 本仓库这一层
npm run say -- "测试一下" test2.wav
```

## 页面没有声音（Electron / 浏览器）

- 浏览器要求先有一次用户手势才允许播放。桌宠窗口在启动时已经解开；**独立打开 `/voiceout` 时要先点一下页面**，试听按钮本身就是手势，所以通常没问题。
- `document.hidden` 为真时播放器不发声（隐藏的窗口、最小化）。
- 检查系统音量、输出设备、以及是否把「音效」关掉了——语音**不**受音效开关影响，但会被系统静音影响。
