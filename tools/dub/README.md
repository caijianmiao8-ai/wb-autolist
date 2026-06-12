# WB Dub — EN→RU product-video voiceover CLI

Takes a Wildberries product video with an **English** voiceover and outputs the
same video with a **Russian** voiceover. Self-assembled, watermark-free pipeline:

```
ffmpeg extract audio
  → ElevenLabs Scribe STT (word-level timestamps)
  → Aurixel chat EN→RU translation (gpt-5.5, keyword/brand/tone aware)
  → ElevenLabs Russian TTS (multilingual_v2)
  → ffmpeg per-segment time-fit (atempo/apad) + assemble + mux
```

Zero npm dependencies. Pure Node ESM, Node 18+ (global `fetch`/`FormData`/`Blob`).
`ffmpeg`/`ffprobe` resolved from `~/.local/bin` (override via env).

## Quick start

```bash
# node + ffmpeg are not on PATH by default on this machine:
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"

# free wiring test — no paid API calls, proves extract/fit/assemble/mux:
node tools/dub/cli.mjs sample.mp4 --dry-run

# real dub:
node tools/dub/cli.mjs sample.mp4 \
  --out sample.ru.mp4 \
  --keywords "термокружка,нержавеющая сталь" \
  --brand AquaNord \
  --tone "energetic marketing" \
  --voice JBFqnCBsd6RMkjVDRZzb
```

Secrets are read from `/Users/ruo/claude-test/WILDBERRIES/.env.local` (gitignored).
They are **never** printed (`DUB_DEBUG=1` prints a redacted config only).

## CLI options

| Option | Default | Notes |
|---|---|---|
| `<input.mp4>` | — | source video (required) |
| `--out <path>` | `<input>.ru.mp4` | output file |
| `--voice <id>` | George `JBFqnCBsd6RMkjVDRZzb` | ElevenLabs voice id |
| `--tts-model <id>` | `eleven_multilingual_v2` | best RU quality |
| `--keywords "a,b"` | — | RU keywords woven into translation |
| `--brand X` | — | kept verbatim (not transliterated) |
| `--tone marketing` | — | tone hint for the localizer |
| `--asr-provider` | `elevenlabs` | `elevenlabs` \| `aurixel` |
| `--tts-provider` | `elevenlabs` | `elevenlabs` \| `aurixel` |
| `--mode segment\|whole` | `segment` | timing strategy (see below) |
| `--keep-original-audio 0..1` | `0` | duck original under dub at this gain (0 = full replace) |
| `--dry-run` | off | skip all paid calls; free wiring test |
| `--work <dir>` | `~/.cache/wb-dub/<ts>` (tmp) | scratch/artifact dir (resumable/debuggable) |
| `--src-lang / --target-lang` | `en` / `ru` | |

**Modes.** `segment` (default) time-fits each Russian clip to its `[start,end]`
slot and places it at its start time — preserves lip/scene sync, tolerates
gaps and overlaps. `whole` concatenates all RU clips and does a single atempo
stretch to the whole video duration — a robust fallback when per-segment timing
is unreliable.

## Work-dir artifacts (debug / resume)

Each run writes intermediates so a partial run is inspectable and you never
re-pay for STT:

```
audio_16k.wav        # extracted 16kHz mono audio fed to STT
asr_raw.json         # raw Scribe response (cache; re-use to avoid re-paying)
segments_src.json    # English segments [{start,end,text}]
segments_ru.json     # Russian segments (post-translation)
segments/segNNN_raw.mp3   # per-segment TTS output
segments/segNNN_fit.wav   # per-segment time-fitted clip
dub_track.wav        # assembled Russian track
```

## Environment variables

`process.env` overrides `.env.local`. Secrets have no defaults.

### Secrets (required)
| Var | Use |
|---|---|
| `AURIXEL_API_KEY` | Bearer — translation now, audio later. Always required. |
| `ELEVENLABS_API_KEY` | `xi-api-key` header — STT+TTS. Required while `*_PROVIDER=elevenlabs`. |

### Provider selection
| Var | Default | Values |
|---|---|---|
| `ASR_PROVIDER` | `elevenlabs` | `elevenlabs`, `aurixel` |
| `TTS_PROVIDER` | `elevenlabs` | `elevenlabs`, `aurixel` |

### Translation (Aurixel chat — live verified)
| Var | Default |
|---|---|
| `TRANSLATE_MODEL` | falls back to `AURIXEL_CHAT_MODEL` then `gpt-5.5` |
| `AURIXEL_BASE` | `https://conduit-api.aurixel.ai/v1` |

### ElevenLabs tuning
| Var | Default |
|---|---|
| `EL_BASE` | `https://api.elevenlabs.io` |
| `EL_ASR_BASE` / `EL_TTS_BASE` | = `EL_BASE` (independent per-side override) |
| `EL_ASR_MODEL` | `scribe_v1` |
| `EL_TTS_MODEL` | `eleven_multilingual_v2` |
| `EL_VOICE_ID` | `JBFqnCBsd6RMkjVDRZzb` (George) |
| `EL_OUTPUT_FORMAT` | `mp3_44100_128` (ceiling on the restricted key) |

