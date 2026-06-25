# WB Dub — EN→RU product-video voiceover CLI

Takes a product video with an **English** voiceover and outputs the same video
with a **Russian** voiceover — self-assembled, watermark-free, **universal** (runs
on any video, no per-video hardcoding, graceful degradation at every stage).

```
ffmpeg extract → Demucs separate (clean vocals + M&E background)
  → ASR (Speechmatics default): word timestamps + speaker diarization
  → diarize-refine (gpt-5.5): fix overlapping-voice mislabels by ROLE + pitch + context
  → Aurixel chat EN→RU translation (gpt-5.5, duration-budgeted, keyword/brand/tone)
  → per-speaker CLONE from the auto-selected single-condition cleanest reference
  → voice-select: K candidates per line, keep the one most like the reference (resemblyzer)
  → pitch-normalize (anchor to reference f0) + RMS level
  → bidirectional isochrony (condense long / expand short to the slot) → end-aligned fit
  → gate (mute dub in original silence) → mix over M&E background (+duck)
```

Everything is generic: speakers come from diarization (any count), each speaker's
clone reference is auto-picked as their cleanest single-condition window (no fixed
timestamps), and any stage that can't run degrades safely.

Zero npm dependencies (pure Node ESM, global `fetch`/`FormData`/`WebSocket`, Node 18+).
`ffmpeg`/`ffprobe`/`uvx` resolved from `~/.local/bin`. Demucs, local Whisper and the
voice-select embedder run on-demand via `uvx` (cached after first use).

## Quick start

```bash
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"

# free wiring test — no paid calls:
node tools/dub/cli.mjs sample.mp4 --dry-run

# real dub (settled default = Speechmatics ASR + Qwen-VC clone + voice-select):
node tools/dub/cli.mjs sample.mp4 --out sample.ru.mp4 \
  --keywords "вафельница,завтрак,подарок" --tone "дружелюбный маркетинговый"
```

Secrets are read from `.env.local` (gitignored), never printed (`DUB_DEBUG=1`
prints a redacted config only).

## Why it stays consistent (the hard-won core)

Qwen `qwen3-tts-vc` is the cloning engine. Its **synthesis is randomly different
every call** (same voiceId+text → f0 swings ~40Hz, timbre/length drift; no
seed/stability param). The cloning is fine — the *synthesis* is a lottery. The
pipeline turns that lottery into reliable, single-run output:

1. **Single-condition clone reference** — `selectCleanReference` slides a window
   over the speaker's speech and picks the cleanest-background stretch, independent
   of ASR segmentation. A product video often mixes clean POST narration with LIVE
   on-location speech; a reference spanning both makes the clone wander between two
   timbres. (`CLONE_REF_GAP=0.6` keeps the reference inside one utterance.)
2. **Voice-select** — synth `RENDER_CANDIDATES` takes per line, keep the one whose
   speaker-embedding is closest to the reference (`voiceselect.py`, resemblyzer via
   uvx) + a pitch penalty. Picks the good render instead of hoping for one.
3. **Pitch-normalize to the reference f0** + RMS level — locks two speakers from
   drifting into each other and equalizes loudness without flattening dynamics.
4. **Diarize-refine** — acoustic diarization can't separate overlapping
   parent/child voices (pitch AND embeddings overlap). gpt-5.5 reassigns lines by
   ROLE (the dominant speaker is the adult presenter; the minority only asks/reacts)
   + asymmetric pitch (a <245Hz line is never the child; high pitch ≠ child) + content.
5. **Bidirectional isochrony** — measures each voice's real chars/sec, then condenses
   long lines and expands short ones so the dub fills the original slot at natural
   pace; end-aligned fit + gentle fill so it never rushes, overruns, or leaves a
   moving mouth silent.

## Providers (the extension point)

`factory.mjs` is the only place providers are named; `pipeline.mjs` never changes.
Each provider's **base URL and key are config-driven** — see *Routing everything
through Aurixel* below.

