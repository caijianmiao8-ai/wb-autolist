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
import { makeAurixelTranslator } from './translate.mjs';

export function pickAsr(cfg) {
  const net = { timeoutMs: cfg.HTTP_TIMEOUT_MS, retries: cfg.HTTP_RETRIES };
  switch (cfg.ASR_PROVIDER) {
    case 'elevenlabs':
      return makeElevenLabsAsr({ apiKey: cfg.ELEVENLABS_API_KEY, baseUrl: cfg.EL_ASR_BASE, model: cfg.EL_ASR_MODEL, ...net });
    case 'aurixel':
      return makeAurixelAsr({ apiKey: cfg.AURIXEL_API_KEY, baseUrl: cfg.AURIXEL_AUDIO_BASE, model: cfg.AURIXEL_ASR_MODEL, ...net });
    // case 'myprovider': return makeMyProviderAsr({...});  // <-- extension example
    default:
      throw new Error(`unknown ASR_PROVIDER='${cfg.ASR_PROVIDER}' (expected elevenlabs|aurixel)`);
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
        model: cfg.QWEN_TTS_VC_MODEL, enrollModel: cfg.QWEN_ENROLL_MODEL, ...net,
      });
    case 'qwen':
      // Qwen3-TTS preset voices (Cherry/Katerina/…) — stable, no cloning.
      return makeQwenTts({ apiKey: cfg.QWEN_API_KEY, baseUrl: cfg.QWEN_TTS_BASE, model: cfg.QWEN_TTS_MODEL, voice: cfg.QWEN_VOICE, ...net });
    // case 'myprovider': return makeMyProviderTts({...});  // <-- extension example
    default:
      throw new Error(`unknown TTS_PROVIDER='${cfg.TTS_PROVIDER}' (expected elevenlabs|aurixel|qwen-vc|qwen)`);
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
