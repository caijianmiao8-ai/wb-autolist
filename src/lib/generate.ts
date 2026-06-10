import type { AppConfig } from "./config";
import type { Listing, ListingInput, GeneratedImage } from "./types";
import { generateCopy } from "./ai/copy";
import { generateImage } from "./ai/image";
import {
  composePromo,
  normalizeMain,
  makePlaceholder,
  deriveDetail,
} from "./ai/banner";
import { saveImage } from "./ai/assets";
import { newId, makeVendorCode, nowIso, originalPrice } from "./util";

/**
 * Full generation step: marketing copy + main/gallery product images + a
 * composed promo banner. Returns a draft Listing (not yet published).
 */
export async function generateListing(
  cfg: AppConfig,
  rawInput: ListingInput
): Promise<Listing> {
  // sanitize — batch/queue calls this directly (not via /api/generate), so a
  // missing/zero price from Excel must still get a sensible default here.
  const input: ListingInput = {
    ...rawInput,
    price: Number(rawInput.price) > 0 ? Math.round(Number(rawInput.price)) : 1990,
    discount: Math.max(0, Math.min(99, Math.round(Number(rawInput.discount) || 0))),
  };

  const copy = await generateCopy(cfg, {
    productName: input.productName,
    keywords: input.keywords,
    brand: input.brand,
  });

  // Always have a strong, specific prompt — model-written if present, else a
  // built one — then append professional-photography qualifiers for top quality.
  const corePrompt =
    (copy.imagePrompt && copy.imagePrompt.trim()) ||
    `professional studio e-commerce product photo of ${input.productName}` +
      (input.keywords.length ? `, ${input.keywords.join(", ")}` : "");
  const QUALITY_SUFFIX =
    ", professional studio product photography, clean white seamless background, " +
    "soft diffused lighting, sharp focus, ultra detailed, high resolution, " +
    "commercial e-commerce hero shot, centered composition";
  const basePrompt = corePrompt + QUALITY_SUFFIX;

  const images: GeneratedImage[] = [];

  // Main product image — 3:4 portrait (WB standard). Single network call;
  // fall back to a branded placeholder so the pipeline always completes.
  let mainBuf: Buffer;
  let aiOk = false;
  try {
    const main = await generateImage(cfg, {
      prompt: basePrompt,
      width: 1024,
      height: 1365,
      seed: 1000,
    });
    mainBuf = await normalizeMain(main.buffer, 1200, 1600);
    aiOk = true;
  } catch (e) {
    console.error("文生图失败，使用占位图:", e);
    mainBuf = await makePlaceholder(input.productName, input.keywords, {
      width: 1200,
      height: 1600,
      variant: 0,
    });
  }
  images.push(
    saveImage(mainBuf, {
      kind: "main",
      prompt: basePrompt,
      width: 1200,
      height: 1600,
      ext: "jpg",
    })
  );

  // Detail shot — derived from the main image (no extra network call)
  try {
    const detailBuf = aiOk
      ? await deriveDetail(mainBuf, 1200, 1600)
      : await makePlaceholder(input.productName, input.keywords, {
          width: 1200,
          height: 1600,
          variant: 1,
        });
    images.push(
      saveImage(detailBuf, {
        kind: "gallery",
        prompt: `${basePrompt} (detail)`,
        width: 1200,
        height: 1600,
        ext: "jpg",
      })
    );
  } catch {
    // gallery is optional
  }

  // Promo banner — composed from the main image. oldPrice = the pre-discount
  // base (same derivation as the WB submission) so banner ↔ WB price agree.
  const oldPrice = input.discount > 0 ? originalPrice(input.price, input.discount) : undefined;
  const promoBuf = await composePromo(mainBuf, {
    title: copy.title,
    subtitle: copy.bullets[0],
    price: input.price,
    oldPrice,
    discount: input.discount || undefined,
    badge: "ХИТ",
    width: 1080,
    height: 1440,
  });
  images.push(
    saveImage(promoBuf, {
      kind: "promo",
      prompt: "promo banner",
      width: 1080,
      height: 1440,
      ext: "jpg",
    })
  );

  const now = nowIso();
  const listing: Listing = {
    id: newId("lst_"),
    createdAt: now,
    updatedAt: now,
    productName: input.productName,
    keywords: input.keywords,
    price: input.price,
    discount: input.discount,
    brand: input.brand || copy.brand,
    copy: {
      title: copy.title,
      description: copy.description,
      bullets: copy.bullets,
      brand: copy.brand,
      keywords: copy.keywords,
      categoryHint: copy.categoryHint,
      imagePrompt: corePrompt,
    },
    images,
    subjectId: null,
    subjectName: null,
    vendorCode: makeVendorCode(input.productName),
    stage: "draft",
    nmID: null,
    imtID: null,
    dryRun: !cfg.wbContentToken,
    sandbox: !!cfg.wbSandbox,
    logs: [],
    error: null,
  };
  return listing;
}
