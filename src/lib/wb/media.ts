import { wbFetch, type WbCtx } from "./client";

/**
 * Attach media by raw bytes — one file per request. No public hosting needed,
 * so this is the default for a self-hosted generator.
 * Headers: X-Nm-Id, X-Photo-Number (1-based). multipart field name: uploadfile.
 */
export async function uploadMediaBytes(
  ctx: WbCtx,
  nmID: number,
  photoNumber: number,
  buffer: Buffer,
  filename = "photo.jpg",
  contentType = "image/jpeg"
): Promise<void> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: contentType });
  form.append("uploadfile", blob, filename);

  await wbFetch({
    token: ctx.token,
    sandbox: ctx.sandbox,
    method: "POST",
    path: "/content/v3/media/file",
    raw: form,
    headers: {
      "X-Nm-Id": String(nmID),
      "X-Photo-Number": String(photoNumber),
    },
    timeoutMs: 60_000,
  });
}

/**
 * Attach media by public URLs. Field is `nmId` (lowercase d). The whole set is
 * REPLACED, so pass all desired URLs together.
 */
export async function saveMediaByUrls(
  ctx: WbCtx,
  nmID: number,
  urls: string[]
): Promise<void> {
  await wbFetch({
    token: ctx.token,
    sandbox: ctx.sandbox,
    method: "POST",
    path: "/content/v3/media/save",
    body: { nmId: nmID, data: urls },
    timeoutMs: 60_000,
  });
}
