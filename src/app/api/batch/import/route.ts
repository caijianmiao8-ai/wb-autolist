import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { parseExcel } from "@/lib/excel";
import { organizeRows } from "@/lib/ai/organize";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Upload an .xlsx → parse + LLM-organize into structured product rows (preview). */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "请上传 Excel 文件" }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const rows = await parseExcel(buf);
    if (!rows.length) {
      return NextResponse.json({ error: "未在表格中读到数据" }, { status: 400 });
    }
    const products = await organizeRows(getConfig(), rows);
    return NextResponse.json({ rawCount: rows.length, products });
  } catch (e) {
    const message = e instanceof Error ? e.message : "解析失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
