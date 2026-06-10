import ExcelJS from "exceljs";

/** Flatten any exceljs cell value to plain text. */
function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v).trim();
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("text" in o) return String(o.text).trim();
    if ("result" in o) return String(o.result).trim();
    if ("richText" in o && Array.isArray(o.richText)) {
      return o.richText.map((r: { text?: string }) => r.text ?? "").join("").trim();
    }
    if ("hyperlink" in o) return String(o.text ?? o.hyperlink).trim();
  }
  return "";
}

/**
 * Parse the first worksheet of an .xlsx into a 2D array of cell strings
 * (including the header row). Raw — the LLM organizer maps it to products.
 */
export async function parseExcel(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    // row.values is 1-indexed with a leading empty slot
    const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
    for (const v of vals) cells.push(cellText(v));
    if (cells.some((c) => c !== "")) rows.push(cells);
  });
  return rows.slice(0, 500); // safety cap
}
