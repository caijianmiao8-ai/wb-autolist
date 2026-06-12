// pipeline.mjs — orchestrate the full EN->RU dubbing run.
//
// Stages: extract -> ASR -> translate -> per-segment TTS+fit -> assemble -> mux.
// Two modes:
//   'segment' (default): each RU clip is time-fitted to its [start,end] slot and
//      placed at its start time (preserves lip/scene sync, tolerates overlaps).
//   'whole': concat all RU clips, single atempo to the whole video duration
//      (robust fallback when per-segment timing is unreliable).
//
// IMPORTANT: this file talks ONLY to the facades (makeAsr/makeTts) + translate +
// ffmpeg helpers. It has NO knowledge of which provider is active — that is the
// factory's job. Adding/swapping a provider therefore requires ZERO edits here.
//
// --dry-run: skips ALL paid calls (ASR/translate/TTS). ASR is faked from the
// audio duration; translation is identity; TTS synthesizes silent wav clips via
// ffmpeg. Proves extract/fit/assemble/mux wiring end-to-end for free.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { makeAsr } from './asr.mjs';
import { makeTts } from './tts.mjs';
import { pickTranslator } from './factory.mjs';
import { makeFf } from './ffmpeg.mjs';

function now() {
  return Date.now();
}

/** Structured stage logger. Emits {stage, ok, ms, ...}. */
function makeLogger(onEvent) {
  return async function stage(name, fn) {
    const t0 = now();
    try {
      const result = await fn();
      const ev = { stage: name, ok: true, ms: now() - t0 };
      onEvent(ev);
      return result;
    } catch (err) {
      const ev = { stage: name, ok: false, ms: now() - t0, error: err.message };
      onEvent(ev);
      throw err;
    }
  };
}

/**
 * Map each detected speaker to a voice id.
 *  - explicit {speaker_id: voiceId} wins (from --speaker-voices)
 *  - else the DOMINANT speaker (most speech) uses `primaryVoice` (--voice or the
 *    provider default), and every other speaker rotates through `pool` so a
 *    second speaker (e.g. a child) never shares the narrator's voice.
 * Returns { map, ordered } where map[speaker] may be undefined (-> provider default).
 */
function buildSpeakerVoiceMap(segments, { explicit = {}, primaryVoice, pool = [] }) {
  const dur = {};
  for (const s of segments) {
    const k = s.speaker ?? '_';
    dur[k] = (dur[k] || 0) + Math.max((Number(s.end) || 0) - (Number(s.start) || 0), 0);
  }
  const ordered = Object.keys(dur).sort((a, b) => dur[b] - dur[a]);
  const map = {};
  let pi = 0;
  ordered.forEach((spk, idx) => {
    if (explicit[spk]) map[spk] = explicit[spk];
    else if (idx === 0) map[spk] = primaryVoice; // dominant -> primary/--voice/default
    else map[spk] = pool.length ? pool[pi++ % pool.length] : primaryVoice;
  });
  return { map, ordered, dur };
}

/**
 * Merge consecutive SAME-speaker segments separated by a small gap into one
 * synthesis "unit" — fewer TTS calls means less per-call clone drift and more
 * natural prosody. Sync is preserved because units NEVER cross a speaker change
 * or a gap > mergeGap (real pauses), each unit is still time-fit to its own
 * [start,end] span, and a unit is capped at maxUnitSec to bound internal drift.
 * mergeGap<=0 -> no merging (one unit per segment).
 */
function buildUnits(segments, { mergeGap = 0, maxUnitSec = 10 } = {}) {
  if (!(mergeGap > 0)) return segments.map((s) => ({ ...s }));
  const units = [];
  let cur = null;
  for (const s of segments) {
    const spk = s.speaker ?? '_';
    const gap = cur ? Number(s.start) - cur.end : Infinity;
    const wouldExceed = cur ? Number(s.end) - cur.start > maxUnitSec : false;
    if (cur && (cur.speaker ?? '_') === spk && gap >= 0 && gap <= mergeGap && !wouldExceed) {
      cur.text += ' ' + s.text;
      cur.end = Number(s.end);
    } else {
      if (cur) units.push(cur);
      cur = { start: Number(s.start), end: Number(s.end), text: s.text, speaker: s.speaker };
    }
  }
  if (cur) units.push(cur);
  return units;
}

