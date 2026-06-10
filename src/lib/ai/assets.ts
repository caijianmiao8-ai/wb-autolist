import fs from "node:fs";
import path from "node:path";
import { IMAGES_DIR, ensureDataDirs } from "../paths";
import { newId } from "../util";
import type { GeneratedImage } from "../types";

/** Persist an image buffer to disk and return a public-servable descriptor. */
export function saveImage(
  buffer: Buffer,
  meta: {
    kind: GeneratedImage["kind"];
    prompt: string;
    width: number;
    height: number;
    ext?: string;
  }
): GeneratedImage {
  ensureDataDirs();
  const ext = meta.ext ?? "jpg";
  const id = newId("img_");
  const file = `${id}.${ext}`;
  fs.writeFileSync(path.join(IMAGES_DIR, file), buffer);
  return {
    id,
    kind: meta.kind,
    url: `/api/images/${file}`,
    prompt: meta.prompt,
    width: meta.width,
    height: meta.height,
  };
}

export function readImage(file: string): Buffer | null {
  // prevent path traversal — only allow bare filenames
  const safe = path.basename(file);
  const p = path.join(IMAGES_DIR, safe);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

export function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

/** Absolute public URL for WB to fetch (media/save needs a reachable URL). */
export function publicUrl(baseUrl: string, relativeUrl: string): string {
  if (!baseUrl) return relativeUrl;
  return baseUrl.replace(/\/+$/, "") + relativeUrl;
}
