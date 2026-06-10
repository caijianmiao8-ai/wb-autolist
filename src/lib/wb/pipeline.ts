import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config";
import { pricesToken } from "../config";
import { IMAGES_DIR } from "../paths";
import type { Listing, StageLog, ListingStage } from "../types";
import type { WbCtx } from "./client";
import { resolveSubject, getCharacteristics, getColors, getTnved } from "./categories";
import { uploadCards, waitForCard } from "./cards";
import { uploadMediaBytes } from "./media";
import { uploadPriceTask, waitForPriceTask } from "./prices";
import type { WbCardUploadItem, WbCharacteristic } from "./wbtypes";
import { generateEan13 } from "./barcode";
import { originalPrice } from "../util";

export interface PublishProgress {
  stage: ListingStage;
  ok: boolean;
  message: string;
  data?: unknown;
}

export type ProgressFn = (p: PublishProgress) => void;

function log(logs: StageLog[], p: PublishProgress, onProgress?: ProgressFn) {
  logs.push({ ts: new Date().toISOString(), ...p });
  onProgress?.(p);
}

export interface PublishResult {
  stage: ListingStage;
  nmID: number | null;
  imtID: number | null;
  subjectId: number | null;
  subjectName: string | null;
  dryRun: boolean;
  sandbox: boolean;
  logs: StageLog[];
  error: string | null;
}

/**
 * Run the full listing pipeline for a (already-generated) draft listing.
 * Without a content token it runs in DRY-RUN: validation + banner files are
 * real, but no WB HTTP happens and a fake nmID is assigned.
 */
