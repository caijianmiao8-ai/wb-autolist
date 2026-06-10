import { wbFetch, type WbCtx } from "./client";
import type { WbSubject, WbCharacteristic, WbColor } from "./wbtypes";

// In-process caches: WB category/dictionary data changes rarely, and concurrent
// publishes of the same product type would otherwise repeat identical lookups
// and burn the rate limit. Keyed by sandbox flag where relevant.
const subjectCache = new Map<string, WbSubject[]>();
const charcsCache = new Map<string, WbCharacteristic[]>();
const tnvedCache = new Map<string, string | null>();
let colorsCache: WbColor[] | null = null;
const ck = (ctx: WbCtx, k: string) => `${ctx.sandbox ? "s" : "p"}:${k}`;

/**
 * Search WB subjects (leaf categories) by name. Returns the best matches with
 * their subjectID — required for card creation. Cached per query.
 */
export async function searchSubjects(
  ctx: WbCtx,
  name: string,
  limit = 20
): Promise<WbSubject[]> {
  const key = ck(ctx, `subj:${name.toLowerCase()}`);
  const hit = subjectCache.get(key);
  if (hit) return hit;
  const res = await wbFetch<{ data: WbSubject[] }>({
    token: ctx.token,
    sandbox: ctx.sandbox,
    method: "GET",
    path: "/content/v2/object/all",
    query: { name, limit, offset: 0, locale: "ru" },
  });
  const data = res.data ?? [];
  subjectCache.set(key, data);
  return data;
}

/**
 * Resolve a free-text category hint to a single best subjectID.
 * Strategy: exact (case-insensitive) match → startsWith → first result.
 */
export async function resolveSubject(
  ctx: WbCtx,
  hint: string
): Promise<WbSubject | null> {
  const q = hint.trim();
  if (!q) return null;

  // Collect candidates: full-phrase search, then per-word search. WB's
  // object/all does a substring match over subjectName, so a verbose hint like
  // "Беспроводные наушники" returns nothing — but searching each word ("наушники")
  // finds the canonical subject "Наушники".
  const seen = new Map<number, WbSubject>();
  const add = (list: WbSubject[]) =>
    list.forEach((s) => seen.has(s.subjectID) || seen.set(s.subjectID, s));

  add(await searchSubjects(ctx, q, 50));

  const words = q
    .split(/[\s,，/]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, 2); // cap to 2 word-searches to limit request count
  for (const w of words) {
    if (seen.size >= 40) break;
    add(await searchSubjects(ctx, w, 30));
  }

  return pickBest([...seen.values()], q, words);
}

/** Score candidates against the hint with bidirectional + token matching. */
function tok(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s,，/()-]+/)
    .map((w) => w.replace(/[^a-zа-я0-9ё]/gi, ""))
    .filter((w) => w.length >= 3);
}

/** Crude stem match: equal, or share a 4+ char prefix (handles ru declensions). */
function stemEq(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length, 5);
  return n >= 4 && a.slice(0, n) === b.slice(0, n);
}

/**
 * Score candidates against the hint. Prioritizes the HEAD NOUN (first content
 * word, which in Russian carries the product type) so a "коврик" maps to a
 * "Коврики …" subject rather than a "Блоки для йоги" that only shares "йоги".
 */
function pickBest(
  list: WbSubject[],
  q: string,
  _words: string[]
): WbSubject | null {
  if (!list.length) return null;
  const lower = q.toLowerCase();
  const qWords = tok(q);
  const head = qWords[0];

  let best: WbSubject | null = null;
  let bestScore = -1;
  for (const s of list) {
    const name = s.subjectName.toLowerCase();
    const nWords = tok(name);
    if (!nWords.length) continue;

    let score: number;
    if (name === lower) {
      score = 1000;
    } else {
      const covered = nWords.filter((n) => qWords.some((w) => stemEq(w, n)));
      const coverage = covered.length / nWords.length; // how much of candidate the hint covers
      const headInName = head ? nWords.some((n) => stemEq(n, head)) : false;
      const headIsHead = head && nWords[0] ? stemEq(nWords[0], head) : false;
      score =
        coverage * 40 +
        (lower.includes(name) ? 30 : 0) + // candidate phrase ⊆ hint
        (headInName ? 35 : 0) + // product head noun present in candidate
        (headIsHead ? 20 : 0) + // …and it's the candidate's head noun too
        covered.length * 4 -
        name.length * 0.05; // tie-break toward shorter/canonical names
    }
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return bestScore > 0 ? best : list[0];
}

export async function getCharacteristics(
  ctx: WbCtx,
  subjectId: number
): Promise<WbCharacteristic[]> {
  const key = ck(ctx, `charcs:${subjectId}`);
  const hit = charcsCache.get(key);
  if (hit) return hit;
  const res = await wbFetch<{ data: WbCharacteristic[] }>({
    token: ctx.token,
    sandbox: ctx.sandbox,
    method: "GET",
    path: `/content/v2/object/charcs/${subjectId}`,
    query: { locale: "ru" },
  });
  const data = res.data ?? [];
  charcsCache.set(key, data);
  return data;
}

export async function getColors(ctx: WbCtx): Promise<WbColor[]> {
  if (colorsCache) return colorsCache;
  const res = await wbFetch<{ data: WbColor[] }>({
    token: ctx.token,
    sandbox: ctx.sandbox,
    method: "GET",
    path: "/content/v2/directory/colors",
    query: { locale: "ru" },
  });
  colorsCache = res.data ?? [];
  return colorsCache;
}

/** Find a TNVED (customs) code for a subject — required for some categories. */
export async function getTnved(
  ctx: WbCtx,
  subjectId: number,
  search?: string
): Promise<string | null> {
  const key = ck(ctx, `tnved:${subjectId}`);
  if (tnvedCache.has(key)) return tnvedCache.get(key) ?? null;
  const res = await wbFetch<{ data: { tnved: string }[] }>({
    token: ctx.token,
    sandbox: ctx.sandbox,
    method: "GET",
    path: "/content/v2/directory/tnved",
    query: { subjectID: subjectId, search, locale: "ru" },
  });
  const val = res.data?.[0]?.tnved ?? null;
  tnvedCache.set(key, val);
  return val;
}
