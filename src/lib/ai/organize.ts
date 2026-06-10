import type { AppConfig } from "../config";
import type { ListingInput } from "../types";

const ORGANIZE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          productName: { type: "string", description: "商品名（任意语言原样保留）" },
          keywords: { type: "array", items: { type: "string" }, description: "关键字/卖点，从属性列提取" },
          price: { type: "number", description: "价格(数字，卢布)；无则 0" },
          discount: { type: "number", description: "折扣百分比(0-99)；无则 0" },
          brand: { type: "string", description: "品牌；无则空字符串" },
        },
        required: ["productName", "keywords", "price", "discount", "brand"],
      },
    },
  },
  required: ["products"],
} as const;

/**
 * Turn a raw spreadsheet (rows of cells, columns possibly unlabeled / any
 * language / out of order) into structured product inputs. Uses the configured
 * Aurixel chat model; falls back to a heuristic mapping without a key.
 */
export async function organizeRows(
  cfg: AppConfig,
  rows: string[][]
): Promise<ListingInput[]> {
  const trimmed = rows.filter((r) => r.some((c) => c.trim()));
  if (!trimmed.length) return [];

  if (cfg.aurixelApiKey) {
    try {
      return await organizeWithAurixel(cfg, trimmed);
    } catch (e) {
      console.error("Excel organize via LLM failed, using heuristic:", e);
    }
  }
  return heuristicOrganize(trimmed);
}

async function organizeWithAurixel(
  cfg: AppConfig,
  rows: string[][]
): Promise<ListingInput[]> {
  const res = await fetch("https://conduit-api.aurixel.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.aurixelApiKey}`,
    },
    body: JSON.stringify({
      model: cfg.aurixelChatModel || "gpt-5.5",
      messages: [
        {
          role: "system",
          content:
            "You normalize messy product spreadsheets into structured rows. JSON only.",
        },
        {
          role: "user",
          content:
            "下面是一个商品表格（可能含表头，列顺序/语言/标签不固定）。把每个商品行整理成结构化字段：" +
            "productName(商品名), keywords(关键字数组), price(数字,无则0), discount(0-99,无则0), brand(无则空)。" +
            "智能识别哪一列是名称/价格/折扣/品牌，其余有用文本归入 keywords。跳过表头行。\n\n表格(JSON):\n" +
            JSON.stringify(rows).slice(0, 12000),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "products", strict: true, schema: ORGANIZE_SCHEMA },
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  const content = json.choices?.[0]?.message?.content ?? "{}";
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  const parsed = JSON.parse(content.slice(start, end + 1)) as {
    products: ListingInput[];
  };
  return (parsed.products || []).map(clean).filter((p) => p.productName);
}

/** No-LLM fallback: first non-numeric cell = name, first numeric = price, rest = keywords. */
function heuristicOrganize(rows: string[][]): ListingInput[] {
  // drop a header row if its cells are mostly non-numeric labels and short
  const looksHeader =
    rows.length > 1 && rows[0].every((c) => c && isNaN(Number(c)) && c.length < 20);
  const body = looksHeader ? rows.slice(1) : rows;

  return body
    .map((r) => {
      const cells = r.map((c) => c.trim()).filter(Boolean);
      if (!cells.length) return null;
      const nums = cells.filter((c) => /^\d+([.,]\d+)?$/.test(c)).map((c) => Number(c.replace(",", ".")));
      const texts = cells.filter((c) => !/^\d+([.,]\d+)?$/.test(c));
      const productName = texts[0] || cells[0];
      const keywords = texts.slice(1, 9);
      const price = nums.find((n) => n >= 1) ?? 0;
      const discount = nums.find((n) => n > 0 && n <= 99 && n !== price) ?? 0;
      return clean({ productName, keywords, price, discount, brand: "" });
    })
    .filter((p): p is ListingInput => !!p && !!p.productName);
}

function clean(p: ListingInput): ListingInput {
  return {
    productName: String(p.productName || "").trim().slice(0, 200),
    keywords: (p.keywords || []).map((k) => String(k).trim()).filter(Boolean).slice(0, 20),
    price: Number(p.price) > 0 ? Math.round(Number(p.price)) : 0,
    discount: Math.max(0, Math.min(99, Math.round(Number(p.discount) || 0))),
    brand: String(p.brand || "").trim().slice(0, 50) || undefined,
  };
}
