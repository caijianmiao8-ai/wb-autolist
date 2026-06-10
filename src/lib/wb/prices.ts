import { wbFetch, type WbCtx } from "./client";

interface PriceUploadResponse {
  data?: { id?: number; uploadID?: number; alreadyExists?: boolean };
}

/** Queue a price/discount task. Returns the uploadID for polling. */
export async function uploadPriceTask(
  ctx: WbCtx,
  items: { nmID: number; price: number; discount?: number }[]
): Promise<number> {
  const res = await wbFetch<PriceUploadResponse>({
    token: ctx.token,
    sandbox: ctx.sandbox,
    host: "prices",
    method: "POST",
    path: "/api/v2/upload/task",
    body: { data: items },
    timeoutMs: 30_000,
  });
  const id = res.data?.id ?? res.data?.uploadID;
  if (!id) throw new Error("价格任务未返回 uploadID");
  return id;
}

interface TaskStatus {
  data?: {
    uploadID?: number;
    status?: number;
    overAllGoodsNumber?: number;
    successGoodsNumber?: number;
  };
}

/**
 * Poll a price task to completion. status 3 = done; 5 = partial (some errored,
 * OK ones applied). Checks buffer first, then history.
 */
export async function waitForPriceTask(
  ctx: WbCtx,
  uploadID: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<{ status: number; success: number; total: number }> {
  const timeoutMs = opts.timeoutMs ?? 3 * 60_000;
  const intervalMs = opts.intervalMs ?? 8_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await readTask(ctx, uploadID);
    if (status && (status.status === 3 || status.status === 5)) {
      return {
        status: status.status,
        success: status.successGoodsNumber ?? 0,
        total: status.overAllGoodsNumber ?? 0,
      };
    }
    await sleep(intervalMs);
  }
  throw new Error("价格任务处理超时，请稍后在 WB 后台确认价格状态。");
}

async function readTask(
  ctx: WbCtx,
  uploadID: number
): Promise<TaskStatus["data"] | null> {
  // buffer first (in-flight), then history (final)
  for (const path of ["/api/v2/buffer/tasks", "/api/v2/history/tasks"]) {
    try {
      const res = await wbFetch<{ data?: TaskStatus["data"][] | TaskStatus["data"] }>(
        {
          token: ctx.token,
          sandbox: ctx.sandbox,
          host: "prices",
          method: "GET",
          path,
          query: { uploadID },
        }
      );
      const d = Array.isArray(res.data) ? res.data[0] : res.data;
      if (d && d.status != null) return d;
    } catch {
      // try next endpoint
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
