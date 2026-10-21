import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioBank, TtsClient, estimateSeconds, gptSovits, httpTts, openaiTts, wavSeconds, type FetchLike } from '../src/index.ts';

/** A silent 16-bit PCM WAV of `seconds`. */
function wav(seconds: number, rate = 32000): Uint8Array {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'latin1');
  head.write('fmt ', 12, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([head, data]));
}

/** A reference directory with one voice. */
function refs(): string {
  const dir = mkdtempSync(join(tmpdir(), 'refs-'));
  writeFileSync(join(dir, 'default.wav'), wav(.1));
  writeFileSync(join(dir, 'default.txt'), '参考文本');
  writeFileSync(join(dir, '申鹤.wav'), wav(.1));
  writeFileSync(join(dir, '申鹤.txt'), '另一段参考');
  return dir;
}

/** A fetch that answers with `wav(seconds)` and records what it was asked. */
function fakeFetch(answer: () => Response, seen: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: unknown } }>): FetchLike {
  return async (url, init) => {
    seen.push({ url, init });
    return answer();
  };
}

const ok = (seconds = .8) => new Response(wav(seconds), { status: 200, headers: { 'content-type': 'audio/wav' } });

describe('the audio itself', () => {
  it('reads a WAV length, and estimates one for anything else', () => {
    expect(wavSeconds(wav(1.5))).toBeCloseTo(1.5, 2);
    expect(wavSeconds(new Uint8Array([1, 2, 3]))).toBe(0);
    // five CJK characters a second, so twenty take about four
    expect(estimateSeconds('一二三四五六七八九十一二三四五六七八九十')).toBeCloseTo(4, 0);
    expect(estimateSeconds('abcdefghij')).toBeCloseTo(.71, 1);
    expect(estimateSeconds('一二三四五', 2)).toBeCloseTo(.5, 1);
  });

  it('keeps the newest clips and gives the same audio the same id', () => {
    const bank = new AudioBank(2000, 2);
    const one = bank.put(wav(.01)), two = bank.put(wav(.01, 44100)), three = bank.put(wav(.02, 16000));
    expect(bank.get(one)).toBeNull();
    expect(bank.get(two)).not.toBeNull();
    expect(bank.put(bank.get(three)!)).toBe(three);
  });
});

describe('the GPT-SoVITS backend', () => {
  it('sends the reference and the speed, and reads the length from the answer', async () => {
    const seen: Parameters<typeof fakeFetch>[1] = [];
    const client = new TtsClient(gptSovits({ apiBase: 'http://127.0.0.1:9880/', refDir: refs(), textLang: 'zh' }), { fetch: fakeFetch(() => ok(1.2), seen) });
    const clip = await client.speak({ text: '你好呀', speed: 1.1 });
    expect(clip.seconds).toBeCloseTo(1.2, 1);
    expect(clip.mime).toBe('audio/wav');
    expect(clip.cached).toBe(false);
    expect(seen[0]!.url).toBe('http://127.0.0.1:9880/tts');
    const body = JSON.parse(String(seen[0]!.init!.body));
    expect(body).toMatchObject({ text: '你好呀', text_lang: 'zh', prompt_text: '参考文本', prompt_lang: 'zh', speed_factor: 1.1, media_type: 'wav' });
    expect(body.ref_audio_path).toMatch(/default\.wav$/);
  });

  it('picks the voice by name and falls back to default', async () => {
    const seen: Parameters<typeof fakeFetch>[1] = [];
    const client = new TtsClient(gptSovits({ apiBase: 'http://127.0.0.1:9880', refDir: refs() }), { fetch: fakeFetch(() => ok(), seen) });
    await client.speak({ text: '甲', voice: '申鹤' });
    await client.speak({ text: '乙', voice: '不存在' });
    expect(JSON.parse(String(seen[0]!.init!.body)).ref_audio_path).toMatch(/申鹤\.wav$/);
    expect(JSON.parse(String(seen[1]!.init!.body)).ref_audio_path).toMatch(/default\.wav$/);
  });

  it('says what the service said when it fails', async () => {
    const seen: Parameters<typeof fakeFetch>[1] = [];
    const client = new TtsClient(gptSovits({ apiBase: 'http://127.0.0.1:9880', refDir: refs() }), {
      fetch: fakeFetch(() => new Response('{"message":"tts failed","Exception":"prompt_text cannot be empty"}', { status: 400 }), seen),
    });
    await expect(client.speak({ text: '你好' })).rejects.toThrow(/400.*prompt_text cannot be empty/);
  });
});

