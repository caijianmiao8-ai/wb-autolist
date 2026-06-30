// config.mjs — environment loading + provider/key/base/model resolution.
//
// Loads /Users/ruo/claude-test/WILDBERRIES/.env.local (a tiny built-in .env
// parser — no npm deps) and merges it under process.env (process.env WINS).
//
// SECURITY: this module reads secret keys (AURIXEL_API_KEY, ELEVENLABS_API_KEY)
// but NEVER logs them. Do not console.log the returned config blindly — use
// redactedConfig() for any debug printing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
// repo root is two levels up from tools/dub/
const REPO_ROOT = resolve(__dirname, '..', '..');
const DEFAULT_ENV_PATH = join(REPO_ROOT, '.env.local');

// Friendly name -> ElevenLabs premade voice id (the 21 the restricted key sees).
// Lets users (and --speaker-voices) say `sarah` instead of an opaque id.
export const VOICE_ALIASES = {
  // female (RU-capable via multilingual_v2)
  sarah: 'EXAVITQu4vr4xnSDxMaL', laura: 'FGY2WhTYpPnrIDTdsKH5', jessica: 'cgSgspJ2msm6clMCkdW9',
  alice: 'Xb7hH8MSUJpSbSDYk0k2', matilda: 'XrExE9yKIg1WjnnlVkGX', bella: 'hpp4J3VqNfWAUOO0d1Us',
  lily: 'pFZP5JQG7iQjIQuC4Bku',
  // male
  george: 'JBFqnCBsd6RMkjVDRZzb', brian: 'nPczCjzI2devNBz1zQrb', eric: 'cjVigY5qzO86Huf0OWal',
  will: 'bIHbv24MWmeRgasZH58o', roger: 'CwhRBWXzGAHq8TQ4Fs17', charlie: 'IKne3meq5aSn9XLyUdCD',
  daniel: 'onwK4e9ZLuTAKqWW03F9', liam: 'TX3LPaxmHKxFdv7VOQHJ', chris: 'iP95p4xoKVk53GoZ742B',
};

/** Resolve a voice name or raw id to an id. Unknown strings pass through (assumed id). */
export const resolveVoice = (s) => (s == null ? s : VOICE_ALIASES[String(s).trim().toLowerCase()] || String(s).trim());

/** Parse "speaker_0=sarah,speaker_1=jessica" -> { speaker_0: '<id>', speaker_1: '<id>' }. */
export function parseSpeakerVoices(str) {
  const map = {};
  if (!str || str === true) return map;
  for (const pair of String(str).split(',')) {
    const [k, v] = pair.split('=').map((x) => (x || '').trim());
    if (k && v) map[k] = resolveVoice(v);
  }
  return map;
}

/** Minimal .env parser. Supports KEY=VALUE, # comments, quotes, blank lines. */
export function parseEnvFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {}; // missing file is fine; process.env may carry everything
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    // strip surrounding single or double quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Build the resolved config.
 * @param {object} [opts]
 * @param {string} [opts.envPath]  override .env.local path
 * @param {object} [opts.overrides] CLI-supplied overrides (highest priority)
 */
