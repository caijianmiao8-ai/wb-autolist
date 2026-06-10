import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { generateListing } from "@/lib/generate";
import { saveListing } from "@/lib/store";
import type { ListingInput } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<ListingInput>;
    const productName = (body.productName ?? "").trim();
    if (!productName) {
      return NextResponse.json({ error: "请填写商品名" }, { status: 400 });
    }
    const input: ListingInput = {
      productName,
      keywords: (body.keywords ?? [])
        .map((k) => String(k).trim())
        .filter(Boolean)
        .slice(0, 20),
      price: Number(body.price) > 0 ? Number(body.price) : 1990,
      discount: Math.max(0, Math.min(99, Number(body.discount) || 0)),
      brand: body.brand?.trim() || undefined,
    };

    const cfg = getConfig();
    const listing = await generateListing(cfg, input);
    saveListing(listing);
    return NextResponse.json(listing);
  } catch (e) {
    const message = e instanceof Error ? e.message : "生成失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
