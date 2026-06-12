// tts.mjs — thin TTS facade. Picks the provider from config and delegates.
// Pipeline imports THIS, not a concrete provider, so swapping providers is
// a config switch (TTS_PROVIDER) with no pipeline edits.

import { pickTts } from './factory.mjs';

export function makeTts(cfg) {
  const provider = pickTts(cfg);
  return {
    provider: provider.kind,
    /** synthesize(text, {voiceId, modelId, language, format, outPath}) -> {outPath, bytes, durationSec?} */
    synthesize: (text, opts) => provider.synthesize(text, opts),
  };
}
