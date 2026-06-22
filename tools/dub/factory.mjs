// factory.mjs — THE provider extension point.
//
// >>> TO ADD OR SWAP A PROVIDER: add a case here + a new file in providers/.
//     pipeline.mjs NEVER changes. <<<
//
// Each pick* function reads the resolved config and returns a duck-typed
// provider. The CLI/pipeline only ever talk to these interfaces:
//   AsrProvider.transcribe(audioPath, {language}) -> {text, segments:[{start,end,text}]}
//   TtsProvider.synthesize(text, {voiceId, modelId, language, format, outPath}) -> {outPath, bytes, durationSec?}
//   Translator.translate(segments, {from,to,keywords,brand,tone}) -> segments

import { makeElevenLabsAsr, makeElevenLabsTts } from './providers/elevenlabs.mjs';
import { makeAurixelAsr, makeAurixelTts } from './providers/aurixelAudio.mjs';
import { makeQwenTtsVc, makeQwenTts } from './providers/qwenTtsVc.mjs';
import { makeCosyVoiceTtsVc } from './providers/cosyvoiceTtsVc.mjs';
import { makeJoyvizTtsVc, makeJoyvizTts } from './providers/joyvizTts.mjs';
import { makeJoyvizAsr } from './providers/joyvizAsr.mjs';
import { makeDashscopeAsr } from './providers/dashscopeAsr.mjs';
import { makeLocalWhisper } from './providers/localWhisper.mjs';
import { makeDeepgramAsr } from './providers/deepgramAsr.mjs';
import { makeSpeechmaticsAsr } from './providers/speechmaticsAsr.mjs';
import { makeAurixelTranslator } from './translate.mjs';

export function pickAsr(cfg) {
  const net = { timeoutMs: cfg.HTTP_TIMEOUT_MS, retries: cfg.HTTP_RETRIES };
  switch (cfg.ASR_PROVIDER) {
    case 'elevenlabs':
      return makeElevenLabsAsr({ apiKey: cfg.ELEVENLABS_API_KEY, baseUrl: cfg.EL_ASR_BASE, model: cfg.EL_ASR_MODEL, ...net });
    case 'aurixel':
      return makeAurixelAsr({ apiKey: cfg.AURIXEL_API_KEY, baseUrl: cfg.AURIXEL_AUDIO_BASE, model: cfg.AURIXEL_ASR_MODEL, ...net });
    case 'dashscope':
    case 'qwen':
      // Qwen3-ASR (DashScope) — no ElevenLabs quota. qwen3-asr-flash text + VAD
      // timestamps. Single-speaker; timestamps are approximate (VAD-based).
      return makeDashscopeAsr({ apiKey: cfg.QWEN_API_KEY, baseUrl: cfg.QWEN_TTS_BASE, model: cfg.QWEN_ASR_MODEL });
    case 'whisper':
    case 'local-whisper':
      // Local Whisper (mlx via uvx) — accurate text + native word/segment
      // timestamps, fully offline. The most stable timestamp source. Single-speaker.
      return makeLocalWhisper({ model: cfg.WHISPER_MODEL });
    case 'deepgram':
      // Deepgram (nova-3) — cloud ASR with word/utterance timestamps AND speaker
      // diarization. Cheap/fast; weaker diarization on hard minority-speaker cases.
      return makeDeepgramAsr({ apiKey: cfg.DEEPGRAM_API_KEY, baseUrl: cfg.DEEPGRAM_BASE, model: cfg.DEEPGRAM_MODEL, ...net });
    case 'speechmatics':
      // Speechmatics — cloud ASR with strong speaker diarization + word timestamps.
      // Default: handles both monologue and multi-speaker dialogue from one provider.
      return makeSpeechmaticsAsr({ apiKey: cfg.SPEECHMATICS_API_KEY, baseUrl: cfg.SPEECHMATICS_BASE, operatingPoint: cfg.SPEECHMATICS_OPERATING_POINT, speakerSensitivity: cfg.SPEECHMATICS_SPEAKER_SENSITIVITY });
    case 'joyviz':
      // Speechmatics ASR through the OpenAI-shape gateway — word/segment timestamps
      // + diarization via verbose_json, with speaker_sensitivity honored. ONE
      // gateway key also covers translate + TTS. Hard overlap mislabels → refine.
      return makeJoyvizAsr({ apiKey: cfg.JOYVIZ_API_KEY, baseUrl: cfg.JOYVIZ_BASE, model: cfg.JOYVIZ_ASR_MODEL, speakerSensitivity: cfg.JOYVIZ_SPEAKER_SENSITIVITY, ...net });
    // case 'myprovider': return makeMyProviderAsr({...});  // <-- extension example
    default:
      throw new Error(`unknown ASR_PROVIDER='${cfg.ASR_PROVIDER}' (expected speechmatics|joyviz|elevenlabs|deepgram|whisper|dashscope|aurixel)`);
  }
}

