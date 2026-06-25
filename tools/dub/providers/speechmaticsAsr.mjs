// providers/speechmaticsAsr.mjs — Speechmatics batch ASR + speaker diarization.
//
// Cloud ASR with strong diarization (top-tier on multi-speaker) AND word
// timestamps. Async: submit job -> poll -> fetch json-v2 transcript. The
// transcript is word-level (each result = one word tagged with a speaker like
// "S1"); we group consecutive same-speaker words into sentence segments at pauses
// so the pipeline gets {start,end,text,speaker} with diarization. Single-speaker
// videos simply come back as one speaker.

import { readFile } from 'node:fs/promises';

const BREAK_GAP = 0.6; // a pause longer than this starts a new segment
const MAX_LEN = 9; // cap a segment so one breath group doesn't swallow many sentences

function groupWords(results) {
  const segs = [];
  let cur = null;
  for (const r of results) {
    const alt = r.alternatives && r.alternatives[0];
    if (!alt) continue;
    const isPunct = r.type === 'punctuation';
    const content = (alt.content ?? '').toString();
    if (!content) continue;
    const n = parseInt(String(alt.speaker || 'S1').replace(/\D/g, ''), 10);
    const spk = `speaker_${Number.isFinite(n) ? n - 1 : 0}`;
    const start = Number(r.start_time);
    const end = Number(r.end_time);
    if (cur && !isPunct) {
      const gap = start - cur.end;
      const sentenceEnd = /[.!?…]$/.test(cur.text.trim());
      if (spk !== cur.speaker || gap > BREAK_GAP || (sentenceEnd && gap > 0.15) || end - cur.start > MAX_LEN) {
        segs.push(cur);
        cur = null;
      }
    }
    if (!cur) {
      if (isPunct) continue; // never open a segment on punctuation
      cur = { start, end, text: '', speaker: spk };
    }
    cur.text += isPunct ? content : (cur.text ? ' ' : '') + content;
    if (Number.isFinite(end)) cur.end = end;
  }
  if (cur) segs.push(cur);
  return segs.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text && Number.isFinite(s.start) && s.end > s.start);
}

export function makeSpeechmaticsAsr({ apiKey, baseUrl = 'https://asr.api.speechmatics.com/v2', operatingPoint = 'enhanced', speakerSensitivity = 0.3, pollMs = 3000, maxWaitMs = 300000 } = {}) {
  const base = baseUrl.replace(/\/$/, '');
  async function transcribe(audioPath, { language = 'en', diarize = true } = {}) {
    if (!apiKey) throw new Error('Speechmatics ASR: SPEECHMATICS_API_KEY missing');
    const buf = await readFile(audioPath);
    // LOW speaker_sensitivity biases toward FEWER speakers — critical for cloning:
    // an over-split makes ONE real person sound like two (the drift bug), which is
    // worse than merging two similar voices. 0.3 still separates a genuine second
    // speaker (even a minority child) while folding spurious same-speaker splits back.
    const config = {
      type: 'transcription',
      transcription_config: {
        language, operating_point: operatingPoint,
        ...(diarize ? { diarization: 'speaker', speaker_diarization_config: { speaker_sensitivity: speakerSensitivity } } : {}),
      },
    };
    const fd = new FormData();
    fd.append('config', JSON.stringify(config));
    fd.append('data_file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
    const sub = await fetch(`${base}/jobs/`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: fd });
    if (!sub.ok) throw new Error(`Speechmatics submit HTTP ${sub.status}: ${(await sub.text()).slice(0, 200)}`);
    const id = (await sub.json()).id;
    if (!id) throw new Error('Speechmatics: no job id returned');

    let status, waited = 0;
    while (waited < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollMs));
      waited += pollMs;
      const g = await fetch(`${base}/jobs/${id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!g.ok) continue;
      status = (await g.json()).job?.status;
      if (status === 'done' || status === 'rejected') break;
    }
    if (status !== 'done') throw new Error(`Speechmatics job ${id} not done (status=${status})`);

    const tr = await fetch(`${base}/jobs/${id}/transcript?format=json-v2`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!tr.ok) throw new Error(`Speechmatics transcript HTTP ${tr.status}`);
    const tj = await tr.json();
    const segments = groupWords(tj.results || []);
    if (!segments.length) throw new Error('Speechmatics returned no speech segments');
    const speakers = new Set(segments.map((s) => s.speaker));
    return {
      text: segments.map((s) => s.text).join(' '),
      language: tj.metadata?.transcription_config?.language || language,
      segments,
      diarizes: speakers.size > 1,
      raw: { provider: 'speechmatics', job: id, segments: segments.length, speakers: speakers.size },
    };
  }
  return { kind: 'speechmatics', transcribe };
}
