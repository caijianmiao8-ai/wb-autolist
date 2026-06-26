"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Trash2,
  Package,
  ExternalLink,
  Loader2,
  UploadCloud,
  ArrowRight,
  History as HistoryIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import type { Listing } from "@/lib/types";

// Human status for a published record — never the raw stage enum.
function histStatus(l: Listing): { label: string; cls: string; note?: string; failed?: boolean } {
  if (l.dryRun)
    return {
      label: "测试发布",
      cls: "text-slate-600 bg-slate-500/10 dark:text-slate-300",
      note: "不会上线真店",
    };
  if (l.stage === "error" || (l.error && !l.nmID))
    return { label: "失败", cls: "text-rose-700 bg-rose-500/10 dark:text-rose-300", failed: true };
  if (l.nmID && l.error)
    return {
      label: "部分完成",
      cls: "text-amber-700 bg-amber-500/10 dark:text-amber-300",
      note: "卡片已建,有步骤未完成",
      failed: true,
    };
  if (l.stage === "live")
    return l.sandbox
      ? { label: "测试发布", cls: "text-amber-700 bg-amber-500/10 dark:text-amber-300", note: "沙盒 · 不影响真店" }
      : { label: "已上架", cls: "text-emerald-700 bg-emerald-500/10 dark:text-emerald-300" };
  return { label: "处理中", cls: "text-sky-700 bg-sky-500/10 dark:text-sky-300" };
}

function humanError(raw: string): string {
  if (/review|moderation|审核|not.*activated/i.test(raw))
    return "新卡需先通过 WB 审核才能定价,通常 24 小时内。";
  if (/price|discount|429|too many/i.test(raw)) return "价格/折扣未生效:WB 限制改价频率,稍后重试。";
  if (/photo|image|media|upload/i.test(raw)) return "部分图片未上传成功,可「重新发布」补传。";
  return raw.length > 60 ? raw.slice(0, 60) + "…" : raw;
}