describe('the client', () => {
  it('runs one at a time and caches by voice, language, speed and text', async () => {
    const seen: Parameters<typeof fakeFetch>[1] = [];
    let open = 0, most = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, init });
      open++;
      most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 30));
      open--;
      return ok(.4);
    };
    const client = new TtsClient(gptSovits({ apiBase: 'http://127.0.0.1:9880', refDir: refs() }), { fetch: fetchImpl });
    const [a, b] = await Promise.all([client.speak({ text: '甲' }), client.speak({ text: '乙' })]);
    expect(a.cached || b.cached).toBe(false);
    expect(seen).toHaveLength(2);
    expect(most).toBe(1);
    expect((await client.speak({ text: '甲' })).cached).toBe(true);
    expect(seen).toHaveLength(2);
    expect((await client.speak({ text: '甲', speed: 1.4 })).cached).toBe(false);
    expect(seen).toHaveLength(3);
  });

  it('does not let one failure stall the next line', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return ok(.3);
    };
    const client = new TtsClient(gptSovits({ apiBase: 'http://127.0.0.1:9880', refDir: refs() }), { fetch: fetchImpl });
    await expect(client.speak({ text: '坏' })).rejects.toThrow('boom');
    expect((await client.speak({ text: '好' })).seconds).toBeCloseTo(.3, 1);
  });
});

describe('other backends', () => {
  it('speaks OpenAI-compatible /audio/speech, and estimates an mp3', async () => {
    const seen: Parameters<typeof fakeFetch>[1] = [];
    const client = new TtsClient(openaiTts({ apiKey: 'sk-test', model: 'tts-1', format: 'mp3' }), {
      fetch: fakeFetch(() => new Response(new Uint8Array([0xFF, 0xFB, 0x90, 0x00]), { status: 200 }), seen),
    });
    const clip = await client.speak({ text: 'Hello there', voice: 'nova', speed: 1 });
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(seen[0]!.init!.headers!['authorization']).toBe('Bearer sk-test');
    expect(JSON.parse(String(seen[0]!.init!.body))).toMatchObject({ model: 'tts-1', input: 'Hello there', voice: 'nova', response_format: 'mp3' });
    expect(clip.mime).toBe('audio/mpeg');
    expect(clip.estimated).toBe(true);
    expect(clip.seconds).toBeGreaterThan(.5);
  });

  it('speaks a service of your own: JSON body, SSML body, and a health URL', async () => {
    const seen: Parameters<typeof fakeFetch>[1] = [];
    const client = new TtsClient(httpTts({
      name: 'cosyvoice',
      url: () => 'http://127.0.0.1:50000/inference_sft',
      json: (req) => ({ tts_text: req.text, spk_id: req.voice }),
      voices: ['中文女'],
    }), { fetch: fakeFetch(() => ok(.6), seen) });
    const clip = await client.speak({ text: '你好', voice: '中文女' });
    expect(JSON.parse(String(seen[0]!.init!.body))).toEqual({ tts_text: '你好', spk_id: '中文女' });
    expect(clip.seconds).toBeCloseTo(.6, 1);

    // Azure wants SSML and its own header: `raw` builds both
    const azureSeen: Parameters<typeof fakeFetch>[1] = [];
    const azure = new TtsClient(httpTts({
      name: 'azure',
      url: () => 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1',
      raw: (req) => ({ body: `<speak version='1.0' xml:lang='zh-CN'><voice name='zh-CN-XiaoxiaoNeural'>${req.text}</voice></speak>`, contentType: 'application/ssml+xml' }),
      headers: { 'x-microsoft-outputformat': 'riff-24khz-16bit-mono-pcm' },
      mime: 'audio/wav',
    }), { fetch: fakeFetch(() => ok(.9), azureSeen) });
    await azure.speak({ text: '你好' });
    expect(azureSeen[0]!.init!.headers!['content-type']).toBe('application/ssml+xml');
    expect(azureSeen[0]!.init!.headers!['x-microsoft-outputformat']).toBe('riff-24khz-16bit-mono-pcm');
    expect(String(azureSeen[0]!.init!.body)).toContain('<voice name=\'zh-CN-XiaoxiaoNeural\'>你好</voice>');
  });
});
