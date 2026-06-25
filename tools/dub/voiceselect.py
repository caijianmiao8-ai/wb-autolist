#!/usr/bin/env python3
# voiceselect.py — pick, for each unit, the synthesis CANDIDATE whose voice is
# closest to that speaker's cloned reference. Run via `uvx --with resemblyzer`.
#
# Qwen TTS-VC renders the same voice differently each call (pitch swings 35-54Hz,
# timbre drifts). Generating several candidates and selecting the one that best
# matches the reference VOICE turns that randomness into reliable, consistent
# output in a single run. Score = speaker-embedding cosine similarity to the
# reference (content-invariant timbre match) minus a pitch-distance penalty (so we
# don't pick a timbre-good but wildly off-pitch take that DSP would then have to
# stretch hard).
#
# Manifest (argv[1], JSON):
#   { "refs": {"<spk>": "<ref_wav>"},
#     "refF0": {"<spk>": <hz>},
#     "units": [ {"i": <int>, "speaker": "<spk>",
#                 "candidates": [ {"path": "<wav>", "f0": <hz>} ] } ] }
# Output (argv[2], JSON): { "best": { "<i>": "<chosen_wav_path>" } }

import sys, json
import numpy as np
from resemblyzer import VoiceEncoder, preprocess_wav

PITCH_W = 0.6  # weight of the pitch-distance penalty vs the (0..1) embedding sim

def main():
    manifest = json.load(open(sys.argv[1]))
    enc = VoiceEncoder(verbose=False)
    cache = {}
    def emb(p):
        if p not in cache:
            try:
                cache[p] = enc.embed_utterance(preprocess_wav(p))
            except Exception:
                cache[p] = None
        return cache[p]
    refs = {spk: emb(p) for spk, p in manifest.get("refs", {}).items()}
    refF0 = manifest.get("refF0", {})
    best = {}
    for u in manifest["units"]:
        spk = u["speaker"]
        re_ = refs.get(spk)
        tgt = refF0.get(spk) or 0
        scored = []
        for c in u["candidates"]:
            e = emb(c["path"])
            if e is None or re_ is None:
                sim = 0.0
            else:
                sim = float(np.dot(e, re_) / (np.linalg.norm(e) * np.linalg.norm(re_) + 1e-9))
            f0 = c.get("f0") or 0
            pen = abs(f0 - tgt) / tgt if (tgt and f0) else 0.0
            scored.append((sim - PITCH_W * pen, c["path"]))
        if scored:
            scored.sort(key=lambda x: x[0], reverse=True)
            best[str(u["i"])] = scored[0][1]
    json.dump({"best": best}, open(sys.argv[2], "w"))

if __name__ == "__main__":
    main()
