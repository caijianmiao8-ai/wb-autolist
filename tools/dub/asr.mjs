// asr.mjs — thin ASR facade. Picks the provider from config and delegates.
// Pipeline imports THIS, not a concrete provider, so swapping providers is
// a config switch (ASR_PROVIDER) with no pipeline edits.

import { pickAsr } from './factory.mjs';

export function makeAsr(cfg) {
  const provider = pickAsr(cfg);
  return {
    provider: provider.kind,
    /** transcribe(audioPath, {language}) -> {text, language, segments:[{start,end,text}]} */
    transcribe: (audioPath, opts) => provider.transcribe(audioPath, opts),
  };
}