export async function publishListing(
  listing: Listing,
  cfg: AppConfig,
  onProgress?: ProgressFn
): Promise<PublishResult> {
  const logs: StageLog[] = [];
  const dryRun =
    process.env.WB_DRY_RUN === "true" || !cfg.wbContentToken;

  const result: PublishResult = {
    stage: "queued",
    nmID: null,
    imtID: null,
    subjectId: listing.subjectId,
    subjectName: listing.subjectName,
    dryRun,
    sandbox: !dryRun && !!cfg.wbSandbox,
    logs,
    error: null,
  };

  try {
    if (!listing.copy) throw new Error("缺少商品文案，请先生成内容。");
    if (!listing.images.length) throw new Error("缺少商品图片，请先生成图片。");

    // ── DRY RUN ───────────────────────────────────────────────
    if (dryRun) {
      return await dryRunPipeline(listing, logs, onProgress);
    }

    const ctx: WbCtx = { token: cfg.wbContentToken, sandbox: cfg.wbSandbox };
    const priceCtx: WbCtx = { token: pricesToken(cfg), sandbox: cfg.wbSandbox };

    // ── Step 1: resolve subject ───────────────────────────────
    log(
      logs,
      { stage: "creating", ok: true, message: cfg.wbSandbox ? "解析商品类目（沙盒）…" : "解析商品类目…" },
      onProgress
    );
    const subject = await resolveSubject(ctx, listing.copy.categoryHint || listing.productName);
    if (!subject) throw new Error(`未能匹配 WB 类目（hint: ${listing.copy.categoryHint}）`);
    result.subjectId = subject.subjectID;
    result.subjectName = subject.subjectName;
    log(
      logs,
      {
        stage: "creating",
        ok: true,
        message: `类目: ${subject.subjectName} (subjectID=${subject.subjectID})`,
      },
      onProgress
    );

    // ── Step 2: characteristics + tnved + colors ──────────────
    const charcs = await getCharacteristics(ctx, subject.subjectID);
    const required = charcs.filter((c) => c.required && c.charcType !== 0);
    const colors = await safe(() => getColors(ctx), []);
    const tnved = await safe(() => getTnved(ctx, subject.subjectID), null);
    const characteristics = buildCharacteristics(required, listing, colors, tnved);
    log(
      logs,
      {
        stage: "creating",
        ok: true,
        message: `填充 ${characteristics.length} 项特征（必填 ${required.length} 项）${tnved ? `, TNVED=${tnved}` : ""}`,
        data: { characteristics },
      },
      onProgress
    );

    // ── Step 3: create card ───────────────────────────────────
    // listing.price = final sell price; WB wants the pre-discount base.
    const discount = Math.max(0, Math.min(99, Math.round(listing.discount)));
    const base = originalPrice(listing.price, discount);
    const sku = generateEan13();
    const card: WbCardUploadItem = {
      subjectID: subject.subjectID,
      variants: [
        {
          vendorCode: listing.vendorCode,
          title: listing.copy.title,
          description: listing.copy.description,
          brand: listing.copy.brand,
          dimensions: { length: 20, width: 15, height: 5, weightBrutto: 0.3 },
          characteristics,
          // Sizeless product: WB rejects techSize/wbSize for безразмерный товар.
          sizes: [{ price: base, skus: [sku] }],
        },
      ],
    };
    await uploadCards(ctx, [card]);
    log(logs, { stage: "creating", ok: true, message: "卡片已提交，等待 WB 分配 nmID…" }, onProgress);

    // ── Step 4: poll for nmID ─────────────────────────────────
    const created = await waitForCard(ctx, listing.vendorCode, {
      onTick: (n) =>
        onProgress?.({ stage: "creating", ok: true, message: `轮询 nmID… (#${n})` }),
    });
    result.nmID = created.nmID;
    result.imtID = created.imtID;
    log(
      logs,
      { stage: "media", ok: true, message: `已创建 nmID=${created.nmID}, imtID=${created.imtID}` },
      onProgress
    );

    // ── Step 5: media (byte upload, one per slot) ─────────────
    const ordered = orderImages(listing);
    let slot = 1;
    for (const img of ordered) {
      const file = path.basename(img.url);
      const buf = fs.readFileSync(path.join(IMAGES_DIR, file));
      await uploadMediaBytes(ctx, created.nmID, slot, buf, file);
      log(
        logs,
        { stage: "media", ok: true, message: `已上传第 ${slot} 张图（${img.kind}）` },
        onProgress
      );
      slot++;
    }

    // ── Step 6: price ─────────────────────────────────────────
    log(logs, { stage: "pricing", ok: true, message: "提交价格任务…" }, onProgress);
    const uploadID = await uploadPriceTask(priceCtx, [
      { nmID: created.nmID, price: base, discount },
    ]);
    const priceStatus = await waitForPriceTask(priceCtx, uploadID);
    const priceOk = priceStatus.status === 3 && priceStatus.success >= priceStatus.total;
    log(
      logs,
      {
        stage: "pricing",
        ok: priceOk,
        message: `价格任务 status=${priceStatus.status} (${priceStatus.success}/${priceStatus.total})`,
      },
      onProgress
    );

    // Card + media succeeded but pricing didn't fully apply → surface as error
    // (card exists at nmID, but it's mispriced/unpriced — needs a price retry).
    if (!priceOk) {
      result.stage = "error";
      result.error = `卡片已建(nmID=${created.nmID})但价格未全部生效(status=${priceStatus.status})，请重试定价。`;
      log(logs, { stage: "error", ok: false, message: result.error }, onProgress);
      return result;
    }

    result.stage = "live";
    log(logs, { stage: "live", ok: true, message: "上架完成（WB 审核后生效）" }, onProgress);
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    result.stage = "error";
    result.error = message;
    log(logs, { stage: "error", ok: false, message }, onProgress);
    return result;
  }
}

