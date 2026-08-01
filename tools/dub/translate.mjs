// translate.mjs — Aurixel chat EN->RU translator (gpt-5.5). LIVE-VERIFIED.
//
// Contract: POST {base}/chat/completions, Bearer, response_format json_object
// (supported by gpt-5.5; graceful fallback if a future gateway 400s on it).
// Translates an ARRAY of segments in ONE request (amortizes the reasoning-model
// cost) and enforces strict 1:1 segment preservation (throws on count drift).
// Re-attaches original start/end timing — only .text changes.

import { fetchWithRetry, errorText } from './http.mjs';

function stripFences(s) {
  let t = String(s).trim();
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (f) t = f[1].trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  return a >= 0 && b > a ? t.slice(a, b + 1) : t;
}

export function makeAurixelTranslator(cfg) {
  const base = (cfg.baseUrl || 'https://conduit-api.bifrostapi.net/v1').replace(/\/$/, '');
  const key = cfg.apiKey;
  const model = cfg.model || 'gpt-5.5';
  const timeoutMs = cfg.timeoutMs || 120000;
  const retries = cfg.retries ?? 2;

  const SYSTEM = [
    'You are a professional e-commerce localizer for Wildberries product video voiceovers.',
    'Translate an ARRAY of short spoken segments from source to target language.',
    'HARD RULES:',
    '1. Output STRICT JSON only. No markdown, no prose, no code fences.',
    '2. Schema: {"segments":[{"i":<int>,"text":"<translated>"}]}. Preserve order and the EXACT same number of items as input — 1:1, never merge or split.',
    '3. Each segment has "target_chars" = how many characters are SPOKEN in the time the speaker is talking. Make each translation LAND CLOSE to target_chars (within ~±15%): NOT much shorter (the dub would finish while the mouth is still moving) and NOT much longer (it would be rushed/cut off). Adjust wording/synonyms to hit the length while keeping the meaning and natural Russian. Match the speaking rhythm.',
    '4. Naturally weave in the target KEYWORDS where they fit; never keyword-stuff or break grammar.',
    '5. Keep the BRAND name verbatim (do not translate or transliterate).',
    '6. Apply the requested marketing TONE. Use correct target grammar, casing and punctuation.',
  ].join('\n');

  async function post(body) {
    const res = await fetchWithRetry(
      `${base}/chat/completions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      { timeoutMs, retries, label: 'Aurixel translate' }
    );
    return res;
  }

  /**
   * @param {Array<{start,end,text}>} segments
   * @returns same array, .text replaced with target-language translation.
   */
  async function translate(segments, { from = 'en', to = 'ru', keywords = [], brand = '', tone = '' } = {}) {
    if (!key) throw new Error('Aurixel translate: AURIXEL_API_KEY missing');
    if (!segments.length) return segments;

    const user = JSON.stringify({
      from,
      to,
      brand,
      tone,
      keywords,
      segments: segments.map((s, i) => ({ i, text: s.text ?? s, ...(s.targetChars ? { target_chars: s.targetChars } : {}) })),
    });
    const payload = {
      model,
      temperature: 0.4,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    };

    let res = await post(payload);
    // Only a 400 implies the gateway rejected response_format itself — retry once
    // without it. 5xx/429 were already retried+backed-off inside fetchWithRetry,
    // so re-posting here would just hammer an unhealthy endpoint.
    if (res.status === 400) {
      res = await post({ ...payload, response_format: undefined });
    }
    if (!res.ok) throw new Error(await errorText(res, 'Aurixel translate'));

    const wire = JSON.parse(await res.text());
    const content = wire?.choices?.[0]?.message?.content ?? '';
    const parsed = JSON.parse(stripFences(content));
    const out = parsed.segments ?? parsed;
    if (!Array.isArray(out) || out.length !== segments.length) {
      throw new Error(`Aurixel translate: segment count drift — got ${out?.length}, want ${segments.length}`);
    }
    // Re-key by the explicit `i` field the model is told to emit, so a reordered
    // response can't silently misalign translations to the wrong timing slots.
    const pick = (o, s) => (o && typeof o === 'object' ? (o.text ?? s.text) : (o ?? s.text));
    const byI = new Map(out.map((o, idx) => [Number.isFinite(o?.i) ? o.i : idx, o]));
    return segments.map((s, idx) => ({ ...s, text: pick(byI.has(idx) ? byI.get(idx) : out[idx], s) }));
  }

  /**
   * Condense ONE already-translated line to <= maxChars while preserving meaning
   * and natural target-language grammar. Used by the isochrony loop: when a line's
   * synthesized speech runs longer than the original speaker's on-screen time, we
   * ask for a tighter paraphrase so a small (inaudible) tempo nudge can land it on
   * the original duration — instead of a rushed hard speed-up. Returns the shorter
   * text, or the original on any failure (never throws — the loop degrades gracefully).
   */
  async function condense(text, maxChars, { to = 'ru', keywords = [], brand = '', tone = '' } = {}) {
    const src = String(text || '').trim();
    if (!key || !src || !(maxChars > 0) || src.length <= maxChars) return src;
    const sys = [
      'You rewrite a single spoken voiceover line to be SHORTER, in the SAME language.',
      `HARD LIMIT: at most ${maxChars} characters. Keep the core meaning and a natural, fluent ${to} sentence.`,
      'Drop filler/redundancy, prefer shorter synonyms; do NOT add new info. Keep the BRAND verbatim.',
      'Preserve any of these KEYWORDS that are already present; never keyword-stuff.',
      'Output STRICT JSON only: {"text":"<shorter line>"}. No prose, no fences.',
    ].join('\n');
    try {
      let res = await post({
        model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: JSON.stringify({ to, brand, keywords, tone, max_chars: maxChars, text: src }) },
        ],
        response_format: { type: 'json_object' },
      });
      if (res.status === 400) {
        res = await post({
          model, temperature: 0.3,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ to, max_chars: maxChars, text: src }) }],
        });
      }
      if (!res.ok) return src;
      const wire = JSON.parse(await res.text());
      const parsed = JSON.parse(stripFences(wire?.choices?.[0]?.message?.content ?? '{}'));
      const out = (parsed && typeof parsed === 'object' ? parsed.text : parsed) ?? src;
      const t = String(out).trim();
      return t || src;
    } catch {
      return src; // network/parse error — keep the original, loop will fall back to tempo-fit
    }
  }

  /**
   * EXPAND one translated line to ~minChars (the isochrony counterpart of condense)
   * while keeping it truthful and natural. Used when a line's synthesized speech
   * finishes well before the speaker stops — Russian is sometimes shorter than the
   * source and a static budget under-fills long takes (the real speaking rate is
   * voice-dependent). We add natural marketing elaboration ONLY about what's already
   * implied (no new factual claims), so the dub fills the on-screen speaking time at
   * a normal pace instead of ending early. Returns the original on any failure.
   */
  async function expand(text, minChars, { to = 'ru', keywords = [], brand = '', tone = '' } = {}) {
    const src = String(text || '').trim();
    if (!key || !src || !(minChars > 0) || src.length >= minChars) return src;
    const sys = [
      `You rewrite a single spoken voiceover line to be LONGER (about ${minChars} characters), in the SAME language (${to}).`,
      'Keep the meaning and add only NATURAL elaboration that is already implied (descriptive adjectives, a smooth connector, restating a benefit) — never invent new facts, numbers, or claims.',
      `Stay fluent and on-brand for a ${tone || 'marketing'} product voiceover. Keep the BRAND verbatim. Weave in present KEYWORDS naturally.`,
      'Output STRICT JSON only: {"text":"<longer line>"}. No prose, no fences.',
    ].join('\n');
    try {
      let res = await post({
        model, temperature: 0.5,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ to, brand, keywords, tone, target_chars: minChars, text: src }) }],
        response_format: { type: 'json_object' },
      });
      if (res.status === 400) {
        res = await post({ model, temperature: 0.5, messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ to, target_chars: minChars, text: src }) }] });
      }
      if (!res.ok) return src;
      const wire = JSON.parse(await res.text());
      const parsed = JSON.parse(stripFences(wire?.choices?.[0]?.message?.content ?? '{}'));
      const out = (parsed && typeof parsed === 'object' ? parsed.text : parsed) ?? src;
      const t = String(out).trim();
      return t || src;
    } catch {
      return src;
    }
  }

  /**
   * Correct SPEAKER LABELS using conversational context (gpt-5.5). Acoustic
   * diarization fails when voices overlap — a mother and child answering each other
   * are acoustically inseparable (validated: pitch AND speaker embeddings can't tell
   * them apart). But the DIALOGUE makes it obvious: a child asks "...mom?", the adult
   * answers; "pancake mix" is the answer, so it's the adult. The LLM reads who
   * addresses whom and the question→answer turn-taking and reassigns mislabeled
   * lines. Keeps the same speaker set the acoustic pass found (never invents voices).
   * Returns segments with corrected .speaker; the original on any failure.
   */
  async function refineSpeakers(segments, { language = 'en' } = {}) {
    if (!key || !Array.isArray(segments) || segments.length < 2) return segments;
    const speakers = [...new Set(segments.map((s) => s.speaker || 'speaker_0'))];
    if (speakers.length < 2) return segments; // monologue — nothing to attribute
    // The speaker with the most talk-time is the main presenter (adult); a small
    // minority speaker is usually the child. This ROLE prior is far more reliable
    // than pitch (an excited adult overlaps the child's pitch range).
    const dur = {};
    for (const s of segments) { const k = s.speaker || 'speaker_0'; dur[k] = (dur[k] || 0) + Math.max(0, (Number(s.end) || 0) - (Number(s.start) || 0)); }
    const adult = Object.entries(dur).sort((a, b) => b[1] - a[1])[0][0];
    const items = segments.map((s, i) => ({ i, t: Number((Number(s.start) || 0).toFixed(1)), text: String(s.text || '').trim(), speaker: s.speaker || 'speaker_0', ...(s.f0 ? { f0_hz: Math.round(s.f0) } : {}) }));
    const sys = [
      'You correct SPEAKER LABELS in a dubbing transcript. Acoustic diarization mislabels lines when voices overlap (a parent and child answering each other).',
      `ROLE (most reliable): "${adult}" is the MAIN PRESENTER — an ADULT who demonstrates, explains, answers the child, gives directions, and enthuses about the product. The OTHER speaker is a CHILD who only ASKS questions (often containing "mom"/"mama") and gives BRIEF reactions ("yep", "it's hot", "okay").`,
      `DECISION RULE — assign a line to the CHILD only if BOTH: (a) it reads like a child's question-to-mom or a brief reaction, AND (b) it is NOT the presenter explaining/answering/directing. Everything else — explanations, answers (e.g. naming an ingredient), instructions, product praise — is the ADULT "${adult}", even if short.`,
      'PITCH (f0_hz) is a WEAK tie-breaker, asymmetric: a LOW-pitch line (< 245Hz) is NEVER the child (keep it adult). HIGH pitch does NOT imply child — the adult presenter is often animated/high, so do NOT move a high-pitch line to the child unless the CONTENT is clearly a child question/reaction.',
      `Keep EXACTLY the speaker set given (${speakers.join(', ')}). Reassign only when the evidence clearly shows the current label is wrong; when in doubt, prefer the adult "${adult}".`,
      'Output STRICT JSON only: {"segments":[{"i":<int>,"speaker":"<one of the given ids>"}]}. No prose, no fences. Include every input index once.',
    ].join('\n');
    try {
      let res = await post({
        model, temperature: 0.2,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ language, speakers, segments: items }) }],
        response_format: { type: 'json_object' },
      });
      if (res.status === 400) res = await post({ model, temperature: 0.2, messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ speakers, segments: items }) }] });
      if (!res.ok) return segments;
      const parsed = JSON.parse(stripFences(JSON.parse(await res.text())?.choices?.[0]?.message?.content ?? '{}'));
      const valid = new Set(speakers);
      const fix = new Map((parsed.segments || []).filter((o) => Number.isFinite(o?.i) && valid.has(o.speaker)).map((o) => [o.i, o.speaker]));
      return segments.map((s, i) => (fix.has(i) ? { ...s, speaker: fix.get(i) } : s));
    } catch {
      return segments;
    }
  }

  return { kind: 'aurixel-translate', translate, condense, expand, refineSpeakers };
}
