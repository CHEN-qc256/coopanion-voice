/**
 * The voice output settings page. It talks to four small endpoints and nothing else:
 *
 * ```
 * GET  /api/voiceout            → { settings, voices, service, limits }
 * POST /api/voiceout            ← { enabled?, read?, voice?, speed?, volume?, pitch?, service?: { auto } }
 * POST /api/voiceout/preview    ← { text }  → { url, seconds } | { error }
 * POST /api/voiceout/service    ← { action: 'start' | 'stop' } → { service }
 * ```
 *
 * `examples/server.ts` implements them for the stand-alone demo, and the Coopanion integration uses the
 * same shapes (`docs/integration.md`). Everything is saved as it changes, and the volume and pitch are
 * applied to this page's own player at once, so 试听 plays exactly what is set.
 */
import { createPlayer } from './player.js';

const TEXT = {
  zh: {
    title: '语音输出',
    sub: '桌宠用本机的语音服务说话,改完立刻生效。',
    enabled: '朗读气泡',
    read: '朗读范围',
    readAll: '所有气泡',
    readSpeak: '只念主动朗读的',
    readOff: '都不念',
    readAllHint: '模型说的每句都念;气泡先出现,声音随后跟上。',
    readSpeakHint: '只有模型主动要求朗读的才念,普通气泡不出声。',
    readOffHint: '都不念,只显示文字。',
    voice: '音色',
    speed: '语速',
    volume: '音量',
    pitch: '音调',
    semitones: '{n} 半音',
    preview: '试听',
    previewing: '正在合成…',
    sample: '你好呀,我是库。这样说话,你听着还舒服吗?',
    saved: '已保存,立刻生效',
    saving: '保存中…',
    hint: '音量和音调当场生效;音色和语速从下一句起生效。',
    failed: '试听失败:{why}',
    noVoices: '没有可选音色',
    service: '语音服务',
    serviceAuto: '随桌宠启动',
    start: '启动',
    stop: '停止',
    retry: '重新启动',
    serviceOff: '未启动',
    serviceStarting: '启动中',
    serviceReady: '已就绪',
    serviceFailed: '启动失败',
    serviceStartingHint: '模型加载一般要 40–60 秒,加载完就能立刻朗读。',
    serviceReadyHint: '语音服务在运行,可以直接试听。',
    serviceExternal: '这个服务是别处启动的,桌宠退出时不会关它。',
    serviceOffHint: '没在运行。点「启动」让桌宠把模型拉起来。',
  },
  en: {
    title: 'Voice',
    sub: 'The pet speaks through the service on this machine; changes take effect at once.',
    enabled: 'Read bubbles out loud',
    read: 'What is read out',
    readAll: 'Every bubble',
    readSpeak: 'Only what it asks to speak',
    readOff: 'Nothing',
    readAllHint: 'Every line; the bubble shows first and the voice follows it.',
    readSpeakHint: 'Only lines the bot explicitly asks to speak.',
    readOffHint: 'Nothing is read out; bubbles only show their text.',
    voice: 'Voice',
    speed: 'Speaking rate',
    volume: 'Volume',
    pitch: 'Pitch',
    semitones: '{n} st',
    preview: 'Listen',
    previewing: 'Synthesizing…',
    sample: 'Hi, I am Coo. Is this comfortable to listen to?',
    saved: 'Saved, in effect now',
    saving: 'Saving…',
    hint: 'Volume and pitch apply at once; voice and rate from the next line.',
    failed: 'Could not play it: {why}',
    noVoices: 'No voice to choose',
    service: 'Speech service',
    serviceAuto: 'Start with the pet',
    start: 'Start',
    stop: 'Stop',
    retry: 'Start again',
    serviceOff: 'Not running',
    serviceStarting: 'Starting',
    serviceReady: 'Ready',
    serviceFailed: 'Could not start',
    serviceStartingHint: 'Loading the models takes about 40–60 s; then it can speak at once.',
    serviceReadyHint: 'The service is running; Listen plays right away.',
    serviceExternal: 'This one was started elsewhere; it is left running.',
    serviceOffHint: 'Not running. Press Start to have the models loaded.',
  },
};

