// http.mjs — tiny fetch wrapper: timeout (AbortController), retry/backoff on
// 429/5xx, and robust error surfacing of provider JSON. Zero deps (Node 18+).
//
// NEVER logs auth headers or bodies that could contain secrets.

/** Sleep helper. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with timeout + retry. Returns the Response (caller reads body).
 * Retries only on network error, 429, or 5xx. 4xx (except 429) fail fast.
 *
 * @param {string} url
 * @param {object} init        standard fetch init (headers, method, body)
 * @param {object} [o]
 * @param {number} [o.timeoutMs=120000]
 * @param {number} [o.retries=2]
 * @param {string} [o.label]   for error messages (e.g. 'Scribe STT')
 */
export async function fetchWithRetry(url, init = {}, o = {}) {
  const { timeoutMs = 120000, retries = 2, label = 'request' } = o;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          const backoff = Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
          await sleep(backoff);
          continue;
        }
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const transient = err?.name === 'AbortError' || err?.code === 'ECONNRESET' || /network|fetch failed/i.test(String(err?.message));
      if (attempt < retries && transient) {
        const backoff = Math.min(8000, 500 * 2 ** attempt);
        await sleep(backoff);
        continue;
      }
      throw new Error(`${label} network error: ${err?.message || err}`);
    }
  }
  throw lastErr || new Error(`${label} failed after retries`);
}

/** Read an error Response body and produce a compact, secret-free message. */
export async function errorText(res, label) {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  // Try to surface provider JSON detail compactly.
  let detail = '';
  try {
    const j = JSON.parse(body);
    if (Array.isArray(j?.detail)) {
      // FastAPI/ElevenLabs 422 shape: detail is an array of {loc,msg,type}.
      detail = j.detail.map((d) => `${(d.loc || []).join('.')}: ${d.msg || d.message || JSON.stringify(d)}`).join('; ');
    } else {
      detail = j?.detail?.message || j?.error?.message || j?.message || j?.detail || JSON.stringify(j);
    }
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    // Not JSON — cap the raw body hard so we never spew a huge/opaque payload.
    detail = body ? body.slice(0, 200) : '';
  }
  return `${label} HTTP ${res.status}: ${String(detail).slice(0, 400)}`;
}
