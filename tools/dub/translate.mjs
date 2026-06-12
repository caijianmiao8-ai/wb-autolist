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
  const base = (cfg.baseUrl || 'https://conduit-api.aurixel.ai/v1').replace(/\/$/, '');
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

  return { kind: 'aurixel-translate', translate };
}
