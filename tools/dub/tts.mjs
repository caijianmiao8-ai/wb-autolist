// tts.mjs — thin TTS facade. Picks the provider from config and delegates.
// Pipeline imports THIS, not a concrete provider, so swapping providers is
// a config switch (TTS_PROVIDER) with no pipeline edits.

import { pickTts } from './factory.mjs';

export function makeTts(cfg) {
  const provider = pickTts(cfg);
  return {
    provider: provider.kind,
    // cloning providers (qwen-vc) expose enroll(); the pipeline uses it to clone
    // each speaker before synthesis. Non-cloning providers leave these undefined.
    supportsCloning: !!provider.supportsCloning,
    enroll: provider.enroll ? (samplePath, opts) => provider.enroll(samplePath, opts) : undefined,
    /** synthesize(text, {voiceId, modelId, language, format, outPath}) -> {outPath, bytes, durationSec?} */
    synthesize: (text, opts) => provider.synthesize(text, opts),
  };
}
