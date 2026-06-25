// providers/deepgramAsr.mjs — Deepgram cloud ASR (nova-3).
//
// The product-friendly cloud ASR: word/utterance timestamps AND speaker
// DIARIZATION in one call, cheap and fast, no local model asset. Covers BOTH the
// single-speaker monologue and the multi-speaker dialogue (where it separates
// voices so each speaker can be cloned), so it can stand in for ElevenLabs Scribe
// without its quota — and unlike OpenAI/Groq Whisper it diarizes.
//
// Contract: transcribe(audioPath,{language,diarize}) -> {text,language,segments:
// [{start,end,text,speaker}], diarizes:true}. `utterances` already gives
// speaker-tagged sentence segments 1:1; we fall back to grouping words if absent.

import { readFile } from 'node:fs/promises';

function wordsToSegments(words, gap = 0.6) {
  const out = [];
  let cur = null;
  for (const w of words) {
    const spk = `speaker_${w.speaker ?? 0}`;
    const text = (w.punctuated_word ?? w.word ?? '').toString();
    const newSpk = cur && cur.speaker !== spk;
    const bigGap = cur && Number(w.start) - cur.end > gap;
    if (cur && (newSpk || bigGap)) { out.push(cur); cur = null; }
    if (!cur) cur = { start: Number(w.start), end: Number(w.end), text: '', speaker: spk };
    cur.text += (cur.text ? ' ' : '') + text;
    cur.end = Number(w.end);
  }
  if (cur) out.push(cur);
  return out;
}

export function makeDeepgramAsr({ apiKey, baseUrl = 'https://api.deepgram.com', model = 'nova-3', timeoutMs = 120000, retries = 2 } = {}) {
  async function transcribe(audioPath, { language = 'en', diarize = true } = {}) {
    if (!apiKey) throw new Error('Deepgram ASR: DEEPGRAM_API_KEY missing');
    const buf = await readFile(audioPath);
    const params = new URLSearchParams({
      model, smart_format: 'true', punctuate: 'true', utterances: 'true',
      diarize: diarize ? 'true' : 'false', language,
    });
    let res, lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const ctrl = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
        res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/listen?${params}`, {
          method: 'POST',
          headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/wav' },
          body: buf, signal: ctrl,
        });
        if (res.status < 500 && res.status !== 429) break; // retry only on 5xx/429
      } catch (e) { lastErr = e; }
    }
    if (!res) throw lastErr || new Error('Deepgram ASR: no response');
    if (!res.ok) throw new Error(`Deepgram ASR HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();

    const utts = j.results?.utterances || [];
    let segments;
    if (utts.length) {
      segments = utts.map((u) => ({
        start: Number(u.start), end: Number(u.end),
        text: String(u.transcript || '').trim(),
        speaker: `speaker_${u.speaker ?? 0}`,
      })).filter((s) => s.text && Number.isFinite(s.start) && s.end > s.start);
    } else {
      const words = j.results?.channels?.[0]?.alternatives?.[0]?.words || [];
      segments = wordsToSegments(words).filter((s) => s.text && s.end > s.start);
    }
    if (!segments.length) throw new Error('Deepgram returned no speech segments');
    const speakers = new Set(segments.map((s) => s.speaker));
    return {
      text: segments.map((s) => s.text).join(' '),
      language: j.results?.channels?.[0]?.detected_language || language,
      segments,
      diarizes: speakers.size > 1,
      raw: { provider: 'deepgram', model, segments: segments.length, speakers: speakers.size },
    };
  }
  return { kind: 'deepgram', transcribe };
}
