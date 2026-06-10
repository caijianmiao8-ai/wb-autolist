import { readImage, contentTypeFor } from "@/lib/ai/assets";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: { file: string } }
) {
  const buf = readImage(params.file);
  if (!buf) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": contentTypeFor(params.file),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
