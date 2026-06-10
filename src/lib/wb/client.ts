// Wildberries Supplier/Content API client.
//
// Hosts (as of 2025):
//   content-api.wildberries.ru          — карточки, медиа, категории, характеристики
//   discounts-prices-api.wildberries.ru — цены и скидки
//
// Auth: a seller-generated API token (Настройки → Доступ к API, категория
// "Контент" / "Цены и скидки"). The token is sent verbatim in the
// `Authorization` header (no "Bearer" prefix).

export const WB_HOSTS = {
  content: "https://content-api.wildberries.ru",
  prices: "https://discounts-prices-api.wildberries.ru",
} as const;

/** Sandbox hosts are the prod hosts with `-api` → `-api-sandbox`. */
function applySandbox(url: string, sandbox?: boolean): string {
  if (!sandbox) return url;
  return url.replace("-api.wildberries.ru", "-api-sandbox.wildberries.ru");
}

/** Lightweight call context threaded through the WB modules. */
export interface WbCtx {
  token: string;
  sandbox?: boolean;
}

/**
 * Per-host serial gate. WB's gateway effectively allows only ~1 concurrent
 * request per host (empirically: any burst returns one 200 and the rest 429
 * "too many requests"). So we serialize requests to each host (concurrency 1)
 * with a small gap between them; the 429 retry in wbFetch is the backstop.
 * Module-level singleton shared across all in-flight requests in this process.
 */
class SerialGate {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private gapMs: number) {}
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn());
    // chain the next task to start gapMs after this one settles (ok or error)
    this.tail = run.then(
      () => sleep(this.gapMs),
      () => sleep(this.gapMs)
    );
    return run;
  }
}

// Node's fetch (undici) reuses a keep-alive connection, and WB throttles a
// reused connection hard: ~300ms spacing alternates 200/429, ~800ms is clean.
// So we space serialized requests ≥900ms (empirically safe).
const GATES: Record<keyof typeof WB_HOSTS, SerialGate> = {
  content: new SerialGate(900),
  prices: new SerialGate(900),
};

export class WbApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "WbApiError";
    this.status = status;
    this.body = body;
  }
}

interface WbRequest {
  token: string;
  sandbox?: boolean;
  method?: "GET" | "POST" | "PUT";
  path: string;
  host?: keyof typeof WB_HOSTS;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** raw body (e.g. multipart) — when set, body/json handling is skipped */
  raw?: BodyInit;
}

function buildUrl(req: WbRequest): string {
  const base = applySandbox(WB_HOSTS[req.host ?? "content"], req.sandbox);
  const url = new URL(base + req.path);
  if (req.query) {
    for (const [k, v] of Object.entries(req.query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Core request with auth, JSON handling, timeout, and one automatic retry on
 * 429 / 5xx (WB rate-limits aggressively).
 */
export async function wbFetch<T = unknown>(req: WbRequest): Promise<T> {
  const url = buildUrl(req);

  let attempt = 0;
  // Default to "Bearer <token>" (current docs). On a 401 we retry once with the
  // raw token (no prefix) — some legacy endpoints only accept that form.
  let useBearer = true;

  // up to 3 tries with backoff
  while (true) {
    attempt++;
    const headers: Record<string, string> = {
      Authorization: useBearer ? `Bearer ${req.token}` : req.token,
      ...req.headers,
    };
    const init: RequestInit = { method: req.method ?? "GET", headers };
    if (req.raw !== undefined) {
      init.body = req.raw;
    } else if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(req.body);
    }
    let res: Response;
    try {
      // serialize per-host so concurrent publishes don't trip WB's ~1-concurrent
      // limit; the abort timeout starts only once the fetch actually begins (not
      // while queued), so queue wait never counts against the request timeout.
      res = await GATES[req.host ?? "content"].schedule(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 30_000);
        try {
          return await fetch(url, { ...init, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (e) {
      if (attempt < 3) {
        await sleep(attempt * 800);
        continue;
      }
      throw new WbApiError(
        `Сетевая ошибка при запросе ${req.path}: ${(e as Error).message}`,
        0,
        null
      );
    }

    const text = await res.text();
    const json = safeJson(text);

    // one-time fallback: Bearer rejected -> retry raw
    if (res.status === 401 && useBearer) {
      useBearer = false;
      attempt--; // don't consume an attempt for the auth-form switch
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) {
        const retryAfter = Number(res.headers.get("retry-after")) || attempt * 2;
        await sleep(retryAfter * 1000);
        continue;
      }
    }

    if (!res.ok) {
      const msg =
        (json && (json.errorText || json.detail || json.title || json.message)) ||
        `HTTP ${res.status}`;
      throw new WbApiError(`WB API ${req.path}: ${msg}`, res.status, json ?? text);
    }

    // WB content API often wraps errors in a 200 with {error:true,errorText}
    if (json && typeof json === "object" && json.error === true) {
      throw new WbApiError(
        `WB API ${req.path}: ${json.errorText || "ошибка"}`,
        res.status,
        json
      );
    }

    return (json ?? (text as unknown)) as T;
  }
}

/** Validate a token quickly via a cheap content endpoint (ping). */
export async function pingContent(token: string): Promise<boolean> {
  try {
    await wbFetch({
      token,
      method: "GET",
      path: "/ping",
      host: "content",
      timeoutMs: 12_000,
    });
    return true;
  } catch (e) {
    if (e instanceof WbApiError && e.status === 401) return false;
    // /ping may not exist on all hosts; treat non-401 as "reachable"
    if (e instanceof WbApiError && e.status !== 0) return true;
    return false;
  }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
