import path from "node:path";
import fs from "node:fs";

/**
 * All mutable runtime state lives under the data dir. Relocatable via
 * WB_DATA_DIR so a packaged desktop app can write to the user-data folder
 * (the app bundle itself is read-only). Defaults to ./data for server/dev.
 */
export const DATA_DIR = process.env.WB_DATA_DIR || path.join(process.cwd(), "data");
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const LISTINGS_PATH = path.join(DATA_DIR, "listings.json");
export const QUEUE_PATH = path.join(DATA_DIR, "queue.json");
export const IMAGES_DIR = path.join(DATA_DIR, "images");

export function ensureDataDirs() {
  for (const dir of [DATA_DIR, IMAGES_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

/** Atomic write: write to a temp file then rename (same-dir rename is atomic),
 * so a crash/power-loss mid-write can't truncate the real file. */
export function atomicWrite(file: string, data: string) {
  ensureDataDirs();
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Move a corrupt/unparseable file aside instead of silently overwriting it,
 * so existing data (keys, history) is recoverable. */
export function quarantineCorrupt(file: string) {
  try {
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    /* ignore */
  }
}
