// providers/elevenlabs.mjs — ElevenLabs Scribe STT + Russian TTS.
//
// LIVE-VERIFIED contracts:
//  - Auth header is `xi-api-key` (NOT Bearer).
//  - STT: POST {base}/v1/speech-to-text, multipart, model_id=scribe_v1 REQUIRED,
//    word-level timestamps; response has NO top-level segments -> we chunk words.
//  - TTS: POST {base}/v1/text-to-speech/{voiceId}?output_format=... , JSON body,
//    returns raw mp3 bytes. /with-timestamps variant returns JSON with alignment
//    (we use its last char end-time as the exact duration, avoiding an ffprobe).
//
// Both providers are duck-typed:
//   AsrProvider.transcribe(audioPath, {language}) -> {text, language, duration, segments:[{start,end,text}]}
//   TtsProvider.synthesize(text, {voiceId, modelId, language, format, outPath}) -> {outPath, bytes, durationSec?}

import { readFile, writeFile } from 'node:fs/promises';
import { fetchWithRetry, errorText } from '../http.mjs';

// --- segment chunking (shared shape with the verified contract) ---
const GAP = 0.6;
const MAX_WORDS = 14;
const SENTENCE_END = /[.!?…][")»]?$/;

export function chunkWordsToSegments(words, { gap = GAP, maxWords = MAX_WORDS } = {}) {
  const segments = [];
  let cur = null;
  const flush = () => {
    if (cur) {
      cur.text = cur.text.trim();
      if (cur.text) segments.push(cur);
      cur = null;
    }
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = words[i - 1];
    const spk = w.speaker_id ?? null;
    // A speaker change always starts a new segment so each chunk is single-voice.
    if (cur && cur.speaker != null && spk != null && spk !== cur.speaker) flush();
    if (!cur) cur = { start: w.start, end: w.end, text: '', speaker: spk };
    cur.text += (cur.text ? ' ' : '') + w.text;
    cur.end = w.end;
    if (cur.speaker == null) cur.speaker = spk;
    const bigGap = prev && w.start - prev.end > gap;
    const sentenceEnd = SENTENCE_END.test(w.text);
    const tooLong = cur.text.split(' ').length >= maxWords;
    if (sentenceEnd || bigGap || tooLong) flush();
  }
  flush();
  return segments;
}

// Map our generic format -> ElevenLabs output_format query value.
function mapTtsFormat(format) {
  switch ((format || 'mp3').toLowerCase()) {
    case 'mp3':
    case 'mp3_44100_128':
      return 'mp3_44100_128'; // ceiling on the restricted key
    case 'mp3_22050_32':
      return 'mp3_22050_32';
    case 'wav':
    case 'wav_44100':
      return 'wav_44100'; // bare 'wav' is rejected by the API
    case 'opus':
    case 'opus_48000_64':
      return 'opus_48000_64';
    case 'pcm':
    case 'pcm_24000':
      return 'pcm_24000';
    default:
      return format; // pass through advanced values verbatim
  }
}

/** ElevenLabs Scribe STT provider. */
export function makeElevenLabsAsr(cfg) {
  const base = (cfg.baseUrl || 'https://api.elevenlabs.io').replace(/\/$/, '');
  const key = cfg.apiKey;
  const model = cfg.model || 'scribe_v1';
  const timeoutMs = cfg.timeoutMs || 180000;
  const retries = cfg.retries ?? 2;

  async function transcribe(audioPath, { language, diarize = false } = {}) {
    if (!key) throw new Error('ElevenLabs ASR: ELEVENLABS_API_KEY missing');
    const buf = await readFile(audioPath);
    const form = new FormData();
    form.append('model_id', model); // REQUIRED — omit => 422
    form.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'audio');
    form.append('timestamps_granularity', 'word');
    form.append('tag_audio_events', 'true');
    // diarize=true tags each word with speaker_id so we can dub each speaker in a
    // distinct voice (e.g. female narrator vs. a child) instead of one fixed voice.
    form.append('diarize', diarize ? 'true' : 'false');
    if (language) form.append('language_code', language);

    const res = await fetchWithRetry(
      `${base}/v1/speech-to-text`,
      { method: 'POST', headers: { 'xi-api-key': key }, body: form }, // do NOT set Content-Type
      { timeoutMs, retries, label: 'ElevenLabs Scribe STT' }
    );
    if (!res.ok) throw new Error(await errorText(res, 'ElevenLabs Scribe STT'));
    const data = await res.json();
    const words = (data.words || []).filter((w) => w.type === 'word');
    const segments = chunkWordsToSegments(words);
    return {
      text: data.text,
      language: data.language_code,
      duration: data.audio_duration_secs,
      transcriptionId: data.transcription_id,
      segments,
      raw: data, // persisted by the pipeline for caching/debug
    };
  }

  return { kind: 'elevenlabs-asr', transcribe };
}

