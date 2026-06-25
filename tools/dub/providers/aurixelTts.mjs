// providers/aurixelTts.mjs — TTS via the Aurixel OpenAI-compatible gateway.
// LIVE-VERIFIED on the production line (conduit-api.aurixel.ai) 2026-06-24.
//
// Same qwen3-tts-vc cloning engine as providers/qwenTtsVc.mjs, but reached through
// the gateway's OpenAI shape — so ONE Aurixel key (the same one used for chat
// translation + ASR) also does TTS + cloning. No DashScope-region key needed.
//
// Flow (verified against the live gateway):
//   enroll(sampleMp3)  -> POST {base}/audio/voices   (multipart: model + file)
//                         -> { voice: 'qwen-tts-vc-…' }
//   synthesize(text)   -> POST {base}/audio/speech    (JSON, OpenAI /speech shape)
//                         { model, input, voice, response_format } -> raw audio bytes
//
// The gateway proxies the SAME qwen3-tts-vc synthesis, so it still drifts per call
// (f0 ±~40Hz) — the pipeline's voice-select + pitch-norm handle that, unchanged.
// Cloning is once-per-speaker; the voice id is reused for every line.

import { readFile, writeFile } from 'node:fs/promises';
import { fetchWithRetry, errorText } from '../http.mjs';

export function makeAurixelTtsVc(cfg) {
  const base = (cfg.baseUrl || 'https://conduit-api.aurixel.ai/v1').replace(/\/$/, '');
  const key = cfg.apiKey;
  const vcModel = cfg.model || 'qwen3-tts-vc';
  const presetModel = cfg.presetModel || 'qwen-tts'; // for distinct-preset fallback voices
  const format = cfg.format || 'wav';
  const timeoutMs = cfg.timeoutMs || 120000;
  const retries = cfg.retries ?? 2;

  /**
   * Clone a voice from a short audio sample. Returns the cloned voice id.
   * @param {string} samplePath  mp3/wav of ONE speaker (a few–30s, clean)
   */
  async function enroll(samplePath, { name } = {}) {
    if (!key) throw new Error('Aurixel TTS-VC: AURIXEL_API_KEY missing');
    const buf = await readFile(samplePath);
    const mime = samplePath.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
    const form = new FormData();
    form.append('model', vcModel);
    form.append('file', new Blob([buf], { type: mime }), samplePath.endsWith('.wav') ? 'ref.wav' : 'ref.mp3');
    if (name) form.append('name', String(name));
    const res = await fetchWithRetry(
      `${base}/audio/voices`,
      { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form },
      { timeoutMs, retries, label: 'Aurixel voice enrollment' }
    );
    if (!res.ok) throw new Error(await errorText(res, 'Aurixel voice enrollment'));
    const j = await res.json();
    const voiceId = j?.voice || j?.voice_id || j?.id || j?.data?.voice;
    if (!voiceId) throw new Error(`Aurixel voice enrollment: no voice id (${JSON.stringify(j).slice(0, 200)})`);
    return voiceId;
  }

  /**
   * Synthesize speech in a (cloned) voice via the OpenAI /audio/speech shape.
   * Routes a cloned id ("qwen-tts-vc-…") to the VC model and a plain preset name
   * (e.g. "Chelsie") to the preset model — so an un-clonable speaker still gets a
   * distinct preset voice. opts.voiceId + opts.outPath required.
   * @returns {{outPath, bytes}}
   */
  async function synthesize(text, opts = {}) {
    if (!key) throw new Error('Aurixel TTS-VC: AURIXEL_API_KEY missing');
    const voice = opts.voiceId;
    const outPath = opts.outPath;
    if (!voice) throw new Error('Aurixel TTS-VC: voiceId required (enroll a speaker first)');
    if (!outPath) throw new Error('Aurixel TTS-VC: outPath required');
    const useModel = String(voice).startsWith('qwen-tts-vc') ? vcModel : presetModel;
    const res = await fetchWithRetry(
      `${base}/audio/speech`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: useModel, input: text, voice, response_format: opts.format || format }),
      },
      { timeoutMs, retries, label: 'Aurixel TTS-VC' }
    );
    if (!res.ok) throw new Error(await errorText(res, 'Aurixel TTS-VC'));
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length < 64) throw new Error(`Aurixel TTS-VC: empty audio (${audio.length}B)`);
    await writeFile(outPath, audio);
    return { outPath, bytes: audio.length };
  }

  return { kind: 'aurixel-tts-vc', supportsCloning: true, enroll, synthesize };
}

/**
 * Preset (non-cloning) TTS through the same gateway — locked Qwen voices
 * (Cherry/Katerina/…) via POST {base}/audio/speech with model=qwen-tts.
 */
export function makeAurixelTts(cfg) {
  const base = (cfg.baseUrl || 'https://conduit-api.aurixel.ai/v1').replace(/\/$/, '');
  const key = cfg.apiKey;
  const model = cfg.model || 'qwen-tts';
  const defaultVoice = cfg.voice || 'Cherry';
  const format = cfg.format || 'wav';
  const timeoutMs = cfg.timeoutMs || 120000;
  const retries = cfg.retries ?? 2;

  async function synthesize(text, opts = {}) {
    if (!key) throw new Error('Aurixel TTS: AURIXEL_API_KEY missing');
    const outPath = opts.outPath;
    if (!outPath) throw new Error('Aurixel TTS: outPath required');
    const voice = opts.voiceId || defaultVoice;
    const res = await fetchWithRetry(
      `${base}/audio/speech`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text, voice, response_format: opts.format || format }),
      },
      { timeoutMs, retries, label: 'Aurixel TTS' }
    );
    if (!res.ok) throw new Error(await errorText(res, 'Aurixel TTS'));
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length < 64) throw new Error(`Aurixel TTS: empty audio (${audio.length}B)`);
    await writeFile(outPath, audio);
    return { outPath, bytes: audio.length };
  }

  return { kind: 'aurixel-tts', synthesize };
}
