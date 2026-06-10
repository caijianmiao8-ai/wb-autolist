import { NextResponse } from "next/server";
import { getListing, deleteListing } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const listing = getListing(params.id);
  if (!listing) return NextResponse.json({ error: "未找到" }, { status: 404 });
  return NextResponse.json(listing);
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const ok = deleteListing(params.id);
  return NextResponse.json({ ok });
}