// ── DRY RUN simulation ──────────────────────────────────────
async function dryRunPipeline(
  listing: Listing,
  logs: StageLog[],
  onProgress?: ProgressFn
): Promise<PublishResult> {
  const result: PublishResult = {
    stage: "queued",
    nmID: null,
    imtID: null,
    subjectId: null,
    subjectName: listing.copy?.categoryHint ?? null,
    dryRun: true,
    sandbox: false,
    logs,
    error: null,
  };
  log(logs, { stage: "creating", ok: true, message: "【演示模式】校验卡片字段…" }, onProgress);
  // real validation
  const problems = validateListing(listing);
  if (problems.length) {
    result.stage = "error";
    result.error = problems.join("; ");
    log(logs, { stage: "error", ok: false, message: result.error }, onProgress);
    return result;
  }
  log(logs, { stage: "creating", ok: true, message: `【演示】类目 hint: ${listing.copy?.categoryHint}` }, onProgress);
  await sleep(600);
  const hex = (listing.id.replace(/[^0-9a-f]/gi, "") || "0").slice(0, 6);
  const fakeNm = 200000000 + (parseInt(hex, 16) % 9000000);
  result.nmID = fakeNm;
  result.imtID = fakeNm + 1;
  log(logs, { stage: "media", ok: true, message: `【演示】已分配 nmID=${fakeNm}` }, onProgress);
  await sleep(400);
  for (let i = 0; i < listing.images.length; i++) {
    log(logs, { stage: "media", ok: true, message: `【演示】上传第 ${i + 1} 张图` }, onProgress);
  }
  await sleep(300);
  log(logs, { stage: "pricing", ok: true, message: `【演示】价格 ${listing.price}₽ / 折扣 ${listing.discount}%` }, onProgress);
  result.stage = "live";
  log(
    logs,
    {
      stage: "live",
      ok: true,
      message: "演示完成：流程已跑通，未真实上架。",
    },
    onProgress
  );
  return result;
}

function validateListing(listing: Listing): string[] {
  const p: string[] = [];
  if (!listing.copy?.title) p.push("缺少标题");
  if ((listing.copy?.title.length ?? 0) > 60) p.push("标题超过 60 字符");
  if (!listing.copy?.description) p.push("缺少描述");
  if (!listing.images.length) p.push("缺少图片");
  if (!listing.vendorCode) p.push("缺少 vendorCode");
  if (!(listing.price > 0)) p.push("价格必须 > 0");
  return p;
}

// ── helpers ─────────────────────────────────────────────────

/** Best-effort fill of required characteristics from copy + directories. */
function buildCharacteristics(
  required: WbCharacteristic[],
  listing: Listing,
  colors: { name: string }[],
  tnved: string | null
): { id: number; value: string[] | number[] | string | number }[] {
  const out: { id: number; value: string[] | number[] | string | number }[] = [];
  const kw = listing.copy?.keywords ?? [];

  for (const c of required) {
    const nameLc = c.name.toLowerCase();
    // Color
    if (nameLc.includes("цвет")) {
      const matched =
        colors.find((col) => kw.some((k) => col.name.toLowerCase() === k.toLowerCase()))?.name ||
        colors[0]?.name ||
        "разноцветный";
      out.push({ id: c.charcID, value: [matched] });
      continue;
    }
    // TNVED
    if (nameLc.includes("тнвэд") || nameLc.includes("тн вэд")) {
      if (tnved) out.push({ id: c.charcID, value: tnved });
      continue;
    }
    // numeric required
    if (c.charcType === 4) {
      out.push({ id: c.charcID, value: [1] });
      continue;
    }
    // string required → use a keyword or the brand/title fallback
    const val = kw[0] || listing.copy?.brand || listing.productName;
    out.push({ id: c.charcID, value: [val] });
  }

  // TNVED may not be in `required` list but still needed — add if found and not present
  if (tnved && !out.some((o) => required.find((r) => r.charcID === o.id && r.name.toLowerCase().includes("тнвэд")))) {
    // leave as-is; many categories accept TNVED via characteristics only when listed
  }
  return out;
}

function orderImages(listing: Listing) {
  // main first, then promo, then gallery
  const rank = { main: 0, promo: 1, gallery: 2 } as const;
  return [...listing.images].sort((a, b) => rank[a.kind] - rank[b.kind]);
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
