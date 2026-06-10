import { wbFetch, type WbCtx } from "./client";
import type {
  WbCardUploadItem,
  WbCardListItem,
  WbCardError,
  WbCardErrorListResponse,
} from "./wbtypes";

/**
 * Submit new cards. NOTE: body must be a top-level ARRAY. A 200 with
 * error:false only means "queued" — the nmID is assigned asynchronously.
 */
export async function uploadCards(
  ctx: WbCtx,
  items: WbCardUploadItem[]
): Promise<void> {
  await wbFetch({
    token: ctx.token,
    sandbox: ctx.sandbox,
    method: "POST",
    path: "/content/v2/cards/upload",
    body: items,
    timeoutMs: 40_000,
  });
}

/** Look up a card by the seller's vendorCode (textSearch). */
export async function findCardByVendorCode(
  ctx: WbCtx,
  vendorCode: string
): Promise<WbCardListItem | null> {
  const res = await wbFetch<{ cards: WbCardListItem[] }>({
    token: ctx.token,
    sandbox: ctx.sandbox,
    method: "POST",
    path: "/content/v2/get/cards/list",
    body: {
      settings: {
        sort: { ascending: false },
        filter: { withPhoto: -1, textSearch: vendorCode },
        cursor: { limit: 100 },
      },
    },
  });
  const cards = res.cards ?? [];
  return cards.find((c) => c.vendorCode === vendorCode) ?? null;
}

/**
 * Poll get/cards/list until the card (with nmID) appears, or timeout.
 * Returns the card, or throws with the error-list reason if creation failed.
 */
export async function waitForCard(
  ctx: WbCtx,
  vendorCode: string,
  opts: { timeoutMs?: number; intervalMs?: number; onTick?: (n: number) => void } = {}
): Promise<WbCardListItem> {
  const timeoutMs = opts.timeoutMs ?? 6 * 60_000; // 6 min default
  const intervalMs = opts.intervalMs ?? 12_000;
  const deadline = Date.now() + timeoutMs;
  let tick = 0;

  while (Date.now() < deadline) {
    tick++;
    opts.onTick?.(tick);
    const card = await findCardByVendorCode(ctx, vendorCode);
    if (card && card.nmID) return card;

    // check error list every other tick (fail fast if WB rejected the card)
    // — halves content calls while polling under concurrency
    if (tick % 2 === 0) {
      const err = await findCardError(ctx, vendorCode);
      if (err && err.errors?.length) {
        throw new Error(`WB 拒绝了卡片 ${vendorCode}: ${err.errors.join("; ")}`);
      }
    }
    await sleep(intervalMs);
  }
  // last error check
  const err = await findCardError(ctx, vendorCode);
  if (err && err.errors?.length) {
    throw new Error(`WB 拒绝了卡片 ${vendorCode}: ${err.errors.join("; ")}`);
  }
  throw new Error(
    `等待 nmID 超时（${Math.round(timeoutMs / 60000)} 分钟）。WB 同步可能延迟，可稍后在历史中重试挂图/定价。`
  );
}

export async function listCardErrors(ctx: WbCtx): Promise<WbCardError[]> {
  // Response shape: { data: { items: [{ vendorCodes, errors: {vc: [msg]} }] } }
  const res = await wbFetch<WbCardErrorListResponse>({
    token: ctx.token,
    sandbox: ctx.sandbox,
    method: "POST",
    path: "/content/v2/cards/error/list",
    query: { locale: "ru" },
    body: {},
  });
  const out: WbCardError[] = [];
  for (const item of res.data?.items ?? []) {
    const errs = item.errors ?? {};
    for (const vc of Object.keys(errs)) {
      out.push({ vendorCode: vc, errors: errs[vc] ?? [] });
    }
  }
  return out;
}

async function findCardError(
  ctx: WbCtx,
  vendorCode: string
): Promise<WbCardError | null> {
  try {
    const errors = await listCardErrors(ctx);
    return errors.find((e) => e.vendorCode === vendorCode) ?? null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
