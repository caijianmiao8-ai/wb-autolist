// providers/dashscopeAsr.mjs — DashScope (Qwen) ASR, no ElevenLabs dependency.
//
// qwen3-asr-flash transcribes with excellent quality but returns ONLY text — no
// timestamps and no speaker diarization. The dub pipeline needs per-segment
// timestamps (to place each line on the timeline). We get them locally:
//   1. VAD (ffmpeg silencedetect) splits the audio into speech spans at pauses.
//   2. Each span is transcribed by qwen3-asr-flash (base64 inline — no file hosting).
//   3. A long span is split into sentences and given timestamps proportional to
//      each sentence's length, so timing stays sentence-grained without cutting
//      audio mid-word.
//
// LIMITATION: single-speaker only (no diarization). Perfect for the common
// monologue product video; a multi-speaker dialogue still needs ElevenLabs Scribe
// (diarize=true) to separate voices. Surfaced via `diarizes: false`.

import { readFile, unlink } from 'node:fs/promises';
import { makeFf } from '../ffmpeg.mjs';

const SENTENCE_SPLIT = /(?<=[.!?。！？…])\s+/;

export function makeDashscopeAsr({ apiKey, baseUrl = 'https://dashscope.aliyuncs.com', model = 'qwen3-asr-flash', maxSpanSec = 9, vadThreshold = '-32dB', vadMinSil = 0.4 } = {}) {
  const ff = makeFf();
  const endpoint = `${baseUrl.replace(/\/$/, '')}/api/v1/services/aigc/multimodal-generation/generation`;

  async function asrClip(wavPath, language) {
    const b64 = 'data:audio/wav;base64,' + (await readFile(wavPath)).toString('base64');
    const body = {
      model,
      input: { messages: [{ role: 'system', content: [{ text: '' }] }, { role: 'user', content: [{ audio: b64 }] }] },
      parameters: { asr_options: { language, enable_lid: true, enable_itn: true } },
    };
    const r = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`DashScope ASR HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return (j?.output?.choices?.[0]?.message?.content?.[0]?.text || '').trim();
  }

  // Invert silence intervals into speech spans, then split spans that are too long
  // so no single unit swallows many sentences (keeps timing sentence-grained).
  async function speechSpans(audioPath) {
    const total = await ff.probeDuration(audioPath);
    const sil = await ff.detectSilence(audioPath, { threshold: vadThreshold, minDur: vadMinSil });
    const raw = [];
    let cur = 0;
    for (const [s, e] of sil) { if (s - cur > 0.25) raw.push([cur, s]); cur = Math.max(cur, e); }
    if (total - cur > 0.25) raw.push([cur, total]);
    return raw.length ? raw : [[0, total]];
  }

  async function transcribe(audioPath, { language = 'en' } = {}) {
    const spans = await speechSpans(audioPath);
    const segments = [];
    for (const [s, e] of spans) {
      const clip = `${audioPath}.asr_${s.toFixed(2)}.wav`;
      await ff.ffmpeg(['-y', '-ss', String(s), '-to', String(e), '-i', audioPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', clip]);
      let text = '';
      try { text = await asrClip(clip, language); } catch { /* drop unintelligible span */ }
      await unlink(clip).catch(() => {});
      if (!text) continue;
      const dur = e - s;
      // Split a long span into sentences and distribute timestamps by char length
      // (speaking rate is ~uniform within a span, so this tracks the real timing).
      const sentences = dur > maxSpanSec ? text.split(SENTENCE_SPLIT).map((t) => t.trim()).filter(Boolean) : [text];
      const totalChars = sentences.reduce((n, t) => n + t.length, 0) || 1;
      let t0 = s;
      for (const sent of sentences) {
        const frac = sent.length / totalChars;
        const t1 = sentences.length === 1 ? e : Math.min(e, t0 + dur * frac);
        if (t1 - t0 > 0.05) segments.push({ start: Number(t0.toFixed(3)), end: Number(t1.toFixed(3)), text: sent, speaker: 'speaker_0' });
        t0 = t1;
      }
    }
    return {
      text: segments.map((x) => x.text).join(' '),
      language,
      segments,
      diarizes: false, // single-speaker only
      raw: { provider: 'dashscope', model, spans: spans.length, segments: segments.length },
    };
  }

  return { kind: 'dashscope', transcribe };
}