export function loadConfig(opts = {}) {
  const envPath = opts.envPath || process.env.DUB_ENV_PATH || DEFAULT_ENV_PATH;
  const fileEnv = parseEnvFile(envPath);
  const ov = opts.overrides || {};

  // Resolution order: CLI override > process.env > .env.local file > default
  const env = (k, d) => {
    if (ov[k] !== undefined && ov[k] !== null && ov[k] !== '') return ov[k];
    if (process.env[k] !== undefined && process.env[k] !== '') return process.env[k];
    if (fileEnv[k] !== undefined && fileEnv[k] !== '') return fileEnv[k];
    return d;
  };

  // these providers return WAV from synthesis → intermediate clips must be .wav
  const ttsProvider = String(env('TTS_PROVIDER', 'qwen-vc')).toLowerCase();
  const wavTts = ttsProvider === 'qwen-vc' || ttsProvider === 'qwen' || ttsProvider === 'cosyvoice-vc'
    || ttsProvider === 'aurixel-vc' || ttsProvider === 'aurixel';

  const cfg = {
    envPath,

    // --- Secrets (never log) ---
    AURIXEL_API_KEY: env('AURIXEL_API_KEY'),
    ELEVENLABS_API_KEY: env('ELEVENLABS_API_KEY'),

    // --- Provider selection ---
    ASR_PROVIDER: String(env('ASR_PROVIDER', 'speechmatics')).toLowerCase(),
    TTS_PROVIDER: ttsProvider,

    // --- Languages ---
    SRC_LANG: env('SRC_LANG', 'en'),
    TARGET_LANG: env('TARGET_LANG', 'ru'),

    // --- Translation (Aurixel chat) ---
    TRANSLATE_MODEL: env('TRANSLATE_MODEL') || env('AURIXEL_CHAT_MODEL', 'gpt-5.5'),
    AURIXEL_BASE: env('AURIXEL_BASE', 'https://conduit-api.aurixel.ai/v1'),

    // --- ElevenLabs tuning ---
    EL_BASE: env('EL_BASE', 'https://api.elevenlabs.io'),
    // per-side base overrides fall back to EL_BASE if unset
    EL_ASR_BASE: env('EL_ASR_BASE') || env('EL_BASE', 'https://api.elevenlabs.io'),
    EL_TTS_BASE: env('EL_TTS_BASE') || env('EL_BASE', 'https://api.elevenlabs.io'),
    EL_ASR_MODEL: env('EL_ASR_MODEL', 'scribe_v1'),
    EL_TTS_MODEL: env('EL_TTS_MODEL', 'eleven_multilingual_v2'),
    // George — warm storyteller, RU-capable via multilingual_v2 (verified default)
    EL_VOICE_ID: env('EL_VOICE_ID', 'JBFqnCBsd6RMkjVDRZzb'),
    EL_OUTPUT_FORMAT: env('EL_OUTPUT_FORMAT', 'mp3_44100_128'),

    // --- Speaker-aware dubbing (multi-voice) ---
    // diarize: ElevenLabs Scribe tags each word with speaker_id so each speaker
    // gets a distinct voice. Single-speaker videos collapse to one voice anyway.
    // (Aurixel/Whisper ASR has no diarization — segments fall back to one voice.)
    DIARIZE: String(env('DIARIZE', 'true')).toLowerCase() !== 'false',
    // Cache the ASR transcript per input video (size+mtime keyed) under
    // ~/.cache/wb-dub/asr — re-runs never re-pay Scribe or hit its quota.
    ASR_CACHE: String(env('ASR_CACHE', 'true')).toLowerCase() !== 'false',
    // After acoustic diarization, let gpt-5.5 CORRECT per-line speaker labels using
    // conversational context (turn-taking, who-addresses-whom). Fixes the cases
    // where overlapping voices (parent/child) are acoustically inseparable. No-op
    // for single-speaker. See translate.refineSpeakers.
    DIARIZE_REFINE: String(env('DIARIZE_REFINE', 'true')).toLowerCase() !== 'false',
    // explicit map, e.g. "speaker_0=sarah,speaker_1=jessica" (names or ids).
    SPEAKER_VOICES: parseSpeakerVoices(env('SPEAKER_VOICES')),
    // dominant speaker uses EL_VOICE_ID/--voice; extra speakers rotate this pool.
    SECONDARY_VOICE_POOL: String(env('SECONDARY_VOICE_POOL', 'jessica,brian,laura,eric'))
      .split(',').map((s) => resolveVoice(s)).filter(Boolean),

    // --- Consistency post-processing ---
    // loudness-normalize each clip (flattens per-call level drift, esp. qwen-vc).
    NORMALIZE: String(env('NORMALIZE', 'true')).toLowerCase() !== 'false',
    // 'rms' = level each clip with a single gain to a target RMS (fixes clone
    // level-drift but PRESERVES each clip's natural dynamics — sounds natural).
    // 'loudnorm' = EBU R128 (also compresses within a clip → flatter/robotic).
    NORMALIZE_MODE: env('NORMALIZE_MODE', 'rms'),
    NORM_TARGET_DB: Number(env('NORM_TARGET_DB', '-20')),
    // PITCH normalize each speaker's clips to their own median f0 — fixes clone
    // PITCH drift (qwen-vc renders the same voice 5-10% higher/lower across calls,
    // heard as "two different people"). Each clip is shifted (duration preserved)
    // toward the speaker's median, clamped to ±PITCH_MAX_SHIFT to avoid artifacts.
    // Voice-select: Qwen TTS-VC renders the same voice randomly differently each
    // call. Generate K candidates per cloned line and KEEP the one whose voice is
    // closest to the speaker's reference (speaker-embedding similarity + pitch),
    // turning that per-call randomness into reliable, consistent output in a SINGLE
    // run (the tool normally runs once). Needs resemblyzer via uvx.
    VOICE_SELECT: String(env('VOICE_SELECT', 'true')).toLowerCase() !== 'false',
    RENDER_CANDIDATES: Number(env('RENDER_CANDIDATES', '4')),
    // Parallel TTS synthesis lanes (tts+fit is ~60-80% of wall time and was serial).
    // Bounded to respect the gateway rate limit; lower if you hit 429s, raise if the
    // gateway tolerates it. 6 ≈ halved the 93s-video runtime in testing.
    TTS_CONCURRENCY: Number(env('TTS_CONCURRENCY', '6')),
    PITCH_NORMALIZE: String(env('PITCH_NORMALIZE', 'true')).toLowerCase() !== 'false',
    PITCH_MAX_SHIFT: Number(env('PITCH_MAX_SHIFT', '0.10')), // a bit wider so a drifted clone can be pulled back to its TRUE reference pitch (keeps speakers distinct)
    // Re-roll: a clip whose pitch lands > PITCH_REROLL_THRESH off the speaker's
    // median is RE-SYNTHESIZED (up to N times, keep the closest). DSP can only
    // shift ±PITCH_MAX_SHIFT cleanly; a wild outlier (e.g. drifted +30%) needs a
    // fresh render, not a chipmunk stretch. Re-roll first, DSP fine-tunes the rest.
    PITCH_REROLL: String(env('PITCH_REROLL', 'true')).toLowerCase() !== 'false',
    PITCH_REROLL_THRESH: Number(env('PITCH_REROLL_THRESH', '0.08')),
    PITCH_REROLL_MAX: Number(env('PITCH_REROLL_MAX', '3')),
    // merge consecutive same-speaker segments with a gap <= this many seconds into
    // ONE synthesis call (fewer calls -> less clone drift, more natural prosody).
    // 0 = off (one call per segment). 0.35 (default) re-joins only truly continuous
    // fragments the ASR split mid-utterance (better prosody, no internal pause →
    // no early-stop); 0.8+ merges across short pauses (looser timing).
    MERGE_GAP: Number(env('MERGE_GAP', '0.35')),
    // cap a merged unit's span so internal sync drift stays bounded.
    MAX_UNIT_SEC: Number(env('MAX_UNIT_SEC', '10')),
    // fragment guard: a unit shorter than this keeps absorbing the next same-speaker
    // segment until it's a complete, speakable phrase (no half-word artifacts).
    MIN_UNIT_SEC: Number(env('MIN_UNIT_SEC', '0.8')),
    // length-budgeted translation: target RU speaking rate (chars incl. spaces per
    // second). The translator is told to keep each line within its slot+gap budget
    // so it doesn't overflow and get sped-up/truncated. Lower = shorter RU.
    // chars the TTS actually speaks per second — used to size each line so the RU
    // lasts ~as long as the speaker talks. Tuned to qwen3-tts (~11–12). Raise for
    // faster engines. Too high → RU too long (rushed); too low → ends early.
    RU_CHARS_PER_SEC: Number(env('RU_CHARS_PER_SEC', '12')), // initial budget only; the iso loop re-fits to each voice's MEASURED rate
    // Fit strategy:
    //  FIT_USE_GAP=false (default): fit each line to the speaker's SPEECH SPAN and
    //    fill it (the dub lasts ~as long as the mouth moves — best for lip timing).
    //  true: fit to span+following pause, keep short lines at natural speed (can end
    //    before the mouth stops). Two-way gentle stretch keeps it natural either way.
    FIT_USE_GAP: String(env('FIT_USE_GAP', 'false')).toLowerCase() === 'true',
    // UNIFORM, low compression is the key to ONE consistent voice: variable speed-up
    // (some lines natural, some 1.7×) makes a cloned speaker sound like two people
    // even at identical pitch. Cap everything at a gentle, inaudible 1.12× — the
    // isochrony loop keeps RU short enough that long lines land here naturally, and
    // interjections that don't fit overflow into a cross-speaker overlap (below)
    // rather than being sped up out of character.
    FIT_MAX_SPEEDUP: Number(env('FIT_MAX_SPEEDUP', '1.12')),
    FIT_MIN_SLOWDOWN: Number(env('FIT_MIN_SLOWDOWN', '0.9')), // stretch short lines down to this (subtle; rest is a natural pause)
    // Interjections use the SAME gentle cap (no special fast delivery) — voice
    // consistency beats fitting a tiny slot exactly. Kept as a knob, defaulted equal.
    FIT_SHORT_SPAN: Number(env('FIT_SHORT_SPAN', '1.6')),
    FIT_MAX_SPEEDUP_SHORT: Number(env('FIT_MAX_SPEEDUP_SHORT', '1.12')),
    // --- Isochrony loop: make each RU line's SPOKEN duration ≈ the original
    // speaker's on-screen time, so end-aligned fit needs only an inaudible nudge
    // (not a rushed speed-up). After the first synth we measure the speaker's REAL
    // chars/sec, then CONDENSE (re-translate shorter) any line that would still run
    // > ISO_TOL × its span, and re-synthesize. Adapts to any voice/video.
    ISO_LOOP: String(env('ISO_LOOP', 'true')).toLowerCase() !== 'false',
    ISO_TOL: Number(env('ISO_TOL', '1.10')), // allowed overrun before condensing (10% ≈ inaudible tempo nudge; matches the fit cap so long lines compress uniformly)
    // Bidirectional: a line whose speech finishes well before the speaker stops
    // (< ISO_LOW × span) gets EXPANDED (re-translated longer) so the dub fills the
    // on-screen time at a normal pace instead of ending early. The real speaking
    // rate is voice-dependent, so this — driven by the MEASURED rate — is what makes
    // length-matching work across any video, not a fixed chars/sec guess.
    ISO_LOW: Number(env('ISO_LOW', '0.90')), // expand any line that fills < 90% of its span — the dub must cover the mouth (no "mouth moves, no voice")
    ISO_FILL: Number(env('ISO_FILL', '0.95')), // expand target = this fraction of the span (fill most of it, end a touch early — never overflow)
    ISO_MIN_SPAN: Number(env('ISO_MIN_SPAN', '1.0')), // condense even short interjections to fit their OWN slot — keeps each line on the original timeline (no push/overlap into the next turn)
    ISO_MAX_RETRY: Number(env('ISO_MAX_RETRY', '2')),
    // Gate the dub to the original's speech: mute the dub wherever the source was
    // silent for >= GATE_MIN_SEC, so it never plays over a silent mouth.
    // Elastic placement nudges a clip later so it never overlaps the previous one
    // (slack absorbed by the next pause). ON by default as the no-garble backstop:
    // after end-aligned fit + adaptive interjection compression, only a degenerate
    // zero-span ASR fragment can still overflow, and a >OVERLAP_TOL collision of two
    // dub voices is worse than a sub-300ms nudge. OVERLAP_TOL still allows a brief,
    // natural-sounding dialogue overlap before nudging.
    ELASTIC_PLACEMENT: String(env('ELASTIC_PLACEMENT', 'true')).toLowerCase() !== 'false',
    // Overlap tolerance before nudging. SAME speaker overlapping = one voice over
    // itself = garble → nudge early (small tol). DIFFERENT speakers overlapping =
    // two distinct voices = natural dialogue interruption → allow generously, so a
    // long interjection rides over the neighbour instead of being sped up or
    // delayed (preserves both voice consistency AND timing).
    OVERLAP_TOL: Number(env('OVERLAP_TOL', '0.12')), // same-speaker
    // Different-speaker: a SMALL overlap reads as a natural interruption, but a big
    // one (a whole long interjection riding over the next turn) is two voices
    // shouting at once. Keep it brief; the overflow nudges the next turn later
    // (absorbed by the following pause) instead of garbling.
    OVERLAP_TOL_CROSS: Number(env('OVERLAP_TOL_CROSS', '1.5')),
    GATE_SILENCE: String(env('GATE_SILENCE', 'true')).toLowerCase() !== 'false',
    GATE_THRESH: env('GATE_THRESH', '-30dB'),
    GATE_MIN_SEC: Number(env('GATE_MIN_SEC', '0.5')),
    // Preserve the original soundscape: Demucs-separate the background (music &
    // effects — foley/ambient/noise) and mix the dub OVER it, instead of dropping
    // a bare voice onto silence. Needs uvx+demucs (auto-installed on first run).
    KEEP_BACKGROUND: String(env('KEEP_BACKGROUND', 'true')).toLowerCase() !== 'false',
    // Master switch for Demucs stem separation. false → skip Demucs entirely (no
    // uvx/torch download): clone enrolls from raw audio and there's no background
    // M&E. The app's "快速/标准" presets set this off so only "高质量" pays for Demucs.
    USE_STEMS: String(env('USE_STEMS', 'true')).toLowerCase() !== 'false',
    // Burn the Russian translation into the video as hardsubs (WB feed autoplays
    // muted → subtitles keep the pitch legible). Free (reuses ruSegments); costs one
    // video re-encode. Default on; the app toggles it per-dub via SUBTITLES.
    SUBTITLES: String(env('SUBTITLES', 'true')).toLowerCase() !== 'false',
    SUBTITLE_FONT_SIZE: Number(env('SUBTITLE_FONT_SIZE', '18')),
    // Stall watchdog for the uvx steps (Demucs/voice-select): if the first-run
    // model download (or processing) emits NO output for this long, kill it and
    // degrade gracefully instead of hanging the dub. Generous — a moving download
    // keeps resetting it; only a true stall trips it.
    STEP_IDLE_MS: Number(env('STEP_IDLE_MS', '300000')),
    BG_VOLUME: Number(env('BG_VOLUME', '0.8')), // background gain under the dub
    // duck the background ~6 dB while the dub speaks (sidechain) — measured to
    // raise voice clarity; returns in pauses. --no-duck to disable.
    BG_DUCK: String(env('BG_DUCK', 'true')).toLowerCase() !== 'false',
    DEMUCS_UVX: env('DEMUCS_UVX') || join(homedir(), '.local/bin/uvx'),

    // --- Qwen / DashScope TTS voice cloning (qwen3-tts-vc) ---
    QWEN_API_KEY: env('QWEN_API_KEY'),
    QWEN_TTS_BASE: env('QWEN_TTS_BASE', 'https://dashscope.aliyuncs.com'), // Beijing key
    QWEN_TTS_VC_MODEL: env('QWEN_TTS_VC_MODEL', 'qwen3-tts-vc-2026-01-22'),
    // CosyVoice v3.5 cloning (TTS_PROVIDER=cosyvoice-vc) — deterministic, no drift.
    COSYVOICE_MODEL: env('COSYVOICE_MODEL', 'cosyvoice-v3.5-plus'),
    COSYVOICE_SAMPLE_RATE: Number(env('COSYVOICE_SAMPLE_RATE', '24000')),
    COSYVOICE_RATE: Number(env('COSYVOICE_RATE', '1.9')), // speed up CosyVoice's slow RU to ~natural so it fits the slot
    QWEN_ENROLL_MODEL: env('QWEN_ENROLL_MODEL', 'qwen-voice-enrollment'),
    // Qwen3-ASR (ASR_PROVIDER=dashscope): VAD timestamps + qwen3-asr-flash text,
    // no ElevenLabs quota. Single-speaker (no diarization).
    QWEN_ASR_MODEL: env('QWEN_ASR_MODEL', 'qwen3-asr-flash'),
    // Local Whisper (ASR_PROVIDER=whisper): mlx model id, accurate offline
    // text+timestamps. -turbo is the best speed/accuracy on Apple Silicon; use
    // whisper-small-mlx for a faster, smaller download.
    WHISPER_MODEL: env('WHISPER_MODEL', 'mlx-community/whisper-large-v3-turbo'),
    // Deepgram (ASR_PROVIDER=deepgram): cloud ASR with timestamps + diarization.
    DEEPGRAM_API_KEY: env('DEEPGRAM_API_KEY'),
    DEEPGRAM_BASE: env('DEEPGRAM_BASE', 'https://api.deepgram.com'),
    DEEPGRAM_MODEL: env('DEEPGRAM_MODEL', 'nova-3'),
    // Speechmatics (ASR_PROVIDER=speechmatics, the DEFAULT): cloud ASR with strong
    // speaker diarization + word timestamps; one provider for mono- and multi-speaker.
    SPEECHMATICS_API_KEY: env('SPEECHMATICS_API_KEY'),
    SPEECHMATICS_BASE: env('SPEECHMATICS_BASE', 'https://asr.api.speechmatics.com/v2'),
    SPEECHMATICS_OPERATING_POINT: env('SPEECHMATICS_OPERATING_POINT', 'enhanced'),
    // Lower = fewer speakers. 0.3 folds spurious same-speaker splits back (so one
    // person isn't cloned as two voices) while still isolating a real 2nd speaker.
    SPEECHMATICS_SPEAKER_SENSITIVITY: Number(env('SPEECHMATICS_SPEAKER_SENSITIVITY', '0.3')),
    // preset-voice TTS (TTS_PROVIDER=qwen): stable locked voices, no cloning
    QWEN_TTS_MODEL: env('QWEN_TTS_MODEL', 'qwen3-tts-flash'),
    QWEN_VOICE: env('QWEN_VOICE', 'Cherry'),
    // distinct preset voices for speakers that can't be cloned (keeps dialogue
    // speakers apart instead of collapsing them into the dominant clone).
    QWEN_FALLBACK_VOICES: String(env('QWEN_FALLBACK_VOICES', 'Chelsie,Serena,Ethan,Dylan,Katerina'))
      .split(',').map((s) => s.trim()).filter(Boolean),
    // An un-clonable speaker whose TOTAL speech is < this fraction of the dominant
    // speaker's is treated as MINOR (a mis-split artifact or a trivial interjection)
    // and FOLDED into the dominant's cloned voice — so a single-narrator product
    // video keeps ONE consistent voice instead of a jarring random preset voice.
    // A SUBSTANTIAL second speaker (≥ this fraction) still gets a distinct preset so
    // a real two-person dialogue never collapses into one voice. 0 = never fold.
    CLONE_FOLD_RATIO: Number(env('CLONE_FOLD_RATIO', '0.35')),
    // per-speaker cloning: only clone speakers with at least this many seconds of
    // clean source audio; shorter speakers fall back to a premade/static voice.
    // clone a speaker from as little as this many seconds of clean audio — keeping
    // a minor speaker (e.g. a child with ~2 s) in THEIR OWN voice beats a generic
    // preset. Below this they fall back to a distinct preset voice.
    MIN_CLONE_SEC: Number(env('MIN_CLONE_SEC', '2')),
    // Cap the clone reference SHORT: a long window almost always spans more than one
    // recording condition (post + live), which makes the clone sound like two people.
    // 6-12s of clean, single-condition audio is the sweet spot for qwen-vc.
    MAX_CLONE_SEC: Number(env('MAX_CLONE_SEC', '12')),
    // A segment whose background is within this many dB of the cleanest one counts
    // as the SAME recording condition when growing the homogeneous clone window.
    CLONE_NOISE_TOL: Number(env('CLONE_NOISE_TOL', '12')),
    // Tight gap when building the clone reference: don't bridge across a real pause
    // into a DIFFERENT speaker's word (e.g. a child's question + the mother's answer
    // that diarization lumped together) — that contaminates the reference and the
    // clone comes out as the wrong person. 0.6s keeps the reference within one
    // continuous utterance.
    CLONE_REF_GAP: Number(env('CLONE_REF_GAP', '0.6')),

    // --- Aurixel gateway audio (ASR_PROVIDER=aurixel, TTS_PROVIDER=aurixel-vc|aurixel) ---
    // OpenAI-compatible production gateway (AURIXEL_BASE): ONE AURIXEL_API_KEY does
    // chat-translate + ASR + TTS+cloning. LIVE-VERIFIED on conduit-api.aurixel.ai.
    // ASR: verbose_json passes through Speechmatics word/segment timestamps +
    // diarization; honors speaker_sensitivity. Use a speechmatics-* model (deepgram
    // via the gateway is still text-only). VC: qwen3-tts-vc clone (enroll+synth).
    AURIXEL_ASR_MODEL: env('AURIXEL_ASR_MODEL', 'speechmatics-enhanced'),
    // The gateway honors `speaker_sensitivity` (low = fewer speakers, folds the
    // over-split). Defaults to the same 0.3 as direct Speechmatics.
    AURIXEL_SPEAKER_SENSITIVITY: Number(env('AURIXEL_SPEAKER_SENSITIVITY', env('SPEECHMATICS_SPEAKER_SENSITIVITY', '0.3'))),
    AURIXEL_TTS_VC_MODEL: env('AURIXEL_TTS_VC_MODEL', 'qwen3-tts-vc'),
    AURIXEL_TTS_MODEL: env('AURIXEL_TTS_MODEL', 'qwen-tts'),
    AURIXEL_VOICE: env('AURIXEL_VOICE', 'Cherry'),

    // --- ffmpeg / pipeline ---
    FFMPEG_PATH: env('FFMPEG_PATH') || join(homedir(), '.local/bin/ffmpeg'),
    FFPROBE_PATH: env('FFPROBE_PATH') || join(homedir(), '.local/bin/ffprobe'),
    OUT_FORMAT: env('OUT_FORMAT', wavTts ? 'wav' : 'mp3'), // intermediate TTS audio format (wav for qwen-vc/qwen/cosyvoice-vc/aurixel-vc/aurixel)

    // --- Network ---
    HTTP_TIMEOUT_MS: Number(env('HTTP_TIMEOUT_MS', '120000')),
    HTTP_RETRIES: Number(env('HTTP_RETRIES', '2')),
    // ASR legitimately needs a longer budget than chat/TTS (a long video's
    // transcription can exceed 120s). Kept separate so the factory's net override
    // can't silently downgrade it to HTTP_TIMEOUT_MS.
    ASR_TIMEOUT_MS: Number(env('ASR_TIMEOUT_MS', '300000')),

    // --- Work dir ---
    WORK_ROOT: env('WORK_ROOT') || join(homedir(), '.cache', 'wb-dub'),
  };

  return cfg;
}

