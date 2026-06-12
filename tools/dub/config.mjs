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

  const cfg = {
    envPath,

    // --- Secrets (never log) ---
    AURIXEL_API_KEY: env('AURIXEL_API_KEY'),
    ELEVENLABS_API_KEY: env('ELEVENLABS_API_KEY'),

    // --- Provider selection ---
    ASR_PROVIDER: String(env('ASR_PROVIDER', 'elevenlabs')).toLowerCase(),
    TTS_PROVIDER: String(env('TTS_PROVIDER', 'elevenlabs')).toLowerCase(),

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
    // explicit map, e.g. "speaker_0=sarah,speaker_1=jessica" (names or ids).
    SPEAKER_VOICES: parseSpeakerVoices(env('SPEAKER_VOICES')),
    // dominant speaker uses EL_VOICE_ID/--voice; extra speakers rotate this pool.
    SECONDARY_VOICE_POOL: String(env('SECONDARY_VOICE_POOL', 'jessica,brian,laura,eric'))
      .split(',').map((s) => resolveVoice(s)).filter(Boolean),

    // --- Consistency post-processing ---
    // loudness-normalize each clip (flattens per-call level drift, esp. qwen-vc).
    NORMALIZE: String(env('NORMALIZE', 'true')).toLowerCase() !== 'false',
    // merge consecutive same-speaker segments with a gap <= this many seconds into
    // ONE synthesis call (fewer calls -> less clone drift, more natural prosody).
    // 0 = off (one call per segment). 0.5 is conservative (only re-joins clips the
    // ASR split mid-utterance); 1.0–1.5 merges more aggressively.
    MERGE_GAP: Number(env('MERGE_GAP', '0')),
    // cap a merged unit's span so internal sync drift stays bounded.
    MAX_UNIT_SEC: Number(env('MAX_UNIT_SEC', '10')),
    // length-budgeted translation: target RU speaking rate (chars incl. spaces per
    // second). The translator is told to keep each line within its slot+gap budget
    // so it doesn't overflow and get sped-up/truncated. Lower = shorter RU.
    RU_CHARS_PER_SEC: Number(env('RU_CHARS_PER_SEC', '15')),

    // --- Qwen / DashScope TTS voice cloning (qwen3-tts-vc) ---
    QWEN_API_KEY: env('QWEN_API_KEY'),
    QWEN_TTS_BASE: env('QWEN_TTS_BASE', 'https://dashscope.aliyuncs.com'), // Beijing key
    QWEN_TTS_VC_MODEL: env('QWEN_TTS_VC_MODEL', 'qwen3-tts-vc-2026-01-22'),
    QWEN_ENROLL_MODEL: env('QWEN_ENROLL_MODEL', 'qwen-voice-enrollment'),
    // preset-voice TTS (TTS_PROVIDER=qwen): stable locked voices, no cloning
    QWEN_TTS_MODEL: env('QWEN_TTS_MODEL', 'qwen3-tts-flash'),
    QWEN_VOICE: env('QWEN_VOICE', 'Cherry'),
    // per-speaker cloning: only clone speakers with at least this many seconds of
    // clean source audio; shorter speakers fall back to a premade/static voice.
    MIN_CLONE_SEC: Number(env('MIN_CLONE_SEC', '6')),
    MAX_CLONE_SEC: Number(env('MAX_CLONE_SEC', '30')),

    // --- Aurixel audio (stubs; 404 today) ---
    AURIXEL_AUDIO_BASE:
      env('AURIXEL_AUDIO_BASE') || env('AURIXEL_BASE', 'https://conduit-api.aurixel.ai/v1'),
    AURIXEL_ASR_MODEL: env('AURIXEL_ASR_MODEL', 'whisper-1'),
    AURIXEL_TTS_MODEL: env('AURIXEL_TTS_MODEL', 'tts-1'),
    AURIXEL_VOICE: env('AURIXEL_VOICE', 'alloy'),

    // --- ffmpeg / pipeline ---
    FFMPEG_PATH: env('FFMPEG_PATH') || join(homedir(), '.local/bin/ffmpeg'),
    FFPROBE_PATH: env('FFPROBE_PATH') || join(homedir(), '.local/bin/ffprobe'),
    OUT_FORMAT: env('OUT_FORMAT', 'mp3'), // intermediate TTS audio format

    // --- Network ---
    HTTP_TIMEOUT_MS: Number(env('HTTP_TIMEOUT_MS', '120000')),
    HTTP_RETRIES: Number(env('HTTP_RETRIES', '2')),

    // --- Work dir ---
    WORK_ROOT: env('WORK_ROOT') || join(homedir(), '.cache', 'wb-dub'),
  };

  return cfg;
}

/** Return a copy of cfg safe to print (secrets masked). */
export function redactedConfig(cfg) {
  const mask = (v) => (v ? `set(${String(v).slice(0, 3)}…len${String(v).length})` : '<unset>');
  return {
    ...cfg,
    AURIXEL_API_KEY: mask(cfg.AURIXEL_API_KEY),
    ELEVENLABS_API_KEY: mask(cfg.ELEVENLABS_API_KEY),
  };
}

/** Throw a clear error if a required secret for the selected providers is missing. */
export function assertSecrets(cfg, { needAsr = true, needTts = true, needTranslate = true } = {}) {
  const missing = [];
  if (needTranslate && !cfg.AURIXEL_API_KEY) missing.push('AURIXEL_API_KEY (translation)');
  if (needAsr && cfg.ASR_PROVIDER === 'elevenlabs' && !cfg.ELEVENLABS_API_KEY)
    missing.push('ELEVENLABS_API_KEY (ASR_PROVIDER=elevenlabs)');
  if (needAsr && cfg.ASR_PROVIDER === 'aurixel' && !cfg.AURIXEL_API_KEY)
    missing.push('AURIXEL_API_KEY (ASR_PROVIDER=aurixel)');
  if (needTts && cfg.TTS_PROVIDER === 'elevenlabs' && !cfg.ELEVENLABS_API_KEY)
    missing.push('ELEVENLABS_API_KEY (TTS_PROVIDER=elevenlabs)');
  if (needTts && cfg.TTS_PROVIDER === 'aurixel' && !cfg.AURIXEL_API_KEY)
    missing.push('AURIXEL_API_KEY (TTS_PROVIDER=aurixel)');
  if (needTts && (cfg.TTS_PROVIDER === 'qwen-vc' || cfg.TTS_PROVIDER === 'qwen') && !cfg.QWEN_API_KEY)
    missing.push(`QWEN_API_KEY (TTS_PROVIDER=${cfg.TTS_PROVIDER})`);
  if (missing.length) {
    throw new Error(
      `Missing required secrets in ${cfg.envPath} (or process.env): ${missing.join(', ')}`
    );
  }
}
