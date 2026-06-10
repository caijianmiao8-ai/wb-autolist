import { getConfig } from "@/lib/config";
import { getListing, updateListing } from "@/lib/store";
import { publishListing } from "@/lib/wb/pipeline";

export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * Streams the publish pipeline as Server-Sent Events:
 *   event: progress  data: {stage, ok, message}
 *   event: done      data: {stage, nmID, imtID, dryRun, error}
 */
export async function POST(req: Request) {
  const { id } = (await req.json()) as { id: string };
  const listing = getListing(id);
  if (!listing) {
    return new Response(JSON.stringify({ error: "未找到该商品" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cfg = getConfig();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      // mark queued
      updateListing(id, { stage: "queued", error: null });

      const result = await publishListing(listing, cfg, (p) => {
        send("progress", p);
      });

      // persist final state + logs
      updateListing(id, {
        stage: result.stage,
        nmID: result.nmID,
        imtID: result.imtID,
        subjectId: result.subjectId,
        subjectName: result.subjectName,
        dryRun: result.dryRun,
        sandbox: result.sandbox,
        logs: result.logs,
        error: result.error,
      });

      send("done", {
        stage: result.stage,
        nmID: result.nmID,
        imtID: result.imtID,
        dryRun: result.dryRun,
        sandbox: result.sandbox,
        error: result.error,
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
