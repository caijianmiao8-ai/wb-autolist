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
import { existsSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { run as runBin } from './ffmpeg.mjs';
const __dir = dirname(fileURLToPath(import.meta.url));

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
function buildUnits(segments, { mergeGap = 0, maxUnitSec = 10, minUnitSec = 0.8 } = {}) {
  const units = [];
  let cur = null;
  for (const s of segments) {
    const spk = s.speaker ?? '_';
    const gap = cur ? Number(s.start) - cur.end : Infinity;
    const curDur = cur ? cur.end - cur.start : 0;
    const wouldExceed = cur ? Number(s.end) - cur.start > maxUnitSec : false;
    // Grow the unit when same speaker AND (small gap OR the unit is still a tiny
    // fragment that must not be synthesized alone). minUnitSec is the fragment
    // guard: a half-word like "It's"/"Go" keeps absorbing the next bit until the
    // unit is a complete, speakable phrase — kills truncated-fragment artifacts.
    const sameSpk = cur && (cur.speaker ?? '_') === spk;
    const grow = sameSpk && !wouldExceed && gap >= 0 && (gap <= mergeGap || curDur < minUnitSec);
    if (grow) {
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

/**
 * Auto-pick a CLEAN, SINGLE-CONDITION clone reference for one speaker.
 *
 * The trap (why a naive "longest clean run" fails): a product video often mixes a
 * clean POST-PRODUCTION narration with LIVE on-location speech that has room tone.
 * The two conditions are different timbres. If the enrollment clip spans BOTH, the
 * clone learns a blend and renders the speaker as "two different people". Scoring a
 * long run by its AVERAGE background hides this — one clean stretch drags the mean
 * down and a 27s mixed clip wins.
 *
 * Fix: seed at the speaker's single CLEANEST segment (lowest background = the pure
 * post/studio condition), then grow ONLY into time-adjacent segments whose
 * background is within `noiseTol` dB of the seed — i.e. the SAME recording
 * condition. Stop at the first segment that's audibly noisier (the condition
 * boundary). This yields a short, homogeneous, single-condition reference on any
 * video, no hardcoded timestamps. Falls back to the longest run when there's no
 * background stem to score against. Returns [{start,end}] for the VOCALS stem.
 */
async function selectCleanReference(segs, { bgPath, ff, minSec = 4, maxSec = 12, gapMerge = 1.0, noiseTol = 12 }) {
  const s = segs.map((r) => ({ s: Number(r.start), e: Number(r.end) }))
    .filter((r) => Number.isFinite(r.s) && Number.isFinite(r.e) && r.e > r.s)
    .sort((a, b) => a.s - b.s);
  if (!s.length) return [];
  const runs = [];
  let cur = { s: s[0].s, e: s[0].e };
  for (let i = 1; i < s.length; i++) {
    if (s[i].s - cur.e <= gapMerge) cur.e = Math.max(cur.e, s[i].e);
    else { runs.push(cur); cur = { s: s[i].s, e: s[i].e }; }
  }
  runs.push(cur);
  const longest = runs.slice().sort((a, b) => b.e - b.s - (a.e - a.s))[0];
  const longestRef = () => [{ start: longest.s, end: Math.min(longest.e, longest.s + maxSec) }];
  if (!bgPath || !ff) return longestRef();

  // SLIDE a fine window WITHIN the speaker's runs to find the cleanest stretch —
  // crucially INDEPENDENT of ASR segment boundaries. (A coarse ASR segment that
  // straddles the post→live boundary averages the two and BURIES the clean spot;
  // scoring per-segment then picks a noisier "live" window and the clone sounds
  // contaminated. Sliding finds the clean window no matter how the ASR chunked it,
  // so the reference is stable across ASR providers.)
  const W = Math.min(Math.max(minSec, 6), maxSec); // scan window length
  const STEP = 1.0;
  let best = null, bestBg = Infinity;
  for (const run of runs) {
    const runLen = run.e - run.s;
    if (runLen < minSec) continue;
    const w = Math.min(W, runLen);
    for (let t = run.s; t <= run.e - w + 0.01; t += STEP) {
      const bg = await ff.meanRms(bgPath, t, t + w);
      if (bg < bestBg) { bestBg = bg; best = { s: t, e: t + w, run }; }
    }
  }
  if (!best) return longestRef();

  // Grow the window within the SAME run while the added audio stays in the same
  // condition (background within noiseTol of the clean seed), up to maxSec.
  const thresh = bestBg + noiseTol;
  let lo = best.s, hi = best.e;
  while (hi - lo < maxSec) {
    const canL = lo - STEP >= best.run.s;
    const canR = hi + STEP <= best.run.e;
    const bgL = canL ? await ff.meanRms(bgPath, lo - STEP, lo) : Infinity;
    const bgR = canR ? await ff.meanRms(bgPath, hi, hi + STEP) : Infinity;
    if (canL && bgL <= thresh && (!canR || bgL <= bgR)) lo -= STEP;
    else if (canR && bgR <= thresh) hi += STEP;
    else break;
  }
  const start = lo, end = Math.min(hi, lo + maxSec);
  return end - start >= minSec ? [{ start, end }] : longestRef();
}

/** Subtract `spans` (protected ranges) from each [s,e] in `intervals`. */
function subtractSpans(intervals, spans) {
  const out = [];
  for (const [s0, e0] of intervals) {
    let pieces = [[s0, e0]];
    for (const [ps, pe] of spans) {
      const next = [];
      for (const [a, b] of pieces) {
        if (pe <= a || ps >= b) { next.push([a, b]); continue; }
        if (ps > a) next.push([a, Math.min(ps, b)]);
        if (pe < b) next.push([Math.max(pe, a), b]);
      }
      pieces = next;
    }
    for (const [a, b] of pieces) if (b - a > 0.05) out.push([a, b]);
  }
  return out;
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

  // 1b) Separate stems ONCE (Demucs): vocals (clean speech, for clone references)
  // + background (M&E, for the final mix). Run early so cloning uses clean vocals.
  // Graceful: on any failure, fall back to no-background + cloning from raw audio.
  let bgPath = null, vocalsPath = null;
  const needStems = !dryRun && (cfg.KEEP_BACKGROUND || (makeTts(cfg).supportsCloning));
  if (needStems) {
    await stageC('separate', async () => {
      try {
        const stems = await ff.separateBackground(input, workDir, { uvx: cfg.DEMUCS_UVX });
        bgPath = cfg.KEEP_BACKGROUND ? stems.background : null;
        vocalsPath = stems.vocals;
      } catch (e) {
        capture({ stage: 'separate', ok: true, ms: 0, warn: `stem separation skipped (${e.message}) — raw audio + no background` });
      }
    });
  }

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
    // ASR cache: the transcript only depends on the INPUT video, so re-runs (we
    // iterate on translation/voice/timing constantly) must never re-pay Scribe or
    // be blocked by its quota. Key on the video's size+mtime so editing the file
    // invalidates it. Cache holds the full result (segments + speaker labels).
    let cachePath = null;
    if (cfg.ASR_CACHE !== false) {
      try {
        const st = statSync(input);
        // Include provider + diarization-relevant config so changing the model or
        // speaker sensitivity invalidates the cache (otherwise a stale transcript
        // with the old speaker split would be reused).
        const cfgTag = [cfg.ASR_PROVIDER, cfg.DIARIZE ? 'd' : 'n', cfg.SPEECHMATICS_OPERATING_POINT, cfg.SPEECHMATICS_SPEAKER_SENSITIVITY, cfg.DEEPGRAM_MODEL, cfg.WHISPER_MODEL]
          .map((x) => String(x ?? '').replace(/[^a-z0-9.]/gi, '')).join('-');
        cachePath = join(homedir(), '.cache', 'wb-dub', 'asr', `${basename(input)}-${st.size}-${Math.round(st.mtimeMs)}-${cfgTag}.json`);
        if (existsSync(cachePath)) {
          const cached = JSON.parse(await readFile(cachePath, 'utf8'));
          if (cached?.segments?.length) {
            capture({ stage: 'asr', ok: true, ms: 0, warn: `reused cached transcript (${cached.segments.length} segs) — no Scribe call` });
            return { ...cached, cached: true };
          }
        }
      } catch { cachePath = null; }
    }
    const asr = makeAsr(cfg);
    const r = await asr.transcribe(wav16k, { language: cfg.SRC_LANG, diarize: cfg.DIARIZE });
    // persist raw STT for caching/debug (never re-pay)
    if (r.raw) await writeFile(join(workDir, 'asr_raw.json'), JSON.stringify(r.raw, null, 2));
    const result = { ...r, provider: asr.provider };
    if (cachePath) {
      try { await mkdir(join(homedir(), '.cache', 'wb-dub', 'asr'), { recursive: true }); await writeFile(cachePath, JSON.stringify(result, null, 2)); } catch { /* cache is best-effort */ }
    }
    return result;
  });

  if (!asrResult.segments.length) throw new Error('ASR produced no segments (silent or non-speech audio?)');

  const translator = dryRun ? null : pickTranslator(cfg); // reused by diarize-refine + the isochrony loop

  // 2b) Context-aware diarization fix: acoustic diarization can't separate
  // overlapping voices (a mother and child answering each other are inseparable by
  // pitch AND speaker embedding — measured), but the DIALOGUE makes who-said-what
  // clear. gpt-5.5 reassigns mislabeled lines from conversational turn-taking. No-op
  // for a single speaker. This is what makes a mislabeled line stop being voiced as
  // the wrong person (e.g. the mother's answer rendered in the child's clone).
  if (cfg.DIARIZE_REFINE && translator && translator.refineSpeakers && new Set(asrResult.segments.map((s) => s.speaker ?? '_')).size > 1) {
    await stageC('diarize-refine', async () => {
      // Measure each line's source pitch so gpt-5.5 can combine PITCH with context
      // (a low-pitch line is never the child; an excited adult can spike high).
      for (const s of asrResult.segments) {
        if (Number(s.end) - Number(s.start) < 0.4) continue;
        const tmp = join(segDir, `f0_${Math.round(Number(s.start) * 1000)}.wav`);
        try {
          await ff.ffmpeg(['-y', '-ss', String(s.start), '-to', String(s.end), '-i', wav16k, '-ac', '1', '-ar', '16000', tmp]);
          s.f0 = await ff.estimateF0(tmp);
        } catch { /* leave f0 undefined */ }
      }
      const before = asrResult.segments.map((s) => s.speaker);
      asrResult.segments = await translator.refineSpeakers(asrResult.segments, { language: cfg.SRC_LANG });
      for (const s of asrResult.segments) delete s.f0; // don't leak the hint downstream
      const changed = asrResult.segments.filter((s, i) => s.speaker !== before[i]).length;
      if (changed) capture({ stage: 'diarize-refine', ok: true, ms: 0, warn: `gpt-5.5 corrected ${changed} speaker label(s) from pitch+context` });
      return changed;
    });
  }
  await writeFile(join(workDir, 'segments_src.json'), JSON.stringify(asrResult.segments, null, 2));

  // 3) translate EN->RU (1:1)
  const ruSegments = await stageC('translate', async () => {
    if (dryRun) {
      // identity translation (no paid call), tag so it's obvious in artifacts
      return asrResult.segments.map((s) => ({ ...s, text: `[RU dry] ${s.text}` }));
    }
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
  const refF0 = {}; // each speaker's TRUE pitch (from their clean reference) — the
  // stable anchor for pitch normalization, so per-call clone drift can't make two
  // speakers' voices converge ("mother sounds like the child").
  const refSample = {}; // each speaker's reference clip path (for voice-select embedding)
  if (tts && tts.supportsCloning) {
    cloneMap = {};
    await stageC('enroll(clone)', async () => {
      // clone from the CLEAN vocals stem when available (no background/foley
      // contamination), else fall back to the raw audio.
      const cloneSrc = vocalsPath || input;
      for (const spk of speakerVoice.ordered) {
        const segs = ruSegments.filter((s) => (s.speaker ?? '_') === spk);
        const samplePath = join(workDir, `sample_${String(spk).replace(/[^a-z0-9_]/gi, '')}.mp3`);
        try {
          // auto-pick the cleanest single-condition reference for THIS speaker
          // (works on any video — no hardcoded timestamps).
          const ranges = await selectCleanReference(segs, { bgPath, ff, minSec: cfg.MIN_CLONE_SEC, maxSec: cfg.MAX_CLONE_SEC, noiseTol: cfg.CLONE_NOISE_TOL, gapMerge: cfg.CLONE_REF_GAP });
          const used = await ff.extractSpeakerSample(cloneSrc, ranges, samplePath, { maxDur: cfg.MAX_CLONE_SEC });
          if (used < cfg.MIN_CLONE_SEC) throw new Error(`only ${used.toFixed(1)}s clean audio (< ${cfg.MIN_CLONE_SEC}s min)`);
          const rng = ranges[0];
          if (cfg.PITCH_NORMALIZE) refF0[spk] = await ff.estimateF0(samplePath).catch(() => null); // true pitch of this speaker
          refSample[spk] = samplePath; // reference clip for voice-select embedding
          if (rng) capture({ stage: 'enroll(clone)', ok: true, ms: 0, warn: `${spk}: ref window [${rng.start.toFixed(1)}-${rng.end.toFixed(1)}]s (${used.toFixed(1)}s, single-condition)${refF0[spk] ? `, f0≈${Math.round(refF0[spk])}Hz` : ''}` });
          cloneMap[spk] = await tts.enroll(samplePath, { name: spk });
        } catch (e) {
          cloneMap[spk] = null;
          capture({ stage: 'enroll(clone)', ok: true, ms: 0, warn: `${spk}: clone skipped — ${e.message}` });
        }
      }
      // Speakers we couldn't clone get a DISTINCT preset voice (not the dominant
      // speaker's clone) so two speakers in a dialogue never collapse into one
      // voice. The qwen-vc synth routes a preset NAME to the preset model.
      // Qwen3-tts preset voices (valid names for the preset model) — distinct
      // fallbacks for speakers without enough clean audio to clone.
      const presetPool = cfg.QWEN_FALLBACK_VOICES;
      let pi = 0;
      for (const spk of speakerVoice.ordered) {
        if (!cloneMap[spk]) {
          cloneMap[spk] = presetPool[pi % presetPool.length];
          pi++;
          capture({ stage: 'enroll(clone)', ok: true, ms: 0, warn: `${spk}: using distinct preset voice "${cloneMap[spk]}" (couldn't clone)` });
        }
      }
    });
  }

  // Merge consecutive same-speaker segments into fewer synthesis units (reduces
  // clone drift; sync preserved — see buildUnits). One unit per segment if off.
  const units = buildUnits(ruSegments, { mergeGap: cfg.MERGE_GAP, maxUnitSec: cfg.MAX_UNIT_SEC, minUnitSec: cfg.MIN_UNIT_SEC });

  const fitClips = await stageC('tts+fit', async () => {
    const id3 = (i) => String(i).padStart(3, '0');
    const ext = cfg.OUT_FORMAT === 'wav' ? 'wav' : 'mp3';
    const medianOf = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
    const synth = (text, voiceId, outPath) => tts.synthesize(text, { voiceId, modelId: ttsOpts.modelId, language: cfg.TARGET_LANG, format: cfg.OUT_FORMAT, outPath });
    const measure = async (rec) => { rec.rawDur = await ff.probeDuration(rec.rawClip); if (cfg.PITCH_NORMALIZE) rec.f0 = await ff.estimateF0(rec.rawClip).catch(() => null); };

    // --- Pass A: synthesize every unit once; measure duration, pitch, length ---
    // Everything up front so we can compute each speaker's REAL speaking rate and
    // median pitch before correcting either — you can't normalize toward a target
    // you haven't measured yet.
    const recs = [];
    for (let i = 0; i < units.length; i++) {
      const seg = units[i];
      // Harden timing: a provider could hand back a non-numeric start/end; never
      // let NaN reach atempo/adelay (which silently corrupts the whole mix).
      const segStart = Number.isFinite(seg.start) ? Math.max(seg.start, 0) : 0;
      const segEnd = Number.isFinite(seg.end) && seg.end > segStart ? seg.end : segStart;
      const nextU = units[i + 1];
      const nextStart = nextU && Number.isFinite(nextU.start) ? Math.max(Number(nextU.start), segEnd) : videoDur;
      const rawClip = join(segDir, `seg${id3(i)}_raw.${ext}`);
      const span = Math.max(segEnd - segStart, 0.3); // original on-screen speech time
      const gapTarget = Math.max(nextStart - segStart, 0.3); // span + following pause
      const speaker = seg.speaker ?? '_';
      const voiceId = (cloneMap && cloneMap[speaker]) || speakerVoice.map[speaker] || ttsOpts.voiceId;

      const rec = { i, segStart, segEnd, span, gapTarget, rawClip, f0: null, speaker, voiceId, text: seg.text, chars: (seg.text || '').length };
      if (dryRun) {
        await silentWav(ff, span, rawClip);
        rec.rawDur = span;
      } else {
        const r = await synth(seg.text, voiceId, rawClip);
        rec.rawDur = r.durationSec != null ? r.durationSec : await ff.probeDuration(rawClip);
        if (cfg.PITCH_NORMALIZE) rec.f0 = await ff.estimateF0(rawClip).catch(() => null);
      }
      recs.push(rec);
    }

    // Measured speaking rate (chars/sec) per speaker — adapts the isochrony budget
    // to THIS cloned voice/language instead of a fixed guess (works on any video).
    const rate = {};
    {
      const bySpk = {};
      for (const r of recs) if (r.rawDur > 0.3 && r.chars > 0) (bySpk[r.speaker] ||= []).push(r.chars / r.rawDur);
      for (const [spk, a] of Object.entries(bySpk)) rate[spk] = medianOf(a) || cfg.RU_CHARS_PER_SEC;
    }

    // --- Isochrony: a line whose spoken duration still overruns its span gets
    // CONDENSED (re-translated shorter, meaning preserved) and re-synthesized, so
    // the end-aligned fit below needs only an inaudible nudge — not a rushed
    // speed-up. Short interjections (span < ISO_MIN_SPAN) are left alone; they
    // borrow the following pause instead of being stripped of meaning.
    if (cfg.ISO_LOOP && !dryRun && translator && translator.condense) {
      const to = { to: cfg.TARGET_LANG, keywords: tOpts.keywords || [], brand: tOpts.brand || '', tone: tOpts.tone || '' };
      let condensed = 0, expanded = 0;
      for (const rec of recs) {
        const r = rate[rec.speaker] || cfg.RU_CHARS_PER_SEC;
        for (let t = 0; t < cfg.ISO_MAX_RETRY; t++) {
          // Over-long → condense toward the span; under-short → expand to fill it.
          // Both target the span at the speaker's MEASURED rate, so the dub matches
          // the on-screen speaking time regardless of the voice's pace.
          if (rec.rawDur > rec.span * cfg.ISO_TOL && rec.span >= cfg.ISO_MIN_SPAN) {
            // floor of 4 chars (a short word like "Да") so a tiny interjection slot
            // can actually be hit — a higher floor would block condensing it and the
            // line would overflow onto the next turn.
            const targetChars = Math.max(4, Math.floor(rec.span * r * cfg.ISO_TOL));
            if (targetChars >= rec.chars * 0.95) break;
            const shorter = await translator.condense(rec.text, targetChars, to);
            if (!shorter || shorter.length >= rec.text.length) break;
            await synth(shorter, rec.voiceId, rec.rawClip);
            rec.text = shorter; rec.chars = shorter.length; await measure(rec);
            condensed++;
          } else if (rec.rawDur < rec.span * cfg.ISO_LOW && rec.span >= cfg.ISO_MIN_SPAN) {
            const targetChars = Math.floor(rec.span * r * cfg.ISO_FILL);
            if (targetChars <= rec.chars * 1.05) break; // already near the span — leave it
            const longer = await translator.expand(rec.text, targetChars, to);
            if (!longer || longer.length <= rec.text.length) break;
            await synth(longer, rec.voiceId, rec.rawClip);
            rec.text = longer; rec.chars = longer.length; await measure(rec);
            expanded++;
          } else break;
        }
      }
      if (condensed || expanded) capture({ stage: 'iso-fit', ok: true, ms: 0, warn: `length-matched ${condensed} long + ${expanded} short line(s) to the original timing` });
    }

    // --- Voice-select: Qwen renders the same voice randomly differently each call.
    // For each CLONED line, synth K candidates and KEEP the one whose voice is
    // closest to the speaker's reference (speaker-embedding similarity + pitch, via
    // resemblyzer/uvx). This is what makes a SINGLE run reliably consistent instead
    // of a lottery — it picks the good render rather than hoping for one. Replaces
    // the pitch-only re-roll (it already optimizes pitch + timbre together).
    if (cfg.VOICE_SELECT && !dryRun && Object.keys(refSample).length) {
      const K = Math.max(2, cfg.RENDER_CANDIDATES);
      const manifest = { refs: {}, refF0: {}, units: [] };
      for (const [spk, p] of Object.entries(refSample)) { manifest.refs[spk] = p; if (refF0[spk]) manifest.refF0[spk] = refF0[spk]; }
      for (const rec of recs) {
        if (!refSample[rec.speaker]) continue; // preset-voiced (no clone ref) — keep its single render
        const cands = [];
        for (let k = 0; k < K; k++) {
          const cp = join(segDir, `seg${id3(rec.i)}_c${k}.${ext}`);
          try { await synth(rec.text, rec.voiceId, cp); } catch { continue; }
          const f = await ff.estimateF0(cp).catch(() => null);
          cands.push({ path: cp, f0: f || 0 });
        }
        if (cands.length) manifest.units.push({ i: rec.i, speaker: rec.speaker, candidates: cands });
      }
      if (manifest.units.length) {
        const mPath = join(segDir, 'voiceselect.json');
        const oPath = join(segDir, 'voiceselect_out.json');
        await writeFile(mPath, JSON.stringify(manifest));
        try {
          await runBin(join(homedir(), '.local/bin/uvx'), ['--with', 'resemblyzer', '--with', 'numpy<2', 'python', join(__dir, 'voiceselect.py'), mPath, oPath]);
          const best = JSON.parse(await readFile(oPath, 'utf8')).best || {};
          let n = 0;
          for (const rec of recs) {
            const b = best[String(rec.i)];
            if (b && existsSync(b)) { rec.rawClip = b; rec.f0 = await ff.estimateF0(b).catch(() => rec.f0); rec.rawDur = await ff.probeDuration(b); n++; }
          }
          capture({ stage: 'voice-select', ok: true, ms: 0, warn: `kept best-of-${K} render for ${n} cloned line(s) by voice similarity` });
        } catch (e) {
          capture({ stage: 'voice-select', ok: true, ms: 0, warn: `voice-select skipped (${String(e.message).slice(0, 80)}) — using single renders` });
        }
      }
    }

    // --- Pitch re-roll: fallback when voice-select is OFF — re-synthesize pitch
    // outliers toward the speaker median (pitch only; voice-select supersedes this).
    if (cfg.PITCH_NORMALIZE && cfg.PITCH_REROLL && !cfg.VOICE_SELECT && !dryRun) {
      let rerolled = 0;
      const prov = {};
      { const bySpk = {}; for (const r of recs) if (r.f0) (bySpk[r.speaker] ||= []).push(r.f0); for (const [s, a] of Object.entries(bySpk)) if (a.length >= 2) prov[s] = medianOf(a); }
      for (const rec of recs) {
        // Anchor to the speaker's TRUE pitch (from their reference) so re-rolls pull
        // toward the real voice — keeps two speakers distinct even as Qwen drifts.
        const tgt = refF0[rec.speaker] || prov[rec.speaker];
        if (!tgt || !rec.f0) continue;
        let bestDev = Math.abs(rec.f0 / tgt - 1);
        for (let t = 1; t <= cfg.PITCH_REROLL_MAX && bestDev > cfg.PITCH_REROLL_THRESH; t++) {
          const alt = join(segDir, `seg${id3(rec.i)}_try${t}.${ext}`);
          try { await synth(rec.text, rec.voiceId, alt); } catch { break; }
          const f = await ff.estimateF0(alt).catch(() => null);
          if (!f) continue;
          const dev = Math.abs(f / tgt - 1);
          if (dev < bestDev) { rec.rawClip = alt; rec.f0 = f; rec.rawDur = await ff.probeDuration(alt); bestDev = dev; rerolled++; }
        }
      }
      if (rerolled) capture({ stage: 'pitch-reroll', ok: true, ms: 0, warn: `re-synthesized ${rerolled} pitch-drift outlier(s) toward speaker median` });
    }

    // Per-speaker target pitch: the speaker's TRUE reference pitch when known (a
    // STABLE anchor — clone-drift can't make two voices converge), else the clone
    // clips' own median.
    const targetF0 = {};
    { const bySpk = {}; for (const r of recs) if (r.f0) (bySpk[r.speaker] ||= []).push(r.f0);
      for (const s of new Set(recs.map((r) => r.speaker))) {
        if (refF0[s]) targetF0[s] = refF0[s];
        else if ((bySpk[s] || []).length >= 2) targetF0[s] = medianOf(bySpk[s]);
      } }

    // --- Pass B: pitch-normalize → level → END-ALIGNED time-fit ---
    const clips = [];
    for (const rec of recs) {
      const { i, segStart, segEnd, span, gapTarget, rawClip, speaker } = rec;
      const fitClip = join(segDir, `seg${id3(i)}_fit.wav`);
      let srcClip = rawClip;
      let knownDur = rec.rawDur;

      // 1) Pitch: pull this clip toward the speaker's median (residual small shift;
      // big outliers were already re-rolled). Clamped to avoid a chipmunk artifact.
      const tgt = targetF0[speaker];
      if (tgt && rec.f0) {
        const factor = Math.max(1 - cfg.PITCH_MAX_SHIFT, Math.min(1 + cfg.PITCH_MAX_SHIFT, tgt / rec.f0));
        if (Math.abs(factor - 1) >= 0.005) {
          const pitchClip = join(segDir, `seg${id3(i)}_pitch.wav`);
          await ff.pitchShift(rawClip, pitchClip, factor);
          srcClip = pitchClip;
          knownDur = undefined; // pitchShift preserves duration but re-encodes — re-probe
        }
      }

      // 2) Level: single-gain RMS leveling so every clip sits at the same loudness
      // (the level half of the per-call drift), preserving within-clip dynamics.
      if (!dryRun && cfg.NORMALIZE) {
        const normClip = join(segDir, `seg${id3(i)}_norm.wav`);
        await ff.normalizeLoudness(srcClip, normClip, { mode: cfg.NORMALIZE_MODE, targetDb: cfg.NORM_TARGET_DB });
        srcClip = normClip;
        knownDur = undefined;
      }

      // 3) END-ALIGNED fit: the dub occupies the original speech window
      // [segStart, segEnd], so it starts AND ends with the mouth (tight timeline).
      // The isochrony loop kept RU short enough that compressing to the span is a
      // small, inaudible nudge. Only a line still too long even at the gentle cap
      // borrows the following pause; a short line plays natural and ends a touch
      // early (the M&E background fills the rest — never silence-over-a-moving-mouth).
      const rawDur = knownDur != null ? knownDur : await ff.probeDuration(srcClip);
      // Interjections (short slot) tolerate a faster delivery so they fit a tight
      // dialogue window without spilling onto the next line; sentences stay gentle.
      const cap = span < cfg.FIT_SHORT_SPAN ? cfg.FIT_MAX_SPEEDUP_SHORT : cfg.FIT_MAX_SPEEDUP;
      let target = span;
      if (rawDur / span > cap) target = Math.min(gapTarget, rawDur / cap);
      const fit = await ff.fitAudioToDuration(srcClip, fitClip, target, {
        srcDur: rawDur,
        maxSpeedup: cap,
        minSlowdown: cfg.FIT_MIN_SLOWDOWN,
        padShort: false,
        fillShort: true, // gently slow a short line so it covers the mouth (no silent gap over a moving mouth)
      });
      const dur = rawDur / (fit.factor || 1); // actual clip length (handles cap/compress/natural)
      clips.push({ path: fitClip, start: segStart, end: segEnd, dur, factor: fit.factor, capped: fit.capped, speaker });
    }
    return clips;
  });

  // 4c) Speaker-aware elastic placement: clips start at their intended time, but a
  // clip overflowing onto the next is handled by WHO is talking. Two clips of the
  // SAME speaker overlapping = one voice over itself = garble → nudge the later one
  // (small tol). Two DIFFERENT speakers overlapping = distinct voices = a natural
  // dialogue interruption → allow generously, so an interjection rides over the
  // neighbour rather than being sped up out of character or delayed. Slack resets
  // at the next real pause (when the intended start is already past prevEnd).
  let prevEnd = 0;
  let prevSpk = null;
  for (const c of fitClips) {
    const s = Number(c.start) || 0;
    const tol = prevSpk != null && c.speaker !== prevSpk ? cfg.OVERLAP_TOL_CROSS : cfg.OVERLAP_TOL;
    c.placed = cfg.ELASTIC_PLACEMENT ? Math.max(s, prevEnd - tol) : s;
    prevEnd = c.placed + (Number(c.dur) || 0);
    prevSpk = c.speaker;
  }
  const placedClips = fitClips.map((c) => ({ path: c.path, start: c.placed }));

  // 5) assemble + mux
  const dubTrack = join(workDir, 'dub_track.wav');
  if (mode === 'whole') {
    await stageC('assemble(whole)', async () => {
      const concat = join(workDir, 'dub_concat.wav');
      await ff.concatAudio(placedClips.map((c) => c.path), concat);
      const concatDur = await ff.probeDuration(concat);
      // single atempo chain to the whole video duration, pad/trim to exact.
      await ff.fitAudioToDuration(concat, dubTrack, videoDur, { srcDur: concatDur, maxSpeedup: 100, minSlowdown: 0.5 });
    });
  } else {
    await stageC('assemble(segment)', async () => {
      await ff.assembleTimeline(placedClips, videoDur, dubTrack);
    });
  }

  // 5b) Gate the dub to the original's speech: mute it wherever the source was
  // silent, so it never plays over a silent mouth (no dub during pauses).
  let muxTrack = dubTrack;
  if (cfg.GATE_SILENCE && !dryRun) {
    await stageC('gate-silence', async () => {
      const sil = await ff.detectSilence(wav16k, { threshold: cfg.GATE_THRESH, minDur: cfg.GATE_MIN_SEC });
      // Protect the dub's ACTUAL (elastically-placed) extents — never mute a region
      // where a clip is really playing, even if it was nudged into what was an
      // original silent gap. Muting inside a line would chop it into stutters.
      const spans = fitClips.map((c) => [c.placed, c.placed + (Number(c.dur) || 0)]).filter(([a, b]) => b > a);
      const gateIv = subtractSpans(sil, spans);
      const gated = join(workDir, 'dub_gated.wav');
      await ff.gateSilence(dubTrack, gateIv, gated);
      muxTrack = gated;
      capture({ stage: 'gate-silence', ok: true, ms: 0, warn: `muted dub in ${gateIv.length} inter-sentence gaps (of ${sil.length} silent spans)` });
    });
  }

  // 5c) Mix the dub over the M&E background separated up front (bgPath) — keeps
  // the soundscape (clinks/sprays/ambient) instead of a bare voice over silence.
  await stageC('mux', async () => {
    await ff.muxReplaceAudio(input, muxTrack, out, { keepOriginal: keepOriginalAudio, background: bgPath, bgVolume: cfg.BG_VOLUME, duck: cfg.BG_DUCK });
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
