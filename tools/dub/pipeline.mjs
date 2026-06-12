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
      // Fake a couple of evenly-spaced English segments from the duration.
      const half = videoDur / 2;
      const segments = [
        { start: 0, end: Math.max(half - 0.05, 0.3), text: 'This is a dry run sample sentence.' },
        { start: half, end: Math.max(videoDur - 0.05, half + 0.3), text: 'No paid API calls were made here.' },
      ];
      return { text: segments.map((s) => s.text).join(' '), language: 'eng', segments, dryRun: true };
    }
    const asr = makeAsr(cfg);
    const r = await asr.transcribe(wav16k, { language: cfg.SRC_LANG });
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
    return translator.translate(asrResult.segments, {
      from: cfg.SRC_LANG,
      to: cfg.TARGET_LANG,
      keywords: tOpts.keywords || [],
      brand: tOpts.brand || '',
      tone: tOpts.tone || '',
    });
  });
  await writeFile(join(workDir, 'segments_ru.json'), JSON.stringify(ruSegments, null, 2));

  // 4) TTS each RU segment + time-fit to its slot
  const tts = dryRun ? null : makeTts(cfg);
  const fitClips = await stageC('tts+fit', async () => {
    const clips = [];
    for (let i = 0; i < ruSegments.length; i++) {
      const seg = ruSegments[i];
      // Harden timing: a provider could hand back a non-numeric start/end; never
      // let NaN reach atempo/adelay (which silently corrupts the whole mix).
      const segStart = Number.isFinite(seg.start) ? Math.max(seg.start, 0) : 0;
      const segEnd = Number.isFinite(seg.end) && seg.end > segStart ? seg.end : segStart;
      const rawClip = join(segDir, `seg${String(i).padStart(3, '0')}_raw.${cfg.OUT_FORMAT === 'wav' ? 'wav' : 'mp3'}`);
      const fitClip = join(segDir, `seg${String(i).padStart(3, '0')}_fit.wav`);
      const slot = Math.max(segEnd - segStart, 0.3);

      let synthDur;
      if (dryRun) {
        // free fake TTS: silent clip ~ same length as the slot so fit is a no-op
        await silentWav(ff, slot, rawClip);
        synthDur = slot;
      } else {
        const r = await tts.synthesize(seg.text, {
          voiceId: ttsOpts.voiceId,
          modelId: ttsOpts.modelId,
          language: cfg.TARGET_LANG,
          format: cfg.OUT_FORMAT,
          outPath: rawClip,
        });
        synthDur = r.durationSec; // from with-timestamps if available
      }

      const fit = await ff.fitAudioToDuration(rawClip, fitClip, slot, {
        srcDur: synthDur, // skip ffprobe when provider gave us the duration
        maxSpeedup: 1.5,
        minSlowdown: 0.85,
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
    asrProvider: dryRun ? 'dry-run' : asrResult.provider,
    ttsProvider: dryRun ? 'dry-run' : tts.provider,
    clips: fitClips.map((c) => ({ start: c.start, end: c.end, factor: Number(c.factor?.toFixed(3)), capped: c.capped })),
    events,
  };
}