/** Generate a silent wav of given duration (used by dry-run fake TTS). */
async function silentWav(ff, durationSec, outPath) {
  await ff.ffmpeg([
    '-y', '-f', 'lavfi', '-t', String(Math.max(durationSec, 0.1)),
    '-i', 'anullsrc=r=44100:cl=stereo',
    '-ar', '44100', '-ac', '2', outPath,
  ]);
  return outPath;
}

/**
 * Run the dubbing pipeline.
 * @param {object} cfg     resolved config (from loadConfig)
 * @param {object} args
 * @param {string} args.input        path to source video
 * @param {string} args.out          output mp4 path
 * @param {string} args.workDir      per-run scratch dir
 * @param {string} [args.mode]       'segment' | 'whole'
 * @param {boolean}[args.dryRun]
 * @param {object} [args.translate]  {keywords, brand, tone}
 * @param {object} [args.tts]        {voiceId, modelId}
 * @param {number} [args.keepOriginalAudio] duck gain (0..1)
 * @param {function}[args.onEvent]   stage event sink
 */
export async function runPipeline(cfg, args) {
  const {
    input,
    out,
    workDir,
    mode = 'segment',
    dryRun = false,
    translate: tOpts = {},
    tts: ttsOpts = {},
    keepOriginalAudio = 0,
    onEvent = () => {},
  } = args;

  if (!existsSync(input)) throw new Error(`input video not found: ${input}`);
  await mkdir(workDir, { recursive: true });
  const ff = makeFf(cfg);
  const stage = makeLogger(onEvent);
  const events = [];
  const capture = (ev) => {
    events.push(ev);
    onEvent(ev);
  };
  const stageC = makeLogger(capture);

  const wav16k = join(workDir, 'audio_16k.wav');
  const segDir = join(workDir, 'segments');
  await mkdir(segDir, { recursive: true });

  // 1) extract audio + probe video duration
  const { videoDur } = await stageC('extract', async () => {
    const meta = await ff.probeJson(input);
    if (!Array.isArray(meta.streams) || !meta.streams.some((s) => s.codec_type === 'audio')) {
      throw new Error(`input video has no audio track: ${input}`);
    }
    await ff.extractAudio(input, wav16k);
    const videoDur = await ff.probeDuration(input);
    return { videoDur };
  });

  // 2) ASR -> segments
  let asrResult;
  asrResult = await stageC('asr', async () => {
    if (dryRun) {
      // Fake two speakers so the speaker->voice mapping path is exercised free.
      const half = videoDur / 2;
      const segments = [
        { start: 0, end: Math.max(half - 0.05, 0.3), text: 'This is a dry run sample sentence.', speaker: 'speaker_0' },
        { start: half, end: Math.max(videoDur - 0.05, half + 0.3), text: 'No paid API calls were made here.', speaker: 'speaker_1' },
      ];
      return { text: segments.map((s) => s.text).join(' '), language: 'eng', segments, dryRun: true };
    }
    const asr = makeAsr(cfg);
    const r = await asr.transcribe(wav16k, { language: cfg.SRC_LANG, diarize: cfg.DIARIZE });
    // persist raw STT for caching/debug (never re-pay)
    if (r.raw) await writeFile(join(workDir, 'asr_raw.json'), JSON.stringify(r.raw, null, 2));
    return { ...r, provider: asr.provider };
  });
  await writeFile(join(workDir, 'segments_src.json'), JSON.stringify(asrResult.segments, null, 2));

  if (!asrResult.segments.length) throw new Error('ASR produced no segments (silent or non-speech audio?)');

  // 3) translate EN->RU (1:1)
  const ruSegments = await stageC('translate', async () => {
    if (dryRun) {
      // identity translation (no paid call), tag so it's obvious in artifacts
      return asrResult.segments.map((s) => ({ ...s, text: `[RU dry] ${s.text}` }));
    }
    const translator = pickTranslator(cfg);
    // Give each line a character budget = (slot + following pause) * speaking rate,
    // so the RU translation is steered to FIT its time and won't overflow into
    // speed-up/truncation. Concision over completeness for tight lines.
    const rate = cfg.RU_CHARS_PER_SEC || 15;
    const budgeted = asrResult.segments.map((s) => {
      // target ≈ this line's OWN speaking time (mouth movement), so the RU lasts
      // about as long as the speaker talks — not shorter (dub stops early) nor
      // longer (rushed). Pauses between lines are handled separately.
      const span = Math.max(Number(s.end) - Number(s.start), 0.3);
      return { ...s, targetChars: Math.max(Math.round(span * rate), 10) };
    });
    return translator.translate(budgeted, {
      from: cfg.SRC_LANG,
      to: cfg.TARGET_LANG,
      keywords: tOpts.keywords || [],
      brand: tOpts.brand || '',
      tone: tOpts.tone || '',
    });
  });
  await writeFile(join(workDir, 'segments_ru.json'), JSON.stringify(ruSegments, null, 2));

  // speaker -> voice mapping (multi-voice dubbing). With diarization off or a
  // single speaker this collapses to the primary voice for everyone.
  const speakerVoice = buildSpeakerVoiceMap(ruSegments, {
    explicit: ttsOpts.speakerVoices || {},
    primaryVoice: ttsOpts.voiceId,
    pool: cfg.SECONDARY_VOICE_POOL || [],
  });

  // 4) TTS each RU segment (per-speaker voice) + time-fit to its slot
  const tts = dryRun ? null : makeTts(cfg);

  // 4a) Voice cloning (qwen-vc): clone EACH speaker from their own source audio
  // so they keep their real voice while speaking Russian. Speakers with too
  // little clean audio (e.g. a child with a few words) fall back to the dominant
  // speaker's clone so synthesis always has a valid voice.
  let cloneMap = null;
  if (tts && tts.supportsCloning) {
    cloneMap = {};
    await stageC('enroll(clone)', async () => {
      for (const spk of speakerVoice.ordered) {
        const ranges = ruSegments
          .filter((s) => (s.speaker ?? '_') === spk)
          .map((s) => ({ start: s.start, end: s.end }));
        const samplePath = join(workDir, `sample_${String(spk).replace(/[^a-z0-9_]/gi, '')}.mp3`);
        try {
          const used = await ff.extractSpeakerSample(input, ranges, samplePath, { maxDur: cfg.MAX_CLONE_SEC });
          if (used < cfg.MIN_CLONE_SEC) throw new Error(`only ${used.toFixed(1)}s clean audio (< ${cfg.MIN_CLONE_SEC}s min)`);
          cloneMap[spk] = await tts.enroll(samplePath, { name: spk });
        } catch (e) {
          cloneMap[spk] = null;
          capture({ stage: 'enroll(clone)', ok: true, ms: 0, warn: `${spk}: clone skipped — ${e.message}` });
        }
      }
      const dominant = speakerVoice.ordered.find((s) => cloneMap[s]);
      const dominantClone = dominant ? cloneMap[dominant] : null;
      if (!dominantClone) throw new Error('voice cloning failed for every speaker');
      for (const spk of Object.keys(cloneMap)) if (!cloneMap[spk]) cloneMap[spk] = dominantClone;
    });
  }

  // Merge consecutive same-speaker segments into fewer synthesis units (reduces
  // clone drift; sync preserved — see buildUnits). One unit per segment if off.
  const units = buildUnits(ruSegments, { mergeGap: cfg.MERGE_GAP, maxUnitSec: cfg.MAX_UNIT_SEC });

  const fitClips = await stageC('tts+fit', async () => {
    const clips = [];
    for (let i = 0; i < units.length; i++) {
      const seg = units[i];
      // Harden timing: a provider could hand back a non-numeric start/end; never
      // let NaN reach atempo/adelay (which silently corrupts the whole mix).
      const segStart = Number.isFinite(seg.start) ? Math.max(seg.start, 0) : 0;
      const segEnd = Number.isFinite(seg.end) && seg.end > segStart ? seg.end : segStart;
      const nextU = units[i + 1];
      const nextStart = nextU && Number.isFinite(nextU.start) ? Math.max(Number(nextU.start), segEnd) : videoDur;
      const ext = cfg.OUT_FORMAT === 'wav' ? 'wav' : 'mp3';
      const rawClip = join(segDir, `seg${String(i).padStart(3, '0')}_raw.${ext}`);
      const fitClip = join(segDir, `seg${String(i).padStart(3, '0')}_fit.wav`);
      // span = the speaker's actual speech time (mouth movement) for this line;
      // gapTarget extends into the following pause.
      const span = Math.max(segEnd - segStart, 0.3);
      const gapTarget = Math.max(nextStart - segStart, 0.3);

      let srcClip = rawClip;
      let synthDur;
      if (dryRun) {
        // free fake TTS: silent clip ~ same length as the slot so fit is a no-op
        await silentWav(ff, slot, rawClip);
        synthDur = slot;
      } else {
        const r = await tts.synthesize(seg.text, {
          voiceId: (cloneMap && cloneMap[seg.speaker ?? '_']) || speakerVoice.map[seg.speaker ?? '_'] || ttsOpts.voiceId,
          modelId: ttsOpts.modelId,
          language: cfg.TARGET_LANG,
          format: cfg.OUT_FORMAT,
          outPath: rawClip,
        });
        synthDur = r.durationSec; // from with-timestamps if available
        // Loudness-normalize so every clip sits at the same level (kills the
        // per-call drift that makes a cloned voice sound like several people).
        if (cfg.NORMALIZE) {
          const normClip = join(segDir, `seg${String(i).padStart(3, '0')}_norm.wav`);
          await ff.normalizeLoudness(rawClip, normClip);
          srcClip = normClip;
          synthDur = undefined; // loudnorm re-encodes; let fit re-probe duration
        }
      }

      // Hybrid target: by default fill the speaker's SPAN (dub lasts ~as long as
      // the mouth moves). Only if the line is too long to fit even at max speed-up
      // do we borrow the following pause (up to gapTarget) — gently compress
      // instead of chopping the sentence end.
      const rawDur = synthDur != null ? synthDur : await ff.probeDuration(srcClip);
      let target = span;
      if (rawDur / span > cfg.FIT_MAX_SPEEDUP) target = Math.min(gapTarget, rawDur / cfg.FIT_MAX_SPEEDUP);
      const fit = await ff.fitAudioToDuration(srcClip, fitClip, target, {
        srcDur: rawDur,
        maxSpeedup: cfg.FIT_MAX_SPEEDUP,
        minSlowdown: cfg.FIT_MIN_SLOWDOWN, // stretch short lines to fill the mouth time
        padShort: true,
      });
      clips.push({ path: fitClip, start: segStart, end: segEnd, factor: fit.factor, capped: fit.capped });
    }
    return clips;
  });

  // 5) assemble + mux
  const dubTrack = join(workDir, 'dub_track.wav');
  if (mode === 'whole') {
    await stageC('assemble(whole)', async () => {
      const concat = join(workDir, 'dub_concat.wav');
      await ff.concatAudio(fitClips.map((c) => c.path), concat);
      const concatDur = await ff.probeDuration(concat);
      // single atempo chain to the whole video duration, pad/trim to exact.
      await ff.fitAudioToDuration(concat, dubTrack, videoDur, { srcDur: concatDur, maxSpeedup: 100, minSlowdown: 0.5 });
    });
  } else {
    await stageC('assemble(segment)', async () => {
      await ff.assembleTimeline(fitClips, videoDur, dubTrack);
    });
  }

  await stageC('mux', async () => {
    await ff.muxReplaceAudio(input, dubTrack, out, { keepOriginal: keepOriginalAudio });
  });

  // 6) correctness gate: output duration within ~150ms of source video
  const { outDur, drift } = await stageC('verify', async () => {
    const outDur = await ff.probeDuration(out);
    const drift = Math.abs(outDur - videoDur);
    if (drift > 0.15) {
      // Warn but don't hard-fail — -shortest can legitimately clip a few frames.
      capture({ stage: 'verify', ok: true, ms: 0, warn: `duration drift ${drift.toFixed(3)}s (out ${outDur.toFixed(3)} vs src ${videoDur.toFixed(3)})` });
    }
    return { outDur, drift };
  });

  return {
    out,
    workDir,
    videoDur,
    outDur,
    drift,
    mode,
    dryRun,
    segments: ruSegments.length,
    units: units.length,
    speakers: speakerVoice.ordered,
    speakerVoiceMap: cloneMap || speakerVoice.map,
    cloned: !!cloneMap,
    asrProvider: dryRun ? 'dry-run' : asrResult.provider,
    ttsProvider: dryRun ? 'dry-run' : tts.provider,
    clips: fitClips.map((c) => ({ start: c.start, end: c.end, factor: Number(c.factor?.toFixed(3)), capped: c.capped })),
    events,
  };
}
