// providers/joyvizAsr.mjs — ASR via the JoyViz/Aurixel OpenAI-compatible gateway.
// LIVE-VERIFIED 2026-06-18: with response_format=verbose_json the gateway now
// passes through Speechmatics' rich result — per-segment AND per-word timestamps,
// plus speaker diarization when the diarize flags are set.
//
//   POST {base}/audio/transcriptions  (multipart)
//     model=speechmatics-enhanced, response_format=verbose_json, language,
//     diarize/diarization/speaker_labels=true
//   -> { duration, language, text, segments:[{id,start,end,text,speaker}], words:[…] }
//
// So ONE gateway key can also do ASR (same key as chat-translate + TTS).
//
// speaker_sensitivity (LIVE-VERIFIED works via the gateway as of 2026-06-18): LOW
// (0.3) folds Speechmatics' spurious same-speaker over-split back together so ONE
// excited presenter isn't cloned as two voices, while still isolating a real 2nd
// speaker (even a minority child). The gateway honors `speaker_sensitivity` /
// `sensitivity` (NOT `diarization_sensitivity`). Remaining hard parent/child
// overlap mislabels are fixed downstream by translate.refineSpeakers (gpt-5.5).
//
// NOTE: Deepgram through this gateway is still TEXT-ONLY; use a Speechmatics model.

import { readFile } from 'node:fs/promises';
import { fetchWithRetry, errorText } from '../http.mjs';

// Speechmatics labels are "S1","S2",… (and "UU" when undiarized). Normalize to the
// pipeline's "speaker_0","speaker_1",… (S<n> -> speaker_<n-1>; UU -> speaker_0).
function normSpeaker(s) {
  const n = parseInt(String(s || '').replace(/\D/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? `speaker_${n - 1}` : 'speaker_0';
}

export function makeJoyvizAsr(cfg = {}) {
  const base = (cfg.baseUrl || 'https://conduit-api.joyviz.ai/v1').replace(/\/$/, '');
  const key = cfg.apiKey;
  const model = cfg.model || 'speechmatics-enhanced';
  const speakerSensitivity = cfg.speakerSensitivity ?? 0.3; // low = fewer speakers (avoid over-split)
  const timeoutMs = cfg.timeoutMs || 300000;
  const retries = cfg.retries ?? 1;

  async function transcribe(audioPath, { language = 'en', diarize = true } = {}) {
    if (!key) throw new Error('JoyViz ASR: gateway API key missing');
    const buf = await readFile(audioPath);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    if (language) form.append('language', language);
    if (diarize) {
      // The gateway has accepted any of these to switch diarization on; send all.
      form.append('diarize', 'true');
      form.append('diarization', 'true');
      form.append('speaker_labels', 'true');
      // LOW sensitivity folds spurious same-speaker over-splits back (one person
      // cloned as two = the drift bug). `speaker_sensitivity` is the name the
      // gateway honors (`diarization_sensitivity` is ignored); send `sensitivity`
      // too as a harmless alias.
      form.append('speaker_sensitivity', String(speakerSensitivity));
      form.append('sensitivity', String(speakerSensitivity));
    }
    const res = await fetchWithRetry(
      `${base}/audio/transcriptions`,
      { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form },
      { timeoutMs, retries, label: 'JoyViz ASR' }
    );
    if (!res.ok) throw new Error(await errorText(res, 'JoyViz ASR'));
    const j = await res.json();
    const rawSegs = Array.isArray(j.segments) ? j.segments : null;
    if (!rawSegs || !rawSegs.length) {
      // verbose_json must yield segments; text-only means the gateway regressed to
      // the old lossy STT — fail loudly so ASR is moved back to a timing-capable one.
      throw new Error(
        `JoyViz ASR: no segments in verbose_json response (gateway returned text-only?) keys=${Object.keys(j).join(',')}`
      );
    }
    const segments = rawSegs
      .map((s) => ({
        start: Number(s.start),
        end: Number(s.end),
        text: String(s.text || '').trim(),
        speaker: normSpeaker(s.speaker),
      }))
      .filter((s) => s.text && Number.isFinite(s.start) && s.end > s.start);
    if (!segments.length) throw new Error('JoyViz ASR: no usable speech segments');
    const speakers = new Set(segments.map((s) => s.speaker));
    return {
      text: j.text || segments.map((s) => s.text).join(' '),
      language: j.language || language,
      segments,
      diarizes: speakers.size > 1,
      raw: { provider: 'joyviz', model, segments: segments.length, speakers: speakers.size },
    };
  }

  return { kind: 'joyviz-asr', transcribe };
}
