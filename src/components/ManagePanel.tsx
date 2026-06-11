"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Boxes,
  Loader2,
  RefreshCw,
  Warehouse as WarehouseIcon,
  Package,
  PackagePlus,
  PackageMinus,
  Tag,
  Trash2,
  ExternalLink,
  AlertTriangle,
  ChevronDown,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import type { ManageResponse, ManagedCard, ManagedStatus, Warehouse } from "@/lib/types";

const STATUS: Record<ManagedStatus, { label: string; cls: string }> = {
  live: { label: "可售", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30" },
  no_stock: { label: "无库存", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30" },
  no_price: { label: "未定价", cls: "bg-sky-500/15 text-sky-600 dark:text-sky-300 border-sky-500/30" },
  rejected: { label: "被拒", cls: "bg-rose-500/15 text-rose-600 dark:text-rose-300 border-rose-500/30" },
  ok: { label: "已建", cls: "bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/30" },
};

function money(n: number | null, currency: string | null) {
  if (n == null) return "—";
  const sym = currency === "RUB" ? "₽" : currency ? ` ${currency}` : "";
  return `${n.toLocaleString()}${sym}`;
}

export function ManagePanel() {
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [data, setData] = useState<ManageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [whError, setWhError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyNm, setBusyNm] = useState<number | null>(null);
  const [editingNm, setEditingNm] = useState<number | null>(null);
  const [defaultStock, setDefaultStock] = useState(99);

  // initial: load settings (default warehouse/stock) + warehouses, then cards.
  useEffect(() => {
    (async () => {
      const cfg = await api.getSettings().catch(() => null);
      const def = cfg?.defaultWarehouseId ?? 0;
      if (cfg?.defaultStock) setDefaultStock(cfg.defaultStock);
      try {
        const whs = await api.listWarehouses();
        setWarehouses(whs);
        const initial = def && whs.some((w) => w.id === def) ? def : whs[0]?.id ?? null;
        setWarehouseId(initial);
        await load(initial);
      } catch (e) {
        // warehouses need the Маркетплейс scope; cards still load without stock.
        setWhError(e instanceof Error ? e.message : String(e));
        setWarehouses([]);
        await load(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(wh: number | null) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.manageCards(wh);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  async function onWarehouse(id: number) {
    setWarehouseId(id);
    api.saveSettings({ defaultWarehouseId: id }).catch(() => {});
    await load(id);
  }

  async function doSetStock(card: ManagedCard, amount: number) {
    if (!warehouseId) {
      setError("请先选择仓库。");
      return;
    }
    if (!card.skus.length) {
      setError(`${card.vendorCode} 没有条码(sku)，无法设库存。`);
      return;
    }
    setBusyNm(card.nmID);
    try {
      await api.setCardStock(warehouseId, card.skus, amount);
      // optimistic: reflect the new stock + status without a heavy full reload
      setData((d) =>
        d
          ? {
              ...d,
              cards: d.cards.map((c) =>
                c.nmID === card.nmID
                  ? {
                      ...c,
                      stock: amount,
                      status: c.status === "rejected" || c.status === "no_price"
                        ? c.status
                        : amount > 0
                        ? "live"
                        : "no_stock",
                      statusNote: amount > 0 ? `可售 · 库存 ${amount}` : "无库存（补货后可售）",
                    }
                  : c
              ),
            }
          : d
      );
      setEditingNm(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyNm(null);
    }
  }

  async function doSetPrice(card: ManagedCard, price: number, discount: number) {
    setBusyNm(card.nmID);
    try {
      await api.setCardPrice(card.nmID, price, discount);
      alert("价格/折扣已提交，WB 约 1 分钟后异步生效（不会立即刷新，可稍后刷新核对）。");
      setEditingNm(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const url = msg.match(/https?:\/\/\S+/)?.[0];
      if (url && confirm("价格接口限流或有规则说明。是否打开查看？\n\n" + msg)) {
        api.openUrl(url);
      } else {
        setError(msg);
      }
    } finally {
      setBusyNm(null);
    }
  }

  async function doTrash(card: ManagedCard) {
    if (
      !confirm(
        `删除卡片「${card.title || card.vendorCode}」(nmID ${card.nmID})？\n会移入 WB 回收站（30 天内可恢复）。`
      )
    )
      return;
    setBusyNm(card.nmID);
    try {
      await api.trashCards([card.nmID]);
      setData((d) => (d ? { ...d, cards: d.cards.filter((c) => c.nmID !== card.nmID), total: d.total - 1 } : d));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyNm(null);
    }
  }

  const cards = data?.cards ?? [];

  return (
    <div className="animate-fade-up">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
            <Boxes className="h-6 w-6 text-wb-pink" /> 商品管理
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            直接读取 Wildberries 上的真实卡片、价格与库存，并就地补货 / 下架 / 改价 / 删除。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-xl border border-slate-900/[0.1] bg-slate-900/[0.02] px-3 py-1.5 dark:border-white/[0.08] dark:bg-white/[0.02]">
            <WarehouseIcon className="h-4 w-4 text-slate-400" />
            <select
              className="bg-transparent text-sm text-slate-800 outline-none dark:text-slate-200"
              value={warehouseId ?? ""}
              onChange={(e) => onWarehouse(Number(e.target.value))}
              disabled={!warehouses || warehouses.length === 0}
            >
              {!warehouses && <option value="">加载仓库…</option>}
              {warehouses?.length === 0 && <option value="">无可用仓库</option>}
              {warehouses?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}（{w.id}）
                </option>
              ))}
            </select>
          </div>
          <button
            className="btn-ghost px-3 py-2"
            onClick={() => load(warehouseId)}
            disabled={loading}
            title="刷新（一次性拉取，不会轮询）"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {whError && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-sm text-amber-700 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            读取仓库失败（Token 可能缺少「Маркетплейс」范围）：{whError}。卡片与价格仍可查看，但无法显示/设置库存。
          </span>
        </div>
      )}
      {data?.warnings?.map((w, i) => (
        <div key={i} className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-2.5 text-xs text-amber-700 dark:text-amber-200">
          {w}
        </div>
      ))}
      {data?.truncated && (
        <div className="mb-3 rounded-xl border border-sky-500/30 bg-sky-500/[0.08] px-4 py-2.5 text-xs text-sky-700 dark:text-sky-200">
          商品较多，仅显示前 1500 个（其余未加载）。
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/[0.08] px-4 py-3 text-sm text-rose-600 dark:text-rose-300">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex items-center justify-center py-24 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : cards.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-20 text-center">
          <Package className="mb-3 h-10 w-10 text-slate-300 dark:text-slate-600" />
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {data ? "WB 上还没有商品卡片" : "未能加载"}
          </p>
          <Link href="/" className="btn-primary mt-4">
            去生成第一个
          </Link>
        </div>
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
            共 {data?.total ?? cards.length} 个商品
            {warehouseId ? `（库存来自仓库 ${warehouseId}）` : "（未选仓库，库存留空）"}
          </p>
          <div className="space-y-3">
            {cards.map((c) => (
              <CardRow
                key={c.nmID}
                card={c}
                hasWarehouse={!!warehouseId}
                defaultStock={defaultStock}
                busy={busyNm === c.nmID}
                open={editingNm === c.nmID}
                onToggle={() => setEditingNm((n) => (n === c.nmID ? null : c.nmID))}
                onSetStock={(amt) => doSetStock(c, amt)}
                onSetPrice={(p, d) => doSetPrice(c, p, d)}
                onTrash={() => doTrash(c)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CardRow({
  card,
  hasWarehouse,
  defaultStock,
  busy,
  open,
  onToggle,
  onSetStock,
  onSetPrice,
  onTrash,
}: {
  card: ManagedCard;
  hasWarehouse: boolean;
  defaultStock: number;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onSetStock: (amount: number) => void;
  onSetPrice: (price: number, discount: number) => void;
  onTrash: () => void;
}) {
  const st = STATUS[card.status] ?? STATUS.ok;
  const [stockInput, setStockInput] = useState(
    card.stock != null ? card.stock : defaultStock
  );
  const [priceInput, setPriceInput] = useState(card.price ?? 0);
  const [discountInput, setDiscountInput] = useState(card.discount ?? 0);

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-4 p-3">
        {card.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.photo}
            alt={card.title}
            className="h-20 w-16 shrink-0 rounded-lg border border-slate-900/10 object-cover dark:border-white/10"
          />
        ) : (
          <div className="grid h-20 w-16 shrink-0 place-items-center rounded-lg bg-slate-900/[0.04] dark:bg-white/5">
            <Package className="h-6 w-6 text-slate-300 dark:text-slate-600" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-medium text-slate-800 dark:text-slate-100">
              {card.title || card.vendorCode}
            </h3>
            <span className={clsx("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium", st.cls)}>
              {st.label}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {money(card.price, card.currency)}
              {card.discount ? ` · -${card.discount}%` : ""}
              {card.discountedPrice != null && card.discount ? ` → ${money(card.discountedPrice, card.currency)}` : ""}
            </span>
            <span>nmID: {card.nmID}</span>
            <span className="truncate">vendor: {card.vendorCode}</span>
            {card.subjectName && <span>{card.subjectName}</span>}
            <span>{card.characteristics} 特征</span>
          </div>
          <div className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{card.statusNote}</div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">库存</div>
            <div className="text-lg font-semibold tabular-nums text-slate-800 dark:text-slate-100">
              {card.stock != null ? card.stock : "—"}
            </div>
          </div>
          <button
            onClick={onToggle}
            disabled={busy}
            title="管理（库存 / 价格 / 删除）"
            className={clsx(
              "grid h-9 w-9 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-900/[0.05] hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-slate-200",
              open && "bg-slate-900/[0.05] dark:bg-white/5"
            )}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ChevronDown className={clsx("h-4 w-4 transition-transform", open && "rotate-180")} />
            )}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-slate-900/[0.06] bg-slate-900/[0.015] px-3 py-3 dark:border-white/[0.06] dark:bg-white/[0.015]">
          <div className="grid gap-3 sm:grid-cols-2">
            {/* 库存 */}
            <div className="rounded-xl border border-slate-900/[0.07] p-3 dark:border-white/[0.07]">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                <Boxes className="h-3.5 w-3.5 text-wb-pink" /> 库存（FBS）
              </div>
              {hasWarehouse ? (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    className="input px-2.5 py-1.5 text-sm"
                    value={stockInput}
                    onChange={(e) => setStockInput(Math.max(0, Number(e.target.value) || 0))}
                  />
                  <button
                    className="btn-ghost shrink-0 px-3 py-1.5 text-xs"
                    onClick={() => onSetStock(stockInput)}
                    disabled={busy || !card.skus.length}
                    title={card.skus.length ? "" : "该商品无条码"}
                  >
                    <PackagePlus className="h-3.5 w-3.5" /> 设库存
                  </button>
                  <button
                    className="btn-ghost shrink-0 px-3 py-1.5 text-xs text-rose-600 dark:text-rose-300"
                    onClick={() => {
                      if (confirm("把库存设为 0（下架，停止销售）？")) onSetStock(0);
                    }}
                    disabled={busy || !card.skus.length}
                  >
                    <PackageMinus className="h-3.5 w-3.5" /> 下架
                  </button>
                </div>
              ) : (
                <p className="text-xs text-slate-400 dark:text-slate-500">先在右上角选择仓库</p>
              )}
            </div>

            {/* 价格 */}
            <div className="rounded-xl border border-slate-900/[0.07] p-3 dark:border-white/[0.07]">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                <Tag className="h-3.5 w-3.5 text-wb-pink" /> 价格 / 折扣（划线价）
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  className="input px-2.5 py-1.5 text-sm"
                  value={priceInput}
                  onChange={(e) => setPriceInput(Math.max(0, Number(e.target.value) || 0))}
                  placeholder="价格"
                />
                <input
                  type="number"
                  min={0}
                  max={99}
                  className="input w-20 px-2.5 py-1.5 text-sm"
                  value={discountInput}
                  onChange={(e) => setDiscountInput(Math.max(0, Math.min(99, Number(e.target.value) || 0)))}
                  placeholder="折扣%"
                />
                <button
                  className="btn-ghost shrink-0 px-3 py-1.5 text-xs"
                  onClick={() => onSetPrice(priceInput, discountInput)}
                  disabled={busy || priceInput <= 0}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> 改价
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">
                价格接口限流较严，提交后约 1 分钟异步生效。
              </p>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              className="btn-ghost px-3 py-1.5 text-xs"
              onClick={() =>
                api.openUrl(`https://www.wildberries.ru/catalog/${card.nmID}/detail.aspx`)
              }
            >
              <ExternalLink className="h-3.5 w-3.5" /> 查看商品页
            </button>
            <button
              className="btn-ghost px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-500/10 dark:text-rose-300"
              onClick={onTrash}
              disabled={busy}
            >
              <Trash2 className="h-3.5 w-3.5" /> 删卡
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