const API = '/api/voiceout';
const lang = () => ((document.documentElement.lang || '').toLowerCase().startsWith('en') ? 'en' : 'zh');
const t = (key, vars) => {
  const s = TEXT[lang()][key] ?? TEXT.en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
};

const $ = (s) => document.querySelector(s);
const el = {
  on: $('#on'), read: $('#read'), readHint: $('#readHint'),
  voice: $('#voice'), speed: $('#speed'), speedVal: $('#speedVal'),
  volume: $('#volume'), volumeVal: $('#volumeVal'), pitch: $('#pitch'), pitchVal: $('#pitchVal'),
  preview: $('#preview'), hint: $('#hint'), saved: $('#saved'),
  service: $('#service'), serviceText: $('#serviceText'), phase: $('#servicePhase'),
  serviceStart: $('#serviceStart'), serviceStop: $('#serviceStop'), auto: $('#auto'), serviceDetail: $('#serviceDetail'),
};

/* ---------- audio: this page's own context, made on the first gesture ---------- */
let ctx = null, master = null;
function output() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return { ctx, master };
}
const player = createPlayer({ audio: output });
const unlock = () => { try { output(); } catch { /* no audio here */ } };
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, unlock, { capture: true }));

/* ---------- state ---------- */
let cur = { enabled: true, read: 'all', voice: 'default', speed: 1, volume: .85, pitch: 0 };
let pending = {};
let saveTimer = null;
let savedAt = 0;
let serviceTimer = null;

const pct = (v) => `${Math.round(v * 100)}%`;
const semitones = (v) => t('semitones', { n: v > 0 ? `+${v}` : String(v) });

function paint(next) {
  cur = { ...cur, ...next };
  el.on.checked = !!cur.enabled;
  for (const b of el.read.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.read === cur.read));
  el.readHint.textContent = t(cur.read === 'all' ? 'readAllHint' : cur.read === 'speak' ? 'readSpeakHint' : 'readOffHint');
  el.speed.value = cur.speed;
  el.speedVal.textContent = Number(cur.speed).toFixed(2);
  el.volume.value = cur.volume;
  el.volumeVal.textContent = pct(cur.volume);
  el.pitch.value = cur.pitch;
  el.pitchVal.textContent = semitones(cur.pitch);
  player.set({ volume: cur.volume, pitch: cur.pitch });
}

function showVoices(list, picked) {
  el.voice.innerHTML = '';
  for (const id of list) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = id;
    el.voice.append(o);
  }
  if (!list.length) {
    const o = document.createElement('option');
    o.textContent = t('noVoices');
    o.disabled = true;
    el.voice.append(o);
  } else el.voice.value = picked;
}

/** The phase words and the dot's colour in the header. */
const PHASE = {
  off: ['serviceOff', ''],
  starting: ['serviceStarting', 'busy'],
  ready: ['serviceReady', 'ok'],
  failed: ['serviceFailed', 'bad'],
};

function applyService(s) {
  if (!s || typeof s !== 'object') return;
  const [label, tone] = PHASE[s.phase] ?? PHASE.off;
  el.phase.textContent = t(label);
  el.phase.className = `vo-phase ${tone}`;
  el.service.classList.toggle('ok', s.phase === 'ready');
  el.service.classList.toggle('down', s.phase === 'failed' || s.phase === 'off');
  el.serviceText.textContent = t(label);
  el.auto.checked = !!s.auto;
  el.serviceStart.hidden = s.phase === 'starting' || s.phase === 'ready';
  el.serviceStart.textContent = t(s.phase === 'failed' ? 'retry' : 'start');
  el.serviceStart.classList.toggle('primary', s.phase !== 'ready');
  el.serviceStop.hidden = !s.owned;
  const last = Array.isArray(s.log) && s.log.length ? s.log[s.log.length - 1] : '';
  el.serviceDetail.textContent = s.phase === 'starting' ? (s.detail || t('serviceStartingHint'))
    : s.phase === 'failed' ? [s.detail, last].filter(Boolean).join(' · ')
      : s.phase === 'ready' ? (s.external ? t('serviceExternal') : t('serviceReadyHint'))
        : t('serviceOffHint');
  if (s.phase === 'starting') startPolling();
  else stopPolling();
}