/** ElevenLabs Russian TTS provider. */
export function makeElevenLabsTts(cfg) {
  const base = (cfg.baseUrl || 'https://api.elevenlabs.io').replace(/\/$/, '');
  const key = cfg.apiKey;
  const defaultModel = cfg.model || 'eleven_multilingual_v2';
  const defaultVoice = cfg.voiceId || 'JBFqnCBsd6RMkjVDRZzb'; // George
  const defaultFormat = cfg.outputFormat || 'mp3_44100_128';
  const timeoutMs = cfg.timeoutMs || 120000;
  const retries = cfg.retries ?? 2;

  // voice_settings; speed (0.7-1.2) is an optional coarse pre-synth nudge.
  function settings(speed) {
    const s = { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true };
    if (speed != null) s.speed = Math.min(Math.max(speed, 0.7), 1.2);
    return s;
  }

  /**
   * Synthesize speech. Uses /with-timestamps so we also get the exact duration
   * (alignment.character_end_times_seconds.at(-1)) without a separate ffprobe.
   * @returns {{outPath, bytes, durationSec?}}
   */
  async function synthesize(text, opts = {}) {
    if (!key) throw new Error('ElevenLabs TTS: ELEVENLABS_API_KEY missing');
    const voiceId = opts.voiceId || defaultVoice;
    const modelId = opts.modelId || defaultModel;
    const language = opts.language; // optional 'ru'
    const outPath = opts.outPath;
    const fmt = mapTtsFormat(opts.format || defaultFormat);
    const speed = opts.speed;
    if (!outPath) throw new Error('ElevenLabs TTS: outPath required');

    const body = {
      text,
      model_id: modelId,
      voice_settings: settings(speed),
      ...(language ? { language_code: language } : {}),
    };

    if (opts.withTimestamps !== false) {
      const url = `${base}/v1/text-to-speech/${voiceId}/with-timestamps?output_format=${fmt}`;
      const res = await fetchWithRetry(
        url,
        { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) },
        { timeoutMs, retries, label: 'ElevenLabs TTS' }
      );
      if (!res.ok) throw new Error(await errorText(res, 'ElevenLabs TTS'));
      const j = await res.json();
      const audio = Buffer.from(j.audio_base64, 'base64');
      await writeFile(outPath, audio);
      const ends = j.alignment?.character_end_times_seconds;
      const durationSec = Array.isArray(ends) && ends.length ? ends[ends.length - 1] : undefined;
      return { outPath, bytes: audio.length, durationSec };
    }

    // raw-bytes path (no timing)
    const url = `${base}/v1/text-to-speech/${voiceId}?output_format=${fmt}`;
    const res = await fetchWithRetry(
      url,
      { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify(body) },
      { timeoutMs, retries, label: 'ElevenLabs TTS' }
    );
    if (!res.ok) throw new Error(await errorText(res, 'ElevenLabs TTS'));
    const audio = Buffer.from(await res.arrayBuffer());
    await writeFile(outPath, audio);
    return { outPath, bytes: audio.length };
  }

  return { kind: 'elevenlabs-tts', synthesize };
}
