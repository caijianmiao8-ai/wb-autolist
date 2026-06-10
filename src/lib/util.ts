import crypto from "node:crypto";

export function newId(prefix = ""): string {
  return prefix + crypto.randomBytes(8).toString("hex");
}

/** Latin-only, uppercase vendor code WB accepts as the seller SKU. */
export function makeVendorCode(productName: string): string {
  const base = productName
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase()
    .slice(0, 24);
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${base || "ITEM"}-${rand}`;
}

export function clampLen(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The user enters the FINAL price the buyer should pay. WB stores a pre-discount
 * base price and the buyer pays base×(1-discount). So the base we submit (and
 * show struck-through) is finalPrice / (1-discount). Keeps the card price, the
 * price-task and the promo banner all consistent with the intended sell price.
 */
export function originalPrice(finalPrice: number, discountPct: number): number {
  const d = Math.max(0, Math.min(99, discountPct || 0));
  if (d <= 0) return Math.round(finalPrice);
  return Math.round(finalPrice / (1 - d / 100));
}
