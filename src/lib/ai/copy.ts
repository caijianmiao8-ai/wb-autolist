import type { AppConfig } from "../config";
import type { ProductCopy } from "../types";
import { clampLen } from "../util";

const COPY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: {
      type: "string",
      description: "Продающий заголовок товара для карточки WB, до 60 символов",
    },
    description: {
      type: "string",
      description: "SEO-описание товара на русском, 600-1500 символов, с ключевыми словами",
    },
    bullets: {
      type: "array",
      items: { type: "string" },
      description: "4-6 ключевых преимуществ товара (буллеты) на русском",
    },
    brand: { type: "string", description: "Короткое название бренда (латиница)" },
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "8-15 поисковых ключевых слов на русском",
    },
    categoryHint: {
      type: "string",
      description: "Точное название категории/предмета WB на русском (например: 'Платья', 'Наушники')",
    },
    imagePrompt: {
      type: "string",
      description:
        "MUST be in ENGLISH. A rich, detailed prompt for a professional studio e-commerce product photo of THIS specific product: describe the product, materials, color, key features, camera angle, lighting and a clean white/seamless background. 1-3 sentences, never empty.",
    },
  },
  required: [
    "title",
    "description",
    "bullets",
    "brand",
    "keywords",
    "categoryHint",
    "imagePrompt",
  ],
} as const;

export interface CopyResult extends ProductCopy {
  imagePrompt: string;
}

/**
 * Generate Wildberries-ready copy (Russian) from a product name + keywords.
 * Uses the configured Aurixel chat model (same key as image generation); falls
 * back to a deterministic template so the pipeline always works.
 */
export async function generateCopy(
  cfg: AppConfig,
  input: { productName: string; keywords: string[]; brand?: string }
): Promise<CopyResult> {
  if (cfg.aurixelApiKey) {
    try {
      return await generateWithAurixel(
        cfg.aurixelApiKey,
        cfg.aurixelChatModel || "gpt-5.5",
        input
      );
    } catch (e) {
      console.error("Aurixel copy generation failed, using template:", e);
    }
  }
  return templateCopy(input);
}

const PROMPT = (input: { productName: string; keywords: string[]; brand?: string }) =>
  `Ты — эксперт по карточкам товаров на маркетплейсе Wildberries. ` +
  `Создай продающий контент и верни СТРОГО валидный JSON с полями: ` +
  `title (заголовок ≤60 символов), description (SEO-описание на русском 600-1500 символов), ` +
  `bullets (массив 4-6 преимуществ), brand (латиница), keywords (массив 8-15 ключевых слов на русском), ` +
  `categoryHint (точное название категории/предмета Wildberries на русском, напр. "Наушники", "Платья"), ` +
  `imagePrompt (detailed ENGLISH prompt for a professional studio product photo).\n\n` +
  `Товар (может быть на любом языке): ${input.productName}\n` +
  `Ключевые слова: ${input.keywords.join(", ")}\n` +
  (input.brand ? `Бренд: ${input.brand}\n` : "");

/** Generate copy via Aurixel's OpenAI-compatible chat gateway (one key for all). */
async function generateWithAurixel(
  apiKey: string,
  model: string,
  input: { productName: string; keywords: string[]; brand?: string }
): Promise<CopyResult> {
  const res = await fetch("https://conduit-api.aurixel.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You write Wildberries marketplace product listings in Russian. Respond with valid JSON only.",
        },
        { role: "user", content: PROMPT(input) },
      ],
      // Strict structured output guarantees every field (incl. imagePrompt).
      response_format: {
        type: "json_schema",
        json_schema: { name: "wb_listing", strict: true, schema: COPY_SCHEMA },
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    throw new Error(`Aurixel chat 失败: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  const content = json.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(extractJson(content)) as CopyResult;
  const result = normalize(parsed, input);

  // Reliability guarantee: the combined call sometimes returns an empty
  // imagePrompt (strict schema enforces the type, not non-emptiness). When that
  // happens, get a rich English prompt from a focused single-field call.
  if (!result.imagePrompt || result.imagePrompt.trim().length < 25) {
    try {
      result.imagePrompt = await aurixelImagePrompt(apiKey, model, input, result);
    } catch (e) {
      console.error("imagePrompt 补齐失败（将用兜底提示）:", e);
    }
  }
  return result;
}

/** Focused call that returns ONLY a rich English image prompt — far more
 * reliable than relying on the combined-copy call's imagePrompt field. */
async function aurixelImagePrompt(
  apiKey: string,
  model: string,
  input: { productName: string; keywords: string[] },
  copy: CopyResult
): Promise<string> {
  const res = await fetch("https://conduit-api.aurixel.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "You write detailed English prompts for AI product photography. JSON only.",
        },
        {
          role: "user",
          content:
            `Write a rich, detailed ENGLISH prompt for a professional studio e-commerce ` +
            `product photo of THIS product. Describe the product, materials, color, key ` +
            `features, camera angle, lighting, and a clean white seamless background.\n` +
            `Product: ${input.productName}\n` +
            `Keywords: ${input.keywords.join(", ")}\n` +
            `Listing title (ru): ${copy.title}\n` +
            `Category (ru): ${copy.categoryHint}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "image_prompt",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { imagePrompt: { type: "string" } },
            required: ["imagePrompt"],
          },
        },
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { choices: { message: { content: string } }[] };
  const obj = JSON.parse(extractJson(j.choices?.[0]?.message?.content ?? "{}"));
  const p = String(obj.imagePrompt || "").trim();
  if (!p) throw new Error("empty");
  return p;
}

/** Pull the first {...} JSON object out of an LLM response (strips fences). */
function extractJson(s: string): string {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}

function templateCopy(input: {
  productName: string;
  keywords: string[];
  brand?: string;
}): CopyResult {
  const name = input.productName.trim();
  const kw = input.keywords.filter(Boolean);
  const brand = input.brand?.trim() || "AUTO";
  const title = clampLen(
    [name, ...kw.slice(0, 2)].filter(Boolean).join(" "),
    60
  );
  const bullets = [
    `Высокое качество — ${name}`,
    ...kw.slice(0, 4).map((k) => `Преимущество: ${k}`),
    "Быстрая доставка Wildberries",
  ].slice(0, 6);
  const description =
    `${name} — отличный выбор для тех, кто ценит качество. ` +
    (kw.length ? `Ключевые особенности: ${kw.join(", ")}. ` : "") +
    `Товар сочетает функциональность и привлекательный дизайн. ` +
    `Закажите ${name} на Wildberries с быстрой доставкой.`;
  return normalize(
    {
      title,
      description,
      bullets,
      brand,
      keywords: kw.length ? kw : [name],
      categoryHint: name,
      imagePrompt: `professional studio e-commerce product photo of ${name}${
        kw.length ? ", " + kw.join(", ") : ""
      }, white background, soft lighting, high detail, centered`,
    },
    input
  );
}

function normalize(c: CopyResult, input: { brand?: string }): CopyResult {
  return {
    title: clampLen(c.title || "", 60),
    description: clampLen(c.description || "", 2000),
    bullets: (c.bullets || []).slice(0, 6),
    brand: (input.brand || c.brand || "AUTO").slice(0, 50),
    keywords: (c.keywords || []).slice(0, 20),
    categoryHint: c.categoryHint || "",
    imagePrompt: c.imagePrompt || "",
  };
}
