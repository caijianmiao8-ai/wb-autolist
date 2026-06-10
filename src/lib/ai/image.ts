import type { AppConfig } from "../config";

export interface GenImageOpts {
  prompt: string;
  width?: number;
  height?: number;
  seed?: number;
}

/**
 * Pluggable text-to-image. Default provider is Pollinations.ai — keyless,
 * free, callable server-side, returns raw image bytes from a GET. OpenAI
 * (gpt-image-1) is an optional higher-quality provider when a key is set.
 */
export async function generateImage(
  cfg: AppConfig,
  opts: GenImageOpts
): Promise<{ buffer: Buffer; contentType: string }> {
  const width = opts.width ?? 1024;
  const height = opts.height ?? 1024;

  if (cfg.imageProvider === "aurixel" && cfg.aurixelApiKey) {
    // Aurixel is an OpenAI-compatible gateway (conduit-api.aurixel.ai/v1)
    return openAICompatibleImage(
      "https://conduit-api.aurixel.ai/v1",
      cfg.aurixelApiKey,
      "gpt-image-2",
      opts.prompt,
      width,
      height
    );
  }
  if (cfg.imageProvider === "openai" && cfg.openaiApiKey) {
    return openAICompatibleImage(
      "https://api.openai.com/v1",
      cfg.openaiApiKey,
      "gpt-image-1",
      opts.prompt,
      width,
      height
    );
  }
  return pollinationsImage(opts.prompt, width, height, opts.seed, cfg.pollinationsToken);
}

async function pollinationsImage(
  prompt: string,
  width: number,
  height: number,
  seed?: number,
  token?: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
  });
  if (seed != null) params.set("seed", String(seed));
  // A registered token lifts the anonymous rate limit and removes the watermark.
  if (token) {
    params.set("nologo", "true");
    params.set("referrer", "wb-autolist");
  }
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(
    prompt
  )}?${params.toString()}`;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  // The anonymous tier is rate-limited (HTTP 402 "queue full"); retry once.
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchWithTimeout(url, { method: "GET", headers }, 90_000);
    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get("content-type") || "image/jpeg";
      if (!contentType.startsWith("image/") || buffer.byteLength < 1024) {
        throw new Error("Pollinations 返回的不是有效图片");
      }
      return { buffer, contentType };
    }
    lastStatus = res.status;
    if (res.status === 402 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 6_000));
      continue;
    }
    break;
  }
  throw new Error(
    lastStatus === 402
      ? "Pollinations 免费层限流(402)。请在设置中配置 Pollinations Token 或改用 OpenAI。"
      : `Pollinations 文生图失败: HTTP ${lastStatus}`
  );
}

/**
 * Generic OpenAI-compatible /images/generations call. Works for OpenAI
 * (gpt-image-1) and Aurixel's gateway (gpt-image-2), which share the same
 * request/response shape (returns b64_json, sometimes url).
 */
async function openAICompatibleImage(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  width: number,
  height: number
): Promise<{ buffer: Buffer; contentType: string }> {
  // gpt-image-* supports 1024x1024, 1024x1536, 1536x1024
  const size =
    width === height
      ? "1024x1024"
      : width > height
      ? "1536x1024"
      : "1024x1536";
  const url = `${baseUrl.replace(/\/+$/, "")}/images/generations`;
  // Retry on 429/5xx — gateways (e.g. Aurixel) rate-limit image generation.
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, prompt, size, n: 1, quality: "high" }),
      },
      120_000
    );
    if (res.ok) {
      const json = (await res.json()) as {
        data: { b64_json?: string; url?: string }[];
      };
      const item = json.data?.[0];
      if (item?.b64_json) {
        return { buffer: Buffer.from(item.b64_json, "base64"), contentType: "image/png" };
      }
      if (item?.url) {
        const img = await fetchWithTimeout(item.url, {}, 60_000);
        return {
          buffer: Buffer.from(await img.arrayBuffer()),
          contentType: img.headers.get("content-type") || "image/png",
        };
      }
      throw new Error(`${model} 未返回图片数据`);
    }
    const text = await res.text();
    lastErr = `HTTP ${res.status} ${text.slice(0, 160)}`;
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 10_000 * (attempt + 1)));
      continue;
    }
    break;
  }
  throw new Error(`文生图失败(${model}): ${lastErr}`);
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}
