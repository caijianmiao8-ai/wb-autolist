import { NextResponse } from "next/server";
import { listJobs, enqueue, clearJobs, resumeWorkerIfNeeded } from "@/lib/queue";
import type { ListingInput } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  resumeWorkerIfNeeded();
  return NextResponse.json(listJobs());
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    rows?: ListingInput[];
    autoPublish?: boolean;
  };
  const rows = (body.rows ?? []).filter((r) => r && r.productName?.trim());
  if (!rows.length) {
    return NextResponse.json({ error: "没有可入队的商品行" }, { status: 400 });
  }
  const added = enqueue(rows, !!body.autoPublish);
  return NextResponse.json({ added: added.length, jobs: listJobs() });
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const which = searchParams.get("which") === "all" ? "all" : "finished";
  clearJobs(which);
  return NextResponse.json({ ok: true, jobs: listJobs() });
}
