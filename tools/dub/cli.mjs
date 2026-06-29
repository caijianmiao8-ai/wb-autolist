#!/usr/bin/env node
// cli.mjs — entry point for the EN->RU product-video dubbing CLI.
//
// Usage:
//   node tools/dub/cli.mjs <input.mp4> [options]
//
// Options:
//   --out <path>                 output mp4 (default: <input>.ru.mp4)
//   --voice <id|name>            ElevenLabs voice id (default George JBFqnCBsd6RMkjVDRZzb)
//   --tts-model <id>             TTS model (default eleven_multilingual_v2)
//   --keywords "a,b,c"           RU keywords to weave into the translation
//   --brand X                    brand name kept verbatim
//   --tone marketing             marketing tone hint
//   --asr-provider speechmatics|aurixel|deepgram|whisper|elevenlabs
//   --tts-provider aurixel-vc|aurixel|qwen-vc|qwen|elevenlabs
//   --mode segment|whole         timing strategy (default segment)
//   --keep-original-audio <0..1> duck original under the dub at this gain (default 0 = replace)
//   --dry-run                    skip ALL paid calls (free wiring test)
//   --work <dir>                 work/scratch dir (default ~/.cache/wb-dub/<ts>)
//   --src-lang en  --target-lang ru
//   -h, --help

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, extname, resolve } from 'node:path';
import { loadConfig, redactedConfig, assertSecrets, parseSpeakerVoices, resolveVoice } from './config.mjs';
import { runPipeline } from './pipeline.mjs';
import { run } from './ffmpeg.mjs';

// Pre-download / warm the local dubbing engine (Demucs + PyTorch, and the
// voice-select model) so the FIRST real dub doesn't stall on a big download.
// Triggered from Settings via `node cli.mjs --prepare-engine`. Prints coarse
// stage lines (the Rust side forwards them as dub:engine progress) and
// `ENGINE_READY=1` on success. Uses the stall watchdog (idleMs) so a dead
// download can't hang forever.
async function prepareEngine() {
  const cfg = loadConfig({});
  const t0 = Date.now();
  const line = (m) => console.log(`${m}  (+${Math.round((Date.now() - t0) / 1000)}s)`);
  try {
    // Download/install torch + demucs and FETCH the pretrained weights via get_model
    // — no separation (a trivial clip trips demucs' reflect-pad assert), just the
    // heavy download + a cache warm.
    line('下载 / 安装 Demucs + PyTorch（首次较大，请耐心）…');
    await run(
      cfg.DEMUCS_UVX,
      ['--with', 'demucs', 'python', '-c', 'from demucs.pretrained import get_model; get_model("htdemucs"); print("demucs-ok")'],
      { idleMs: cfg.STEP_IDLE_MS }
    );
    line('Demucs 就绪');
    try {
      line('准备声纹择优模型（resemblyzer）…');
      await run(
        cfg.DEMUCS_UVX,
        ['--with', 'resemblyzer', '--with', 'numpy<2', 'python', '-c', 'from resemblyzer import VoiceEncoder; VoiceEncoder(); print("vs-ok")'],
        { idleMs: cfg.STEP_IDLE_MS }
      );
      line('声纹择优就绪');
    } catch (e) {
      line('声纹择优预热跳过（不影响背景分离）：' + String(e?.message || e).slice(0, 80));
    }
    console.log('ENGINE_READY=1');
    line('✅ 配音引擎已就绪，之后配音不再等待下载');
  } catch (e) {
    console.error('FAILED: ' + String(e?.message || e));
    process.exit(1);
  }
}