### Aurixel audio (stubs; 404 today)
| Var | Default |
|---|---|
| `AURIXEL_AUDIO_BASE` | = `AURIXEL_BASE` |
| `AURIXEL_ASR_MODEL` | `whisper-1` |
| `AURIXEL_TTS_MODEL` | `tts-1` |
| `AURIXEL_VOICE` | `alloy` |

### ffmpeg / pipeline / network
| Var | Default |
|---|---|
| `FFMPEG_PATH` / `FFPROBE_PATH` | `~/.local/bin/ffmpeg` / `ffprobe` |
| `OUT_FORMAT` | `mp3` (intermediate TTS format) |
| `SRC_LANG` / `TARGET_LANG` | `en` / `ru` |
| `HTTP_TIMEOUT_MS` | `120000` |
| `HTTP_RETRIES` | `2` (on 429/5xx/network) |
| `WORK_ROOT` | `~/.cache/wb-dub` |

## KEY CONSTRAINTS (restricted ElevenLabs key)

This pipeline is deliberately built to work within a restricted key:

- **No voice cloning** — `/v1/voices/add` is disabled. We use shared library
  voices; `eleven_multilingual_v2` speaks fluent Russian on any of them.
- **No Dubbing endpoint** — ElevenLabs Dubbing only works `watermark=true` on
  this key, so we do **not** use it. We self-assemble STT+translate+TTS+ffmpeg
  instead, which is watermark-free.
- **No quota read** — `user_read` scope is missing, so `/v1/user` and quota
  endpoints are unavailable. Budget characters client-side (TTS is billed per
  input character; Russian text expands ~10–20% vs English).
- Auth header is `xi-api-key`, **not** `Authorization: Bearer`. `output_format`
  is a query param. `mp3_44100_192` is Creator-tier (403); stay on
  `mp3_44100_128`.

## Extensibility — adding or swapping a provider

> **This is the reserved extension point.** Adding or swapping a provider is a
> **new file + one `switch` case** in `factory.mjs`. `pipeline.mjs` never changes.

Architecture:

```
cli.mjs → pipeline.mjs → asr.mjs / tts.mjs / translate.mjs  (facades)
                              ↓
                         factory.mjs  ← the ONLY place providers are named
                              ↓
                providers/elevenlabs.mjs, providers/aurixelAudio.mjs, ...
```

The pipeline talks only to duck-typed interfaces:

```js
AsrProvider.transcribe(audioPath, { language }) -> { text, segments:[{start,end,text}] }
TtsProvider.synthesize(text, { voiceId, modelId, language, format, outPath }) -> { outPath, bytes, durationSec? }
Translator.translate(segments, { from, to, keywords, brand, tone }) -> segments  // 1:1
```

**To add a provider `foo`:**
1. Create `providers/foo.mjs` exporting `makeFooAsr(cfg)` / `makeFooTts(cfg)`
   that return objects with the interface above.
2. Add a `case 'foo':` to `pickAsr` / `pickTts` in `factory.mjs`.
3. Select it: `--asr-provider foo` or `ASR_PROVIDER=foo`. Done — no pipeline edits.

### How to switch ASR/TTS to Aurixel later

Aurixel's audio endpoints (`/v1/audio/transcriptions`, `/v1/audio/speech`) are
**404 today**. `providers/aurixelAudio.mjs` already forms correct
OpenAI-compatible requests; until the endpoints return 200 they throw a clear
`Aurixel ASR/TTS not enabled yet … set *_PROVIDER=elevenlabs` error.

Once the user **syncs ElevenLabs into Aurixel**, there are three config-only
paths (zero code change):

- **(A) Aurixel exposes OpenAI-style audio:**
  `ASR_PROVIDER=aurixel TTS_PROVIDER=aurixel`
  (optionally `AURIXEL_AUDIO_BASE`, `AURIXEL_ASR_MODEL`, `AURIXEL_TTS_MODEL`,
  `AURIXEL_VOICE`). The stubs start returning 200 → done.
- **(B) Aurixel fronts ElevenLabs verbatim (`xi-api-key` passthrough):**
  keep `*_PROVIDER=elevenlabs`, set `EL_BASE` (or `EL_ASR_BASE`/`EL_TTS_BASE`) to
  the Aurixel passthrough origin. Same request shapes, new host.
- **(C) Mixed:** e.g. `ASR_PROVIDER=aurixel` but TTS still ElevenLabs —
  independent switches + per-side base overrides.

**Verification hook:** re-probe `POST /audio/transcriptions` + `/audio/speech`.
When both return 200 instead of 404, flip the providers and run a sample
end-to-end.

**Notes after the swap:**
- `--voice` / `--tts-model` are **ElevenLabs-oriented** overrides. When
  `TTS_PROVIDER=aurixel`, set the voice/model via `AURIXEL_VOICE` /
  `AURIXEL_TTS_MODEL` env instead — an *unset* `--voice` correctly leaves each
  provider on its own default (no EL voice id leaks into Aurixel).
- `ASR_PROVIDER=aurixel` yields **Whisper segment-level** chunks (coarser) vs
  ElevenLabs **word-level** chunking. Timing granularity therefore differs after
  the swap; the pipeline handles both, but per-segment fit is slightly looser.