export function HistoryList() {
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [tab, setTab] = useState<0 | 1>(0); // 0=草稿箱 1=发布历史
  const [failOnly, setFailOnly] = useState(false);

  async function load() {
    try {
      setListings(await api.listListings());
      setLoadErr(null);
    } catch (e) {
      setListings([]);
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  function continueDraft(id: string) {
    try {
      sessionStorage.setItem("wb:listingId", id);
      sessionStorage.removeItem("wb:generating");
    } catch {
      /* ignore */
    }
    window.location.href = "/";
  }

  async function retryPublish(id: string) {
    setPublishingId(id);
    try {
      const r = await api.publish(id);
      alert(r.error ? "仍有问题:" + r.error : "已重试补图 + 提交价格。");
      await load();
    } catch (e) {
      alert("重试失败:" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setPublishingId(null);
    }
  }

  async function remove(id: string, hasCard: boolean) {
    if (
      hasCard &&
      !confirm("该商品已上架到 WB。删除会把卡片移入 WB 回收站(30 天内可恢复),并从本列表移除。确定?")
    )
      return;
    try {
      await api.trashCard(id);
      setListings((l) => (l ? l.filter((x) => x.id !== id) : l));
    } catch (e) {
      alert("删除失败:" + (e instanceof Error ? e.message : String(e)));
    }
  }

  if (!listings) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const drafts = listings.filter((l) => l.stage === "draft");
  const history = listings.filter((l) => l.stage !== "draft");
  const failCount = history.filter((l) => histStatus(l).failed).length;
  const shownHistory = failOnly ? history.filter((l) => histStatus(l).failed) : history;

  return (
    <div className="flex h-full min-h-0 flex-col animate-fade-up">
      {/* ── Header: title + tab switcher (pinned) ── */}
      <div className="shrink-0">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
            <HistoryIcon className="h-5 w-5 text-wb-pink" /> 上架记录
          </h1>
          <div className="flex gap-1 rounded-xl border border-slate-900/[0.08] bg-slate-900/[0.03] p-1 dark:border-white/[0.06] dark:bg-white/[0.03]">
            {(
              [
                [0, `草稿箱 · ${drafts.length}`],
                [1, `发布历史 · ${history.length}`],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  tab === t
                    ? "rounded-lg bg-white px-4 py-1.5 text-sm font-medium text-slate-900 shadow-sm dark:bg-white/[0.12] dark:text-white"
                    : "rounded-lg px-4 py-1.5 text-sm text-slate-500 transition hover:text-slate-700 dark:hover:text-slate-300"
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {loadErr && (
          <div className="mb-3 rounded-xl border border-rose-500/30 bg-rose-500/[0.08] px-4 py-2.5 text-xs text-rose-600 dark:text-rose-300">
            读取记录失败:{loadErr}
          </div>
        )}
      </div>

      {/* ── Body (scrolls internally) ── */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        {listings.length === 0 ? (
          <div className="card flex flex-col items-center justify-center py-20 text-center">
            <Package className="mb-3 h-10 w-10 text-slate-400 dark:text-slate-600" />
            <p className="text-sm text-slate-500 dark:text-slate-400">还没有记录</p>
            <div className="mt-4 flex gap-2">
              <Link href="/" className="btn-primary">单品上架</Link>
              <Link href="/batch" className="btn-ghost">批量导入</Link>
            </div>
          </div>
        ) : tab === 0 ? (
          /* ① 草稿箱 */
          drafts.length === 0 ? (
            <div className="card px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
              没有草稿。在「单品上架」生成后未发布的，会出现在这里。
            </div>
          ) : (
            <>
              <p className="mb-2.5 px-0.5 text-xs text-slate-500 dark:text-slate-400">
                还没发布的草稿,点「继续编辑发布」回到 3 步流程接着做。
              </p>
              <div className="space-y-2.5">
                {drafts.map((l) => (
                  <Row
                    key={l.id}
                    l={l}
                    kind="draft"
                    publishing={publishingId === l.id}
                    onContinue={() => continueDraft(l.id)}
                    onRetry={() => retryPublish(l.id)}
                    onRemove={() => remove(l.id, false)}
                  />
                ))}
              </div>
            </>
          )
        ) : (
          /* ② 发布历史 */
          <>
            <div className="mb-2.5 flex flex-wrap items-center gap-2 px-0.5">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                只读追溯 · 改价/库存请去「商品管理」
              </span>
              <div className="ml-auto flex gap-1.5">
                <button
                  onClick={() => setFailOnly(false)}
                  className={
                    !failOnly
                      ? "rounded-lg border border-slate-900/[0.12] bg-slate-900/[0.04] px-2.5 py-1 text-[11.5px] text-slate-700 dark:border-white/[0.12] dark:bg-white/[0.06] dark:text-slate-200"
                      : "rounded-lg border border-slate-900/[0.1] px-2.5 py-1 text-[11.5px] text-slate-500 dark:border-white/[0.1]"
                  }
                >
                  全部
                </button>
                <button
                  onClick={() => setFailOnly(true)}
                  className={
                    failOnly
                      ? "rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-[11.5px] text-rose-600 dark:text-rose-300"
                      : "rounded-lg border border-slate-900/[0.1] px-2.5 py-1 text-[11.5px] text-rose-500 dark:border-white/[0.1]"
                  }
                >
                  失败 {failCount}
                </button>
              </div>
            </div>
            {shownHistory.length === 0 ? (
              <div className="card px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                {failOnly ? "没有失败的记录 🎉" : "还没有发布记录"}
              </div>
            ) : (
              <div className="space-y-2.5">
                {shownHistory.map((l) => (
                  <Row
                    key={l.id}
                    l={l}
                    kind="history"
                    publishing={publishingId === l.id}
                    onRetry={() => retryPublish(l.id)}
                    onRemove={() => remove(l.id, !!l.nmID && !l.dryRun)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  l,
  kind,
  publishing,
  onContinue,
  onRetry,
  onRemove,
}: {
  l: Listing;
  kind: "draft" | "history";
  publishing: boolean;
  onContinue?: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const cover = l.images.find((i) => i.kind === "main") ?? l.images[0];
  const st = histStatus(l);
  const ru = l.copy?.title || l.productName;
  const zh = l.copy?.titleZh || "";

  return (
    <div className="card flex items-center gap-3 p-3">
      {cover ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cover.url} alt={ru} className="h-11 w-11 shrink-0 rounded-lg object-cover" />
      ) : (
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-slate-900/[0.04] dark:bg-white/5">
          <Package className="h-5 w-5 text-slate-400 dark:text-slate-600" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{ru}</div>
        {zh && <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">{zh}</div>}
        <div className="mt-1 flex items-center gap-2">
          {kind === "draft" ? (
            <span className="text-[10.5px] text-slate-400">
              {l.videoRu ? "已生成图文,视频已配俄语 · 待发布" : "草稿 · 待发布"}
            </span>
          ) : (
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${st.cls}`}>
              ● {st.label}
            </span>
          )}
          {kind === "history" && st.note && <span className="text-[10.5px] text-slate-400">{st.note}</span>}
        </div>
        {l.error && st.failed && (
          <p className="mt-0.5 truncate text-[11px] text-rose-600 dark:text-rose-400">{humanError(l.error)}</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {kind === "draft" && (
          <button className="btn-primary px-3 py-2 text-xs" onClick={onContinue}>
            <ArrowRight className="h-3.5 w-3.5" /> 继续编辑发布
          </button>
        )}
        {kind === "history" && st.failed && (
          <button
            className="btn-primary px-3 py-2 text-xs"
            onClick={onRetry}
            disabled={publishing}
            title="重新发布(自动补图 + 定价,不会重复建卡)"
          >
            {publishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
            重新发布
          </button>
        )}
        {kind === "history" && !st.failed && l.stage === "live" && !l.dryRun && !l.sandbox && l.nmID && (
          <button
            className="btn-ghost px-3 py-2 text-xs"
            onClick={() => api.openUrl(`https://www.wildberries.ru/catalog/${l.nmID}/detail.aspx`)}
            title="查看商品页(WB 审核后可见)"
          >
            <ExternalLink className="h-3.5 w-3.5" /> 查看
          </button>
        )}
        {kind === "history" && !st.failed && l.nmID && !l.dryRun && (
          <Link href="/manage" className="btn-ghost px-3 py-2 text-xs" title="改价 / 库存 / 下架">
            去商品管理
          </Link>
        )}
        <button
          onClick={onRemove}
          title="删除"
          className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-rose-500/10 hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
