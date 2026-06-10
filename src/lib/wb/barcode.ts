import crypto from "node:crypto";

/**
 * Generate a valid EAN-13 barcode (with correct check digit). WB accepts
 * seller-provided barcodes as a size's SKU. We use the "200" in-store prefix
 * range which is reserved for internal/private use.
 */
export function generateEan13(): string {
  // 12 digits: "20" + 10 random, then compute the 13th check digit
  let digits = "20";
  const rnd = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) digits += String(rnd[i] % 10);
  return digits + ean13CheckDigit(digits);
}

function ean13CheckDigit(twelve: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = twelve.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d : d * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return String(check);
}
