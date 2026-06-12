// providers/aurixelAudio.mjs — Aurixel ASR + TTS (OpenAI-compatible stubs).
//
// RESERVED EXTENSION POINT. Aurixel /v1/audio/transcriptions and /v1/audio/speech
// return HTTP 404 TODAY (live-confirmed). These providers are already correctly
// formed OpenAI-style requests: the day Aurixel "syncs ElevenLabs in" and the
// endpoints return 200, flipping ASR_PROVIDER/TTS_PROVIDER=aurixel Just Works
// with ZERO code changes. Until then they throw a clear, actionable error.
//
// They expose the SAME duck-typed interface as the ElevenLabs providers:
//   transcribe(audioPath, {language}) -> {text, language, segments:[{start,end,text}]}
//   synthesize(text, {voiceId, format, outPath}) -> {outPath, bytes, durationSec?}

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fetchWithRetry, errorText } from '../http.mjs';

const NOT_ENABLED_ASR =
  'Aurixel ASR not enabled yet (POST /audio/transcriptions -> 404). ' +
  'Set ASR_PROVIDER=elevenlabs until Aurixel syncs in audio models. See tools/dub/README.md.';
const NOT_ENABLED_TTS =
  'Aurixel TTS not enabled yet (POST /audio/speech -> 404). ' +
  'Set TTS_PROVIDER=elevenlabs until Aurixel syncs in audio models. See tools/dub/README.md.';

/** Aurixel Whisper-style ASR (OpenAI verbose_json). */
export function makeAurixelAsr(cfg) {
  const base = (cfg.baseUrl || 'https://conduit-api.aurixel.ai/v1').replace(/\/$/, '');
  const key = cfg.apiKey;
  const model = cfg.model || 'whisper-1';
  const timeoutMs = cfg.timeoutMs || 180000;
  const retries = cfg.retries ?? 2;

  async function transcribe(audioPath, { language } = {}) {
    if (!key) throw new Error('Aurixel ASR: AURIXEL_API_KEY missing');
    const buf = await readFile(audioPath);
    const form = new FormData();
    form.append('file', new Blob([buf]), basename(audioPath));
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment'); // OpenAI array param
    if (language) form.append('language', language);

    const res = await fetchWithRetry(
      `${base}/audio/transcriptions`,
      { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form },
      { timeoutMs, retries, label: 'Aurixel ASR' }
    );
    if (res.status === 404) throw new Error(NOT_ENABLED_ASR);
    if (!res.ok) throw new Error(await errorText(res, 'Aurixel ASR'));
    const data = await res.json();
    // OpenAI verbose_json already returns segments [{start,end,text}] 1:1.
    const segments = (data.segments || []).map((s) => ({
      start: Number.isFinite(Number(s.start)) ? Number(s.start) : 0,
      end: Number.isFinite(Number(s.end)) ? Number(s.end) : 0,
      text: (s.text || '').trim(),
    }));
    return { text: data.text, language: data.language, segments, raw: data };
  }

  return { kind: 'aurixel-asr', transcribe };
}

/** Aurixel OpenAI-style TTS (/audio/speech). */
export function makeAurixelTts(cfg) {
  const base = (cfg.baseUrl || 'https://conduit-api.aurixel.ai/v1').replace(/\/$/, '');
  const key = cfg.apiKey;
  const model = cfg.model || 'tts-1';
  const defaultVoice = cfg.voice || 'alloy';
  const timeoutMs = cfg.timeoutMs || 120000;
  const retries = cfg.retries ?? 2;

  async function synthesize(text, opts = {}) {
    if (!key) throw new Error('Aurixel TTS: AURIXEL_API_KEY missing');
    const outPath = opts.outPath;
    if (!outPath) throw new Error('Aurixel TTS: outPath required');
    const voice = opts.voiceId || defaultVoice;
    const fmt = (opts.format || 'mp3').replace(/^mp3.*/, 'mp3').replace(/^wav.*/, 'wav');

    const res = await fetchWithRetry(
      `${base}/audio/speech`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text, voice, response_format: fmt }),
      },
      { timeoutMs, retries, label: 'Aurixel TTS' }
    );
    if (res.status === 404) throw new Error(NOT_ENABLED_TTS);
    if (!res.ok) throw new Error(await errorText(res, 'Aurixel TTS'));
    const audio = Buffer.from(await res.arrayBuffer());
    await writeFile(outPath, audio);
    // OpenAI /audio/speech gives no timing -> downstream falls back to ffprobe.
    return { outPath, bytes: audio.length };
  }

  return { kind: 'aurixel-tts', synthesize };
}