function stopPolling() {
  if (!serviceTimer) return;
  clearInterval(serviceTimer);
  serviceTimer = null;
}

/** A load takes about a minute; this asks again until it settles. */
function startPolling() {
  if (serviceTimer) return;
  serviceTimer = setInterval(async () => {
    try {
      const state = await (await fetch(API)).json();
      applyService(state.service);
    } catch { stopPolling(); }
  }, 1600);
}

/** Saves what changed, merged so a dragged slider sends one request. */
function save(change) {
  Object.assign(pending, change);
  el.saved.textContent = t('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const body = pending;
    pending = {};
    try {
      const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const state = await res.json();
      // not repainted whole: a slider being dragged must not jump under the finger
      if (Array.isArray(state.voices)) showVoices(state.voices, state.settings.voice);
      applyService(state.service);
      savedAt = Date.now();
      el.saved.textContent = t('saved');
      setTimeout(() => { if (Date.now() - savedAt > 1400) el.saved.textContent = ''; }, 1500);
    } catch (err) {
      el.saved.textContent = String(err?.message ?? err);
    }
  }, 220);
}

async function setService(action) {
  el.serviceStart.disabled = true;
  el.serviceStop.disabled = true;
  try {
    const res = await fetch(`${API}/service`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
    const out = await res.json();
    applyService(out.service);
  } catch (err) {
    el.serviceDetail.textContent = String(err?.message ?? err);
  } finally {
    el.serviceStart.disabled = false;
    el.serviceStop.disabled = false;
  }
}

/** 试听: the sample sentence, synthesized with the settings as they are. */
async function preview() {
  el.preview.disabled = true;
  el.hint.textContent = t('previewing');
  try {
    const res = await fetch(`${API}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t('sample') }) });
    const out = await res.json();
    if (out.error) { el.hint.textContent = `${t('failed', { why: '' })}${out.error}`; return; }
    el.hint.textContent = '';
    const clip = player.play(out.url);
    await new Promise((done) => {
      const iv = setInterval(() => { if (clip.ended) { clearInterval(iv); done(); } }, 120);
    });
  } catch (err) {
    el.hint.textContent = t('failed', { why: String(err?.message ?? err) });
  } finally {
    el.preview.disabled = false;
  }
}

/* ---------- wiring ---------- */
el.on.addEventListener('change', () => { paint({ enabled: el.on.checked }); save({ enabled: el.on.checked }); });
el.read.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-read]');
  if (!b) return;
  paint({ read: b.dataset.read });
  save({ read: b.dataset.read });
});
el.voice.addEventListener('change', () => { paint({ voice: el.voice.value }); save({ voice: el.voice.value }); });
for (const [id, key, apply] of [
  ['speed', 'speed', () => {}],
  ['volume', 'volume', () => player.set({ volume: cur.volume })],
  ['pitch', 'pitch', () => player.set({ pitch: cur.pitch })],
]) {
  el[id].addEventListener('input', () => {
    const value = Number(el[id].value);
    paint({ [key]: value });
    apply();
    save({ [key]: value });
  });
}
el.serviceStart.addEventListener('click', () => { unlock(); void setService('start'); });
el.serviceStop.addEventListener('click', () => { void setService('stop'); });
el.auto.addEventListener('change', () => save({ service: { auto: el.auto.checked } }));
el.preview.addEventListener('click', () => { unlock(); void preview(); });

async function start() {
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  document.title = t('title');
  paint(cur);
  try {
    const state = await (await fetch(API)).json();
    const s = state.settings ?? {};
    paint({ enabled: s.enabled, read: s.read, voice: s.voice, speed: s.speed, volume: s.volume, pitch: s.pitch });
    showVoices(state.voices ?? [], s.voice);
    applyService(state.service);
  } catch (err) {
    el.saved.textContent = String(err?.message ?? err);
  }
}
void start();
