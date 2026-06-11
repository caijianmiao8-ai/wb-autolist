"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Trash2, Package, ExternalLink, Loader2 } from "lucide-react";
import { StageBadge } from "./StageBadge";
import { api } from "@/lib/api";
import type { Listing } from "@/lib/types";

export function HistoryList() {
  const [listings, setListings] = useState<Listing[] | null>(null);

  async function load() {
    setListings(await api.listListings());
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
      <p className="mb-6 text-sm text-slate-400">共 {listings.length} 个商品</p>

      {listings.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-20 text-center">
          <Package className="mb-3 h-10 w-10 text-slate-600" />
          <p className="text-sm text-slate-400">还没有商品</p>
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
                  <div className="grid h-20 w-16 shrink-0 place-items-center rounded-lg bg-white/5">
                    <Package className="h-6 w-6 text-slate-600" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-medium text-slate-100">
                      {l.copy?.title || l.productName}
                    </h3>
                    <StageBadge stage={l.stage} />
                    {l.dryRun && (
                      <span className="chip text-[10px] text-amber-300">演示</span>
                    )}
                    {!l.dryRun && l.sandbox && (
                      <span className="chip text-[10px] text-sky-300">沙盒</span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                    <span>{l.price}₽ · -{l.discount}%</span>
                    <span>vendorCode: {l.vendorCode}</span>
                    {l.nmID && <span>nmID: {l.nmID}</span>}
                    <span>{new Date(l.createdAt).toLocaleString("zh-CN")}</span>
                  </div>
                  {l.error && (
                    <p className="mt-1 truncate text-xs text-rose-400">{l.error}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {l.nmID && !l.dryRun && !l.sandbox && (
                    <a
                      href={`https://www.wildberries.ru/catalog/${l.nmID}/detail.aspx`}
                      target="_blank"
                      rel="noreferrer"
                      title="查看商品页（WB 审核后可见）"
                      className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-slate-200"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  )}
                  <button
                    onClick={() => remove(l.id, !!l.nmID && !l.dryRun)}
                    className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-rose-500/10 hover:text-rose-400"
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
