import sharp from "sharp";

export interface PromoSpec {
  title: string;
  subtitle?: string;
  price?: number; // RUB
  oldPrice?: number;
  discount?: number; // %
  badge?: string; // e.g. "ХИТ", "NEW"
  width?: number;
  height?: number;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wrap text into N lines that fit a rough character budget per line. */
function wrap(text: string, perLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > perLine) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
    if (lines.length >= maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{1}$/, "…");
  }
  return lines;
}

/**
 * Compose a marketing/promo banner: take an AI product image, darken with a
 * gradient and overlay title + price tag + discount badge via an SVG layer.
 * Pure sharp — no native canvas build required.
 */
export async function composePromo(
  base: Buffer,
  spec: PromoSpec
): Promise<Buffer> {
  const W = spec.width ?? 1080;
  const H = spec.height ?? 1440;

  const bg = await sharp(base)
    .resize(W, H, { fit: "cover", position: "attention" })
    .toBuffer();

  const titleLines = wrap(spec.title, 20, 2);
  const priceY = H - 56;
  const titleBottomY = H - 132;
  const titleStartY = titleBottomY - (titleLines.length - 1) * 58;
  const subtitleY = titleStartY - 52;

  const priceBlock =
    spec.price != null
      ? `
      <g transform="translate(${W - 60}, 70)">
        ${
          spec.discount
            ? `<g transform="translate(-150,-30)">
                 <rect x="0" y="0" rx="14" ry="14" width="150" height="58" fill="#cb11ab"/>
                 <text x="75" y="40" font-size="34" font-weight="800" fill="#fff" text-anchor="middle" font-family="Arial, sans-serif">-${spec.discount}%</text>
               </g>`
            : ""
        }
      </g>`
      : "";

  const priceTag =
    spec.price != null
      ? `
      <g transform="translate(60, ${priceY})">
        <text x="0" y="0" font-size="60" font-weight="900" fill="#fff" font-family="Arial, sans-serif">${esc(
          formatRub(spec.price)
        )}</text>
        ${
          spec.oldPrice && spec.oldPrice > spec.price
            ? `<text x="${
                formatRub(spec.price).length * 34 + 24
              }" y="-6" font-size="30" fill="#cbd5e1" text-decoration="line-through" font-family="Arial, sans-serif">${esc(
                formatRub(spec.oldPrice)
              )}</text>`
            : ""
        }
      </g>`
      : "";

  const badge = spec.badge
    ? `<g transform="translate(60, 60)">
         <rect x="0" y="0" rx="10" ry="10" width="${
           28 + spec.badge.length * 22
         }" height="52" fill="#ffffff"/>
         <text x="${
           14 + (spec.badge.length * 22) / 2
         }" y="36" font-size="30" font-weight="800" fill="#cb11ab" text-anchor="middle" font-family="Arial, sans-serif">${esc(
        spec.badge
      )}</text>
       </g>`
    : "";

  const svg = `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(12,9,24,0.0)"/>
        <stop offset="45%" stop-color="rgba(12,9,24,0.0)"/>
        <stop offset="72%" stop-color="rgba(12,9,24,0.55)"/>
        <stop offset="100%" stop-color="rgba(12,9,24,0.95)"/>
      </linearGradient>
      <linearGradient id="top" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(12,9,24,0.55)"/>
        <stop offset="100%" stop-color="rgba(12,9,24,0.0)"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#shade)"/>
    <rect width="${W}" height="180" fill="url(#top)"/>
    ${badge}
    ${priceBlock}
    ${
      spec.subtitle
        ? `<text x="62" y="${subtitleY}" font-size="30" font-weight="600" fill="#f3c6e8" font-family="Arial, sans-serif">${esc(
            spec.subtitle.slice(0, 34)
          )}</text>`
        : ""
    }
    ${titleLines
      .map(
        (line, i) =>
          `<text x="60" y="${titleStartY + i * 58}" font-size="54" font-weight="800" fill="#ffffff" font-family="Arial, sans-serif">${esc(
            line
          )}</text>`
      )
      .join("")}
    ${priceTag}
  </svg>`;

  return sharp(bg)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** Normalize any AI image to a clean WB-compliant main photo (3:4, JPEG). */
export async function normalizeMain(
  base: Buffer,
  w = 1200,
  h = 1600
): Promise<Buffer> {
  return sharp(base)
    .resize(w, h, { fit: "cover", position: "attention" })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 92 })
    .toBuffer();
}

function formatRub(n: number): string {
  return new Intl.NumberFormat("ru-RU").format(Math.round(n)) + " ₽";
}

/**
 * Zero-config fallback: a branded gradient "product" image with the product
 * name, used when no AI image provider is available. Keeps the whole pipeline
 * runnable without any API key.
 */
export async function makePlaceholder(
  productName: string,
  keywords: string[],
  opts: { width?: number; height?: number; variant?: number } = {}
): Promise<Buffer> {
  const W = opts.width ?? 1200;
  const H = opts.height ?? 1600;
  const hue = ((opts.variant ?? 0) * 47) % 360;
  const nameLines = wrap(productName, 14, 3);
  const startY = H / 2 - (nameLines.length * 78) / 2;

  const svg = `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="hsl(${300 + hue / 6},70%,22%)"/>
        <stop offset="100%" stop-color="hsl(${270 + hue / 6},60%,12%)"/>
      </linearGradient>
      <radialGradient id="glow" cx="50%" cy="38%" r="60%">
        <stop offset="0%" stop-color="rgba(233,30,140,0.35)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>
    <circle cx="${W / 2}" cy="${H * 0.36}" r="${W * 0.16}" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="3"/>
    <text x="${W / 2}" y="${H * 0.37}" font-size="120" text-anchor="middle" fill="rgba(255,255,255,0.9)" font-family="Arial, sans-serif">★</text>
    ${nameLines
      .map(
        (line, i) =>
          `<text x="${W / 2}" y="${startY + i * 78}" font-size="64" font-weight="800" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif">${esc(
            line
          )}</text>`
      )
      .join("")}
    <text x="${W / 2}" y="${startY + nameLines.length * 78 + 56}" font-size="34" text-anchor="middle" fill="#e2c8ef" font-family="Arial, sans-serif">${esc(
      keywords.slice(0, 4).join(" · ")
    )}</text>
    <text x="${W / 2}" y="${H - 60}" font-size="26" text-anchor="middle" fill="rgba(255,255,255,0.45)" font-family="Arial, sans-serif">AI 占位图 · 配置图像 API 后生成真实产品图</text>
  </svg>`;

  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

/** Derive a "detail" shot from a base image (zoom + crop) — no network call. */
export async function deriveDetail(
  base: Buffer,
  w = 1200,
  h = 1600
): Promise<Buffer> {
  const meta = await sharp(base).metadata();
  const bw = meta.width ?? w;
  const bh = meta.height ?? h;
  // center zoom ~1.4x
  const cropW = Math.round(bw / 1.4);
  const cropH = Math.round(bh / 1.4);
  const left = Math.round((bw - cropW) / 2);
  const top = Math.round((bh - cropH) / 3);
  return sharp(base)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(w, h, { fit: "cover" })
    .modulate({ saturation: 1.08, brightness: 1.03 })
    .jpeg({ quality: 92 })
    .toBuffer();
}
