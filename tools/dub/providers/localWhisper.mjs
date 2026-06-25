// providers/localWhisper.mjs — local Whisper ASR via `uvx mlx-whisper`.
//
// The most STABLE timestamp source: accurate text AND segment/word timestamps in
// one pass, fully OFFLINE — no API quota, no network, deterministic. Runs on Apple
// Silicon (Metal) through uvx (on-demand, cached — same pattern as demucs), so
// there's nothing to install. Use this whenever ElevenLabs Scribe is unavailable
// (quota) or when you want zero external dependency.
//
// LIMITATION: single-speaker (no diarization). For a multi-speaker DIALOGUE that
// must keep voices apart, use ElevenLabs Scribe (diarize=true). A monologue
// product video — the common case — is fully covered here.

import { run } from '../ffmpeg.mjs';
import { readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';

let _seq = 0; // unique scratch dirs without Date.now (safe under workflows too)

// Re-segment Whisper output at REAL pauses using its word timestamps. Whisper's
// own segments can be coarse (one "segment" = several sentences with internal
// pauses), which makes the dubbed line — spoken without those pauses — finish
// early while the mouth keeps moving. Splitting at word gaps (and sentence ends)
// yields one line per breath group, with accurate boundaries, so the dub tracks
// the speaker. Falls back to Whisper's segments if a model emits no word times.
function resegment(whisperSegments, { gap = 0.45, maxLen = 8, sentenceGap = 0.18 } = {}) {
  const words = [];
  for (const s of whisperSegments || []) {
    for (const w of s.words || []) {
      const t = (w.word ?? w.text ?? '').toString();
      if (t && Number.isFinite(w.start) && Number.isFinite(w.end)) words.push({ t, start: w.start, end: w.end });
    }
  }
  if (words.length < 2) {
    return (whisperSegments || [])
      .map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text || '').trim() }))
      .filter((s) => s.text && s.end > s.start);
  }
  const out = [];
  let cur = null;
  for (const w of words) {
    if (cur) {
      const g = w.start - cur.end;
      const endsSentence = /[.!?。！？…]["')\]]?$/.test(cur.text.trim());
      if (g > gap || (endsSentence && g > sentenceGap) || w.end - cur.start > maxLen) { out.push(cur); cur = null; }
    }
    if (!cur) cur = { start: w.start, end: w.end, text: '' };
    cur.text += w.t;
    cur.end = w.end;
  }
  if (cur) out.push(cur);
  return out.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })).filter((s) => s.text && s.end > s.start);
}

export function makeLocalWhisper({ model = 'mlx-community/whisper-large-v3-turbo', uvx = join(homedir(), '.local/bin/uvx') } = {}) {
  async function transcribe(audioPath, { language = 'en' } = {}) {
    const outDir = join(tmpdir(), `wbdub-whisper-${basename(audioPath)}-${process.pid}-${_seq++}`);
    await mkdir(outDir, { recursive: true });
    try {
      const args = ['--from', 'mlx-whisper', 'mlx_whisper', audioPath,
        '--model', model, '--word-timestamps', 'True',
        '--output-format', 'json', '--output-dir', outDir];
      if (language) args.push('--language', language);
      await run(uvx, args);

      const jf = (await readdir(outDir)).find((f) => f.endsWith('.json'));
      if (!jf) throw new Error('mlx-whisper produced no JSON output');
      const j = JSON.parse(await readFile(join(outDir, jf), 'utf8'));
      // Split coarse Whisper segments at real word-gap pauses (accurate timestamps)
      // so each dub line tracks one breath group instead of finishing early.
      const segments = resegment(j.segments).map((s) => ({ ...s, speaker: 'speaker_0' }));
      if (!segments.length) throw new Error('mlx-whisper returned no speech segments');
      return {
        text: segments.map((s) => s.text).join(' '),
        language: j.language || language,
        segments,
        diarizes: false,
        raw: { provider: 'local-whisper', model, segments: segments.length },
      };
    } finally {
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { kind: 'local-whisper', transcribe };
}