### ASR (`--asr-provider` / `ASR_PROVIDER`, default `speechmatics`)
| Provider | Diarization | Timestamps | Notes |
|---|---|---|---|
| `speechmatics` *(default)* | ✅ strong | word | cloud direct; `SPEECHMATICS_SPEAKER_SENSITIVITY=0.3` (higher over-splits one speaker into two) |
| `aurixel` | ✅ strong | word + segment | **same Speechmatics via the Aurixel OpenAI-shape gateway — ONE key for ASR+translate+TTS.** `verbose_json` passes through timestamps + diarization; honors `AURIXEL_SPEAKER_SENSITIVITY=0.3`. Live-verified on production equivalent to direct |
| `whisper` | ❌ | word | **local/offline** (mlx via uvx), zero cost/quota; best for monologue. `WHISPER_MODEL` |
| `deepgram` | ⚠️ weak on minority | word | cloud, cheap/fast; misses a minority child speaker |
| `dashscope` (`qwen3-asr-flash`) | ❌ | VAD-approx | great text, no native timestamps |
| `elevenlabs` | ✅ | word | strongest diarization on hard cases, but key has a quota |

ASR results are **cached** per video (`~/.cache/wb-dub/asr`, keyed on size+mtime+provider+settings) — re-runs never re-pay or re-hit a quota.

### TTS (`--tts-provider` / `TTS_PROVIDER`, default `qwen-vc`)
| Provider | Voice | Consistency | Notes |
|---|---|---|---|
| `qwen-vc` *(default)* | clones each speaker | per-call random → stabilized by voice-select + pitch-norm | DashScope direct (region key); cross-lingual EN→RU |
| `aurixel-vc` | clones each speaker | same engine/drift as `qwen-vc` (stabilized the same way) | **same `qwen3-tts-vc`, via the Aurixel OpenAI-shape gateway — ONE gateway key also does ASR + translate.** Enroll `POST /audio/voices`, synth `POST /audio/speech`. Live-verified on production |
| `aurixel` | preset (Cherry/Katerina/…) | stable, generic | gateway preset (no cloning) |
| `cosyvoice-vc` | clones | **deterministic** (no drift) | DashScope same key; but RU ~2× slow (`COSYVOICE_RATE`), needs ≥10s ref + OSS-url enroll + WebSocket synth |
| `qwen` | preset (Cherry/Katerina/…) | stable, generic | no cloning; `--speaker-voices "speaker_0=Katerina"` |
| `elevenlabs` | preset/IVC | IVC is the cleanest (natural+stable) | key here has no IVC |

A speaker with too little clean audio to clone (e.g. a child with ~2s) falls back to
a distinct preset voice (`QWEN_FALLBACK_VOICES`); CosyVoice rejects <~10s and routes
the preset through `qwen3-tts-flash`.

## Routing everything through the gateway (one key — FULLY LIVE)

One Aurixel key (`AURIXEL_API_KEY`) now drives **all three paid stages**. The
gateway is OpenAI-compatible (`/v1`); every provider takes a `*_BASE` + key from
config, so you point a stage at the gateway and reuse the one key. Verified live on
the production line `https://conduit-api.aurixel.ai/v1` on 2026-06-24:

