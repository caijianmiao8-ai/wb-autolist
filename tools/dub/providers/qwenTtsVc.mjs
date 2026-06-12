// providers/qwenTtsVc.mjs — Qwen3-TTS Voice Cloning (DashScope). LIVE-VERIFIED.
//
// Unlike the other TTS providers, this one can CLONE a speaker's voice from a
// short audio sample (`enroll`) and then speak RUSSIAN in that cloned voice
// (`synthesize`). Cross-lingual: enroll an English speaker -> output fluent RU.
// This fills the gap left by the restricted ElevenLabs key (cloning disabled).
//
// Flow (per the verified DashScope API):
//  1. enroll(sampleMp3) -> POST /api/v1/services/audio/tts/customization
//       { model:'qwen-voice-enrollment', input:{action:'create',
//         target_model:'qwen3-tts-vc-...', preferred_name, audio:{data:<dataUri>}}}
//     -> { output: { voice: '<voiceId>' } }
//  2. synthesize(text,{voiceId}) -> POST /api/v1/services/aigc/multimodal-generation/generation
//       { model:'qwen3-tts-vc-...', input:{text}, parameters:{voice, format:'wav', ...}}
//     -> { output: { audio: { url } } }  (temporary OSS link; download immediately)
//
// NOTE: the user's key is BEIJING-region (dashscope.aliyuncs.com). The intl
// (Singapore) host rejects it. Keep the base configurable.

import { readFile, writeFile } from 'node:fs/promises';
import { fetchWithRetry, errorText } from '../http.mjs';

/** Sanitize a label into an enrollment preferred_name (lowercase alnum). */
function safeName(s) {
  return ('dub' + String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 24) || 'dubvoice';
}

export function makeQwenTtsVc(cfg) {
  const base = (cfg.baseUrl || 'https://dashscope.aliyuncs.com').replace(/\/$/, '');
  const key = cfg.apiKey;
  const model = cfg.model || 'qwen3-tts-vc-2026-01-22';
  const enrollModel = cfg.enrollModel || 'qwen-voice-enrollment';
  const sampleRate = cfg.sampleRate || 24000;
  const timeoutMs = cfg.timeoutMs || 120000;
  const retries = cfg.retries ?? 2;

  async function post(path, body, label) {
    const res = await fetchWithRetry(
      `${base}${path}`,
      { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      { timeoutMs, retries, label }
    );
    if (!res.ok) throw new Error(await errorText(res, label));
    const j = await res.json();
    if (j?.code) throw new Error(`${label}: ${j.code} ${j.message || ''}`.trim());
    return j;
  }

  /**
   * Clone a voice from a short audio sample. Returns the cloned voice id.
   * @param {string} samplePath  mp3/wav of ONE speaker (a few–30s, clean)
   * @param {object} [opts] {name}
   */
  async function enroll(samplePath, { name } = {}) {
    if (!key) throw new Error('Qwen TTS-VC: QWEN_API_KEY missing');
    const buf = await readFile(samplePath);
    const mime = samplePath.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
    const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
    const j = await post(
      '/api/v1/services/audio/tts/customization',
      { model: enrollModel, input: { action: 'create', target_model: model, preferred_name: safeName(name), audio: { data: dataUri } } },
      'Qwen voice enrollment'
    );
    const voiceId = j?.output?.voice || j?.output?.voice_id;
    if (!voiceId) throw new Error(`Qwen voice enrollment: no voice id in response (${JSON.stringify(j).slice(0, 200)})`);
    return voiceId;
  }

  /**
   * Synthesize speech in a (cloned) voice. opts.voiceId is REQUIRED — it is a
   * voice id produced by enroll(); there is no usable default for VC.
   * @returns {{outPath, bytes}}
   */
  async function synthesize(text, opts = {}) {
    if (!key) throw new Error('Qwen TTS-VC: QWEN_API_KEY missing');
    const voice = opts.voiceId;
    const outPath = opts.outPath;
    if (!voice) throw new Error('Qwen TTS-VC: voiceId required (enroll a speaker first)');
    if (!outPath) throw new Error('Qwen TTS-VC: outPath required');

    const j = await post(
      '/api/v1/services/aigc/multimodal-generation/generation',
      { model, input: { text }, parameters: { voice, sample_rate: sampleRate, format: 'wav', response_format: 'wav' } },
      'Qwen TTS-VC'
    );
    const url = j?.output?.audio?.url || j?.output?.url;
    const b64 = j?.output?.audio?.data;
    let audio;
    if (url) {
      const a = await fetchWithRetry(url, { method: 'GET' }, { timeoutMs, retries, label: 'Qwen TTS-VC audio' });
      if (!a.ok) throw new Error(await errorText(a, 'Qwen TTS-VC audio'));
      audio = Buffer.from(await a.arrayBuffer());
    } else if (b64) {
      audio = Buffer.from(b64, 'base64');
    } else {
      throw new Error(`Qwen TTS-VC: no audio in response (${JSON.stringify(j).slice(0, 200)})`);
    }
    await writeFile(outPath, audio);
    return { outPath, bytes: audio.length };
  }

  // supportsCloning flags the pipeline to run per-speaker enrollment first.
  return { kind: 'qwen-tts-vc', supportsCloning: true, enroll, synthesize };
}

/**
 * Qwen3-TTS PRESET voices (qwen3-tts-flash) — fixed, locked-in voices (Cherry,
 * Serena, Chelsie, Katerina, Ethan, Dylan, …) that speak Russian. Unlike qwen-vc
 * these are stable across calls (no per-call clone drift) but can't reproduce the
 * original speaker. voiceId = a preset name.
 */
export function makeQwenTts(cfg) {
  const base = (cfg.baseUrl || 'https://dashscope.aliyuncs.com').replace(/\/$/, '');
  const key = cfg.apiKey;
  const model = cfg.model || 'qwen3-tts-flash';
  const defaultVoice = cfg.voice || 'Cherry';
  const sampleRate = cfg.sampleRate || 24000;
  const timeoutMs = cfg.timeoutMs || 120000;
  const retries = cfg.retries ?? 2;

  async function synthesize(text, opts = {}) {
    if (!key) throw new Error('Qwen TTS: QWEN_API_KEY missing');
    const outPath = opts.outPath;
    if (!outPath) throw new Error('Qwen TTS: outPath required');
    const voice = opts.voiceId || defaultVoice;
    const res = await fetchWithRetry(
      `${base}/api/v1/services/aigc/multimodal-generation/generation`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: { text }, parameters: { voice, sample_rate: sampleRate, format: 'wav', response_format: 'wav' } }),
      },
      { timeoutMs, retries, label: 'Qwen TTS' }
    );
    if (!res.ok) throw new Error(await errorText(res, 'Qwen TTS'));
    const j = await res.json();
    if (j?.code) throw new Error(`Qwen TTS: ${j.code} ${j.message || ''}`.trim());
    const url = j?.output?.audio?.url || j?.output?.url;
    if (!url) throw new Error(`Qwen TTS: no audio (${JSON.stringify(j).slice(0, 160)})`);
    const a = await fetchWithRetry(url, { method: 'GET' }, { timeoutMs, retries, label: 'Qwen TTS audio' });
    if (!a.ok) throw new Error(await errorText(a, 'Qwen TTS audio'));
    const audio = Buffer.from(await a.arrayBuffer());
    await writeFile(outPath, audio);
    return { outPath, bytes: audio.length };
  }

  return { kind: 'qwen-tts', synthesize };
}