/** Return a copy of cfg safe to print (ALL secret-named values masked). */
export function redactedConfig(cfg) {
  const mask = (v) => (v ? `set(${String(v).slice(0, 3)}…len${String(v).length})` : '<unset>');
  // Mask any value whose KEY NAME looks like a credential, so adding a new
  // provider key never silently leaks under DUB_DEBUG (a hardcoded allow-list once
  // masked only AURIXEL/EL, exposing QWEN/DEEPGRAM/SPEECHMATICS in plaintext).
  const isSecret = (k) => /(_KEY|_TOKEN|_SECRET|_PASSWORD)$/i.test(k) || /^(API_KEY|TOKEN|SECRET)$/i.test(k);
  const out = { ...cfg };
  for (const k of Object.keys(out)) {
    if (isSecret(k) && typeof out[k] === 'string' && out[k]) out[k] = mask(out[k]);
  }
  return out;
}

/** Throw a clear error if a required secret for the selected providers is missing. */
export function assertSecrets(cfg, { needAsr = true, needTts = true, needTranslate = true } = {}) {
  const missing = [];
  if (needTranslate && !cfg.AURIXEL_API_KEY) missing.push('AURIXEL_API_KEY (translation)');
  if (needAsr && cfg.ASR_PROVIDER === 'elevenlabs' && !cfg.ELEVENLABS_API_KEY)
    missing.push('ELEVENLABS_API_KEY (ASR_PROVIDER=elevenlabs)');
  if (needAsr && cfg.ASR_PROVIDER === 'aurixel' && !cfg.AURIXEL_API_KEY)
    missing.push('AURIXEL_API_KEY (ASR_PROVIDER=aurixel)');
  if (needAsr && (cfg.ASR_PROVIDER === 'dashscope' || cfg.ASR_PROVIDER === 'qwen') && !cfg.QWEN_API_KEY)
    missing.push(`QWEN_API_KEY (ASR_PROVIDER=${cfg.ASR_PROVIDER})`);
  if (needAsr && cfg.ASR_PROVIDER === 'deepgram' && !cfg.DEEPGRAM_API_KEY)
    missing.push('DEEPGRAM_API_KEY (ASR_PROVIDER=deepgram)');
  if (needAsr && cfg.ASR_PROVIDER === 'speechmatics' && !cfg.SPEECHMATICS_API_KEY)
    missing.push('SPEECHMATICS_API_KEY (ASR_PROVIDER=speechmatics)');
  if (needTts && cfg.TTS_PROVIDER === 'elevenlabs' && !cfg.ELEVENLABS_API_KEY)
    missing.push('ELEVENLABS_API_KEY (TTS_PROVIDER=elevenlabs)');
  if (needTts && (cfg.TTS_PROVIDER === 'aurixel-vc' || cfg.TTS_PROVIDER === 'aurixel') && !cfg.AURIXEL_API_KEY)
    missing.push(`AURIXEL_API_KEY (TTS_PROVIDER=${cfg.TTS_PROVIDER})`);
  if (needTts && (cfg.TTS_PROVIDER === 'qwen-vc' || cfg.TTS_PROVIDER === 'qwen' || cfg.TTS_PROVIDER === 'cosyvoice-vc') && !cfg.QWEN_API_KEY)
    missing.push(`QWEN_API_KEY (TTS_PROVIDER=${cfg.TTS_PROVIDER})`);
  if (missing.length) {
    throw new Error(
      `Missing required secrets in ${cfg.envPath} (or process.env): ${missing.join(', ')}`
    );
  }
}