export function pickTts(cfg) {
  const net = { timeoutMs: cfg.HTTP_TIMEOUT_MS, retries: cfg.HTTP_RETRIES };
  switch (cfg.TTS_PROVIDER) {
    case 'elevenlabs':
      return makeElevenLabsTts({
        apiKey: cfg.ELEVENLABS_API_KEY,
        baseUrl: cfg.EL_TTS_BASE,
        model: cfg.EL_TTS_MODEL,
        voiceId: cfg.EL_VOICE_ID,
        outputFormat: cfg.EL_OUTPUT_FORMAT,
        ...net,
      });
    case 'aurixel':
      return makeAurixelTts({ apiKey: cfg.AURIXEL_API_KEY, baseUrl: cfg.AURIXEL_AUDIO_BASE, model: cfg.AURIXEL_TTS_MODEL, voice: cfg.AURIXEL_VOICE, ...net });
    case 'qwen-vc':
      // Voice-cloning provider: the pipeline enrolls each speaker first, then
      // synthesizes their segments in the cloned voice (see supportsCloning).
      return makeQwenTtsVc({
        apiKey: cfg.QWEN_API_KEY, baseUrl: cfg.QWEN_TTS_BASE,
        model: cfg.QWEN_TTS_VC_MODEL, enrollModel: cfg.QWEN_ENROLL_MODEL,
        presetModel: cfg.QWEN_TTS_MODEL, ...net,
      });
    case 'qwen':
      // Qwen3-TTS preset voices (Cherry/Katerina/…) — stable, no cloning.
      return makeQwenTts({ apiKey: cfg.QWEN_API_KEY, baseUrl: cfg.QWEN_TTS_BASE, model: cfg.QWEN_TTS_MODEL, voice: cfg.QWEN_VOICE, ...net });
    case 'joyviz-vc':
      // Same qwen3-tts-vc cloning, but via the OpenAI-compatible JoyViz/Aurixel
      // gateway — ONE gateway key also covers chat-translate. Enroll /audio/voices,
      // synth /audio/speech. Drift handled by voice-select + pitch-norm as usual.
      return makeJoyvizTtsVc({ apiKey: cfg.JOYVIZ_API_KEY, baseUrl: cfg.JOYVIZ_BASE, model: cfg.JOYVIZ_TTS_VC_MODEL, presetModel: cfg.JOYVIZ_TTS_MODEL, ...net });
    case 'joyviz':
      // Preset voices through the gateway (no cloning).
      return makeJoyvizTts({ apiKey: cfg.JOYVIZ_API_KEY, baseUrl: cfg.JOYVIZ_BASE, model: cfg.JOYVIZ_TTS_MODEL, voice: cfg.JOYVIZ_VOICE, ...net });
    case 'cosyvoice-vc':
      // CosyVoice v3.5 cloning — DETERMINISTIC synthesis (no per-call drift, unlike
      // qwen-vc). Same DashScope key. Enroll via OSS-url, synthesize via WebSocket.
      return makeCosyVoiceTtsVc({ apiKey: cfg.QWEN_API_KEY, baseUrl: cfg.QWEN_TTS_BASE, model: cfg.COSYVOICE_MODEL, presetModel: cfg.QWEN_TTS_MODEL, sampleRate: cfg.COSYVOICE_SAMPLE_RATE, rate: cfg.COSYVOICE_RATE, ...net });
    // case 'myprovider': return makeMyProviderTts({...});  // <-- extension example
    default:
      throw new Error(`unknown TTS_PROVIDER='${cfg.TTS_PROVIDER}' (expected elevenlabs|aurixel|qwen-vc|qwen|cosyvoice-vc|joyviz-vc|joyviz)`);
  }
}

export function pickTranslator(cfg) {
  // Chat translation stays on Aurixel (the only place gpt-5.5 lives today).
  return makeAurixelTranslator({
    apiKey: cfg.AURIXEL_API_KEY,
    baseUrl: cfg.AURIXEL_BASE,
    model: cfg.TRANSLATE_MODEL,
    timeoutMs: cfg.HTTP_TIMEOUT_MS,
    retries: cfg.HTTP_RETRIES,
  });
}