const HELP = `EN->RU product-video dubbing CLI

  node tools/dub/cli.mjs <input.mp4> [options]

Options:
  --out <path>                 output mp4 (default <input>.ru.mp4)
  --voice <id|name>            voice for the MAIN speaker (default George; names: sarah, jessica, brian…)
  --speaker-voices "s0=sarah,s1=jessica"  per-speaker voices (needs diarization)
  --no-diarize                 disable speaker separation (one voice for all)
  --tts-model <id>             TTS model id (default eleven_multilingual_v2)
  --keywords "a,b,c"           RU keywords woven into the translation
  --brand X                    brand kept verbatim
  --tone marketing             marketing tone hint
  --asr-provider aurixel|speechmatics|deepgram|whisper|el  ASR (aurixel=gateway, one key; speechmatics=direct; whisper=offline local)
  --whisper-model <mlx-id>     local whisper model (default whisper-large-v3-turbo)
  --tts-provider aurixel-vc|qwen-vc|qwen|el  TTS provider (aurixel-vc/qwen-vc = clone each speaker's real voice)
  --min-clone-sec <n>          min clean source audio to clone a speaker (default 6)
  --merge-gap <sec>            merge consecutive same-speaker segs (gap<=sec) into one call (default 0.35)
  --rate <chars/sec>           TTS speaking rate for length budgeting (default 12; raise for faster engines)
  --no-normalize               disable per-clip loudness normalization
  --no-iso                     disable isochrony (don't condense over-long lines)
  --iso-tol <ratio>            max RU overrun before condensing (default 1.12)
  --no-pitch-normalize         disable per-speaker pitch alignment (clone drift fix)
  --pitch-max-shift <0..1>     max pitch correction per clip (default 0.10 = ±10%)
  --no-gate                    don't mute the dub during the original's silent gaps
  --no-background              don't keep the original M&E/background (dub over silence)
  --no-stems                   skip Demucs entirely (no uvx/torch); clone from raw audio
  --mode segment|whole         timing strategy (default segment)
  --keep-original-audio 0..1   duck original under dub (default 0 = full replace)
  --dry-run                    skip all paid calls (free wiring test)
  --work <dir>                 scratch dir (default ~/.cache/wb-dub/<ts>)
  --src-lang en --target-lang ru
  -h, --help`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-h' || t === '--help') a.help = true;
    else if (t === '--dry-run') a.dryRun = true;
    else if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) a[key] = true; // boolean flag
      else {
        a[key] = next;
        i++;
      }
    } else a._.push(t);
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a['prepare-engine']) {
    await prepareEngine();
    return;
  }
  if (a.help || a._.length === 0) {
    console.log(HELP);
    process.exit(a.help ? 0 : 1);
  }

  const input = resolve(a._[0]);
  const base = basename(input, extname(input));
  const out = a.out ? resolve(a.out) : join(process.cwd(), `${base}.ru.mp4`);

  // CLI overrides feed into config resolution (highest priority).
  const overrides = {};
  if (a['asr-provider']) overrides.ASR_PROVIDER = String(a['asr-provider']).toLowerCase();
  if (a['tts-provider']) overrides.TTS_PROVIDER = String(a['tts-provider']).toLowerCase();
  if (a.voice && a.voice !== true) overrides.EL_VOICE_ID = resolveVoice(a.voice);
  if (a['tts-model']) overrides.EL_TTS_MODEL = a['tts-model'];
  if (a['no-diarize']) overrides.DIARIZE = 'false';
  if (a['speaker-voices'] && a['speaker-voices'] !== true) overrides.SPEAKER_VOICES = a['speaker-voices'];
  if (a['min-clone-sec'] && a['min-clone-sec'] !== true) overrides.MIN_CLONE_SEC = a['min-clone-sec'];
  if (a['merge-gap'] && a['merge-gap'] !== true) overrides.MERGE_GAP = a['merge-gap'];
  if (a.rate && a.rate !== true) overrides.RU_CHARS_PER_SEC = a.rate;
  if (a['no-normalize']) overrides.NORMALIZE = 'false';
  if (a['no-asr-cache']) overrides.ASR_CACHE = 'false';
  if (a['whisper-model'] && a['whisper-model'] !== true) overrides.WHISPER_MODEL = a['whisper-model'];
  if (a['no-iso']) overrides.ISO_LOOP = 'false';
  if (a['iso-tol'] && a['iso-tol'] !== true) overrides.ISO_TOL = a['iso-tol'];
  if (a['no-pitch-normalize']) overrides.PITCH_NORMALIZE = 'false';
  if (a['pitch-max-shift'] && a['pitch-max-shift'] !== true) overrides.PITCH_MAX_SHIFT = a['pitch-max-shift'];
  if (a['no-gate']) overrides.GATE_SILENCE = 'false';
  if (a.elastic) overrides.ELASTIC_PLACEMENT = 'true';
  if (a['no-background']) overrides.KEEP_BACKGROUND = 'false';
  if (a['no-stems']) overrides.USE_STEMS = 'false';
  if (a['no-duck']) overrides.BG_DUCK = 'false';
  // (intermediate clip format is derived from the TTS provider in config.mjs
  // wavTts — the single source of truth, which also covers aurixel-vc/aurixel.)
  if (a['src-lang']) overrides.SRC_LANG = a['src-lang'];
  if (a['target-lang']) overrides.TARGET_LANG = a['target-lang'];

  const cfg = loadConfig({ overrides });

  const mode = a.mode === 'whole' ? 'whole' : 'segment';
  const dryRun = !!a.dryRun;
  let keepOriginalAudio = 0;
  if (a['keep-original-audio'] !== undefined && a['keep-original-audio'] !== true) {
    keepOriginalAudio = Number(a['keep-original-audio']);
    if (!Number.isFinite(keepOriginalAudio) || keepOriginalAudio < 0 || keepOriginalAudio > 1) {
      console.error('--keep-original-audio must be a number in [0,1]');
      process.exit(1);
    }
  }
  const workDir = a.work ? resolve(a.work) : mkdtempSync(join(tmpdir(), 'wb-dub-'));

  if (!dryRun) assertSecrets(cfg, { needAsr: true, needTts: true, needTranslate: true });

  const translate = {
    keywords: a.keywords ? String(a.keywords).split(',').map((s) => s.trim()).filter(Boolean) : [],
    brand: a.brand && a.brand !== true ? a.brand : '',
    tone: a.tone && a.tone !== true ? a.tone : '',
  };
  // Only forward voice/model when the user EXPLICITLY set them; otherwise leave
  // undefined so EACH provider applies its OWN configured default (EL_VOICE_ID
  // for elevenlabs, AURIXEL_VOICE for aurixel). This keeps the provider swap
  // config-only — an EL voice id must never leak into the Aurixel provider.
  const tts = {
    voiceId: a.voice && a.voice !== true ? resolveVoice(a.voice) : undefined,
    modelId: a['tts-model'] && a['tts-model'] !== true ? a['tts-model'] : undefined,
    speakerVoices: cfg.SPEAKER_VOICES, // {speaker_id: voiceId} from --speaker-voices
  };

  console.log('== WB EN->RU dub ==');
  console.log(`input : ${input}`);
  console.log(`output: ${out}`);
  console.log(`work  : ${workDir}`);
  console.log(`mode  : ${mode}${dryRun ? '  [DRY-RUN: no paid calls]' : ''}`);
  console.log(`asr=${cfg.ASR_PROVIDER}  tts=${cfg.TTS_PROVIDER}  translate=${cfg.TRANSLATE_MODEL}`);
  if (process.env.DUB_DEBUG) console.log('cfg:', redactedConfig(cfg));

  const onEvent = (ev) => {
    const tag = ev.ok ? 'ok ' : 'ERR';
    let line = `  [${tag}] ${ev.stage.padEnd(18)} ${String(ev.ms).padStart(6)}ms`;
    if (ev.warn) line += `  WARN ${ev.warn}`;
    if (ev.error) line += `  ${ev.error}`;
    console.log(line);
  };

  const t0 = Date.now();
  try {
    const res = await runPipeline(cfg, { input, out, workDir, mode, dryRun, translate, tts, keepOriginalAudio, onEvent, cleanup: !!a.cleanup });
    console.log('-- summary --');
    console.log(`segments     : ${res.segments}`);
    if (res.speakers && res.speakers.length >= 1 && res.speakerVoiceMap) {
      const tag = res.cloned ? 'cloned' : 'voices';
      console.log(`speakers(${tag}): ${res.speakers.map((s) => `${s}=${res.speakerVoiceMap[s] || 'default'}`).join(', ')}`);
    }
    console.log(`video dur    : ${res.videoDur.toFixed(3)}s`);
    console.log(`output dur   : ${res.outDur.toFixed(3)}s  (drift ${res.drift.toFixed(3)}s)`);
    console.log(`asr/tts      : ${res.asrProvider} / ${res.ttsProvider}`);
    console.log(`total        : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`OUTPUT       : ${res.out}`); // human-readable (padded)
    // Stable machine-readable success marker — won't drift with cosmetic padding.
    // Integrators parse THIS line: /^OUTPUT=(.+)$/.
    console.log(`OUTPUT=${res.out}`);
  } catch (err) {
    console.error('\nFAILED:', err.message);
    console.error(`(intermediate artifacts kept in: ${workDir})`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
