"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Trash2, Package, ExternalLink, Loader2, RefreshCw, UploadCloud } from "lucide-react";
import { StageBadge } from "./StageBadge";
import { api } from "@/lib/api";
import type { Listing } from "@/lib/types";

export function HistoryList() {
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [pricingId, setPricingId] = useState<string | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);

  async function load() {
    setListings(await api.listListings());
  }

  async function retryPrice(id: string) {
    setPricingId(id);
    try {
      await api.retryPricing(id);
      alert("价格/折扣已提交，WB 约 1 分钟后异步生效（可在 WB 后台核对）。");
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const url = msg.match(/https?:\/\/\S+/)?.[0];
      if (url) {
        if (confirm("折扣未生效。WB 返回了一条规则说明（多为：新卡片需先通过审核才能定价）。\n是否打开查看？\n\n" + msg)) {
          api.openUrl(url);
        }
      } else {
        alert("折扣仍未生效：" + msg);
      }
    } finally {
      setPricingId(null);
    }
  }

  // Retry a card that was created but didn't fully finish (e.g. a photo upload
  // flaked mid-publish). Routes to the pipeline's resume path: re-upload images
  // to the existing nmID + re-submit price — never creates a duplicate card.
  async function retryPublish(id: string) {
    setPublishingId(id);
    try {
      const r = await api.publish(id);
      alert(r.error ? "仍有问题：" + r.error : "已重试补图 + 提交价格。");
      await load();
    } catch (e) {
      alert("重试失败：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setPublishingId(null);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function remove(id: string, hasCard: boolean) {
    if (
      hasCard &&
      !confirm("该商品已上架到 WB。删除会把卡片移入 WB 回收站（30 天内可恢复），并从本列表移除。确定？")
    ) {
      return;
    }
    try {
      await api.trashCard(id);
      setListings((l) => (l ? l.filter((x) => x.id !== id) : l));
    } catch (e) {
      alert("删除失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }

  if (!listings) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="animate-fade-up">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">上架记录</h1>
      <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">共 {listings.length} 个商品</p>

      {listings.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-20 text-center">
          <Package className="mb-3 h-10 w-10 text-slate-400 dark:text-slate-600" />
          <p className="text-sm text-slate-500 dark:text-slate-400">还没有商品</p>
          <Link href="/" className="btn-primary mt-4">
            去生成第一个
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {listings.map((l) => {
            const cover = l.images.find((i) => i.kind === "main") ?? l.images[0];
            return (
              <div key={l.id} className="card flex items-center gap-4 p-3">
                {cover ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={cover.url}
                    alt={l.productName}
                    className="h-20 w-16 shrink-0 rounded-lg object-cover"
                  />
                ) : (
                  <div className="grid h-20 w-16 shrink-0 place-items-center rounded-lg bg-slate-900/[0.04] dark:bg-white/5">
                    <Package className="h-6 w-6 text-slate-400 dark:text-slate-600" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-medium text-slate-900 dark:text-slate-100">
                      {l.copy?.title || l.productName}
                    </h3>
                    <StageBadge stage={l.stage} />
                    {l.dryRun && (
                      <span className="chip text-[10px] text-amber-600 dark:text-amber-300">演示</span>
                    )}
                    {!l.dryRun && l.sandbox && (
                      <span className="chip text-[10px] text-sky-600 dark:text-sky-300">沙盒</span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>{l.price}₽ · -{l.discount}%</span>
                    <span>vendorCode: {l.vendorCode}</span>
                    {l.nmID && <span>nmID: {l.nmID}</span>}
                    <span>{new Date(l.createdAt).toLocaleString("zh-CN")}</span>
                  </div>
                  {l.error && (
                    <p className="mt-1 truncate text-xs text-rose-600 dark:text-rose-400">{l.error}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {l.nmID && !l.dryRun && l.error && (
                    <button
                      onClick={() => retryPublish(l.id)}
                      disabled={publishingId === l.id}
                      title="重试上架（补图 + 定价，不会重复建卡）"
                      className="grid h-9 w-9 place-items-center rounded-lg text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 disabled:opacity-50"
                    >
                      {publishingId === l.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <UploadCloud className="h-4 w-4" />
                      )}
                    </button>
                  )}
                  {l.nmID && !l.dryRun && (
                    <button
                      onClick={() => retryPrice(l.id)}
                      disabled={pricingId === l.id}
                      title="重试定价（卡片激活后设置价格/折扣）"
                      className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-900/[0.04] dark:hover:bg-white/5 hover:text-slate-800 dark:hover:text-slate-200 disabled:opacity-50"
                    >
                      {pricingId === l.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                    </button>
                  )}
                  {l.nmID && !l.dryRun && !l.sandbox && (
                    <button
                      onClick={() =>
                        api.openUrl(`https://www.wildberries.ru/catalog/${l.nmID}/detail.aspx`)
                      }
                      title="查看商品页（WB 审核后可见）"
                      className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-900/[0.04] dark:hover:bg-white/5 hover:text-slate-800 dark:hover:text-slate-200"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    onClick={() => remove(l.id, !!l.nmID && !l.dryRun)}
                    className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 dark:text-slate-400 hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