| Stage | How to route through the gateway | Status |
|---|---|---|
| **Translate + diarize-refine** | `AURIXEL_BASE`=gateway, `AURIXEL_API_KEY`=gateway key, `TRANSLATE_MODEL=gpt-5.5` | ✅ live (`gpt-5.5` clean; `qwen3-32b` leaks `<think>`, don't use for translate) |
| **ASR (timestamps + diarization)** | `ASR_PROVIDER=aurixel` (`AURIXEL_ASR_MODEL=speechmatics-enhanced`) | ✅ live — `verbose_json` passes through Speechmatics' word+segment timestamps AND diarization; honors `speaker_sensitivity` (`AURIXEL_SPEAKER_SENSITIVITY=0.3` folds the over-split). Equivalent to direct Speechmatics + the same diarize-refine. (Deepgram via the gateway is still text-only — use a `speechmatics-*` model.) |
| **TTS + per-speaker cloning** | `TTS_PROVIDER=aurixel-vc` | ✅ live (enroll `/audio/voices` → synth `/audio/speech`; same `qwen3-tts-vc`, round-trips back to clean RU) |
| **TTS preset voices** | `TTS_PROVIDER=aurixel` | ✅ live |

True single-key setup — ASR + translate + TTS all on the gateway:

```bash
# .env.local — ONE key (AURIXEL_BASE defaults to the aurixel production line)
AURIXEL_API_KEY=ck-…
AURIXEL_BASE=https://conduit-api.aurixel.ai/v1
ASR_PROVIDER=aurixel
TTS_PROVIDER=aurixel-vc
```
```bash
node tools/dub/cli.mjs in.mp4 --out out.ru.mp4 \
  --asr-provider aurixel --tts-provider aurixel-vc
```

**Local stages stay local** regardless: Demucs (M&E separation), resemblyzer
(voice-select embedding) — all via `uvx`, no key. (Local mlx-whisper is still
available as `--asr-provider whisper` for fully-offline monologue ASR.)

## Key config (env or flag; `process.env` > `.env.local` > default)

| Var / flag | Default | Effect |
|---|---|---|
| `ASR_PROVIDER` / `--asr-provider` | `speechmatics` | see table |
| `TTS_PROVIDER` / `--tts-provider` | `qwen-vc` | see table |
| `DIARIZE_REFINE` | on | gpt-5.5 role+pitch+context speaker correction (multi-speaker only) |
| `VOICE_SELECT` | on | best-of-K render selection by voice similarity |
| `RENDER_CANDIDATES` | `4` | candidates per cloned line (more = steadier, slower) |
| `PITCH_NORMALIZE` / `PITCH_MAX_SHIFT` | on / `0.10` | shift each clip toward the reference f0 |
| `CLONE_REF_GAP` / `CLONE_NOISE_TOL` | `0.6` / `12` | single-condition reference window selection |
| `MIN_CLONE_SEC` / `MAX_CLONE_SEC` | `2` / `12` | clone-able window bounds (short → preset fallback) |
| `ISO_TOL` / `ISO_LOW` / `ISO_FILL` | `1.10` / `0.90` / `0.95` | condense >tol×span, expand <low×span, toward fill×span |
| `FIT_MAX_SPEEDUP` / `FIT_MIN_SLOWDOWN` | `1.12` / `0.9` | gentle, uniform time-fit caps (uniform = one consistent voice) |
| `OVERLAP_TOL` / `OVERLAP_TOL_CROSS` | `0.12` / `1.5` | same-speaker nudge vs cross-speaker parallel overlap |
| `NORMALIZE` / `NORM_TARGET_DB` | on / `-20` | RMS leveling between clips |
| `SPEECHMATICS_SPEAKER_SENSITIVITY` | `0.3` | lower = fewer speakers (avoid over-split) |
| `COSYVOICE_RATE` | `1.9` | speed up CosyVoice's slow RU toward natural |
| `ASR_CACHE` | on | cache transcript per video |
| `RU_CHARS_PER_SEC` / `--rate` | `12` | initial translation length budget (iso re-fits to measured rate) |

Secrets (no defaults): `AURIXEL_API_KEY` (translate, always), plus the chosen
providers' keys — `QWEN_API_KEY`, `SPEECHMATICS_API_KEY`, `DEEPGRAM_API_KEY`,
`ELEVENLABS_API_KEY`, `HF_TOKEN` (only if you swap voice-select to gated pyannote).

## Work-dir artifacts (debug / resume)
`asr_raw.json`, `segments_src.json` (post-refine labels), `segments_ru.json`,
`segments/segNNN_{raw,c0..cK,pitch,norm,fit}.wav`, `voiceselect.json`.

## Adding a provider
1. `providers/foo.mjs` exporting `makeFooAsr(cfg)` / `makeFooTts(cfg)` returning the
   duck-typed interface (`transcribe` / `enroll`+`synthesize`).
2. A `case 'foo':` in `pickAsr`/`pickTts` in `factory.mjs`.
3. `--asr-provider foo` / `--tts-provider foo`. No pipeline edits.

## Gotchas
- Qwen clone drift is **synthesis-layer** (per-call random), not cloning — mitigate
  with voice-select, don't expect a seed.
- CosyVoice is deterministic but its RU is slow; speeding it up sounds rushed —
  prefer condensing the translation if you use it.
- Cloning a calm reference can't reproduce an excited delivery (Qwen expressiveness
  ceiling). ElevenLabs IVC is the clean fix if that matters.
- A child with only ~2s of speech is below a reliable clone; expect a fallback
  preset or a marginal clone.
- Cross-lingual clone (EN speaker → RU) carries a slight accent.
