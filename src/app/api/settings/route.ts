import { NextResponse } from "next/server";
import { getConfig, saveConfig, redactConfig } from "@/lib/config";
import type { AppConfig } from "@/lib/config";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(redactConfig(getConfig()));
}

export async function POST(req: Request) {
  const body = (await req.json()) as Partial<AppConfig>;
  // only persist known fields; empty strings are allowed to clear a value
  const patch: Partial<AppConfig> = {};
  const keys: (keyof AppConfig)[] = [
    "wbContentToken",
    "wbPricesToken",
    "wbSandbox",
    "imageProvider",
    "openaiApiKey",
    "aurixelApiKey",
    "aurixelChatModel",
    "pollinationsToken",
    "publicBaseUrl",
  ];
  for (const k of keys) {
    if (k in body && body[k] !== undefined) {
      // @ts-expect-error indexed assignment
      patch[k] = body[k];
    }
  }
  const cfg = saveConfig(patch);
  return NextResponse.json(redactConfig(cfg));
}
