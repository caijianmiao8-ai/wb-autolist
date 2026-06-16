"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  ChevronDown,
  Database,
  CloudDownload,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import type { ManageView, ManagedCard, ManagedStatus } from "@/lib/types";

const STATUS: Record<ManagedStatus, { label: string; cls: string }> = {
  live: { label: "可售", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30" },
  no_stock: { label: "无库存", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30" },
  no_price: { label: "未定价", cls: "bg-sky-500/15 text-sky-600 dark:text-sky-300 border-sky-500/30" },
  price_unknown: { label: "价待同步", cls: "bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/30" },
  rejected: { label: "被拒", cls: "bg-rose-500/15 text-rose-600 dark:text-rose-300 border-rose-500/30" },
  ok: { label: "已建", cls: "bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/30" },
};

function money(n: number | null, currency: string | null) {
  if (n == null) return "—";
  const sym = currency === "RUB" ? "₽" : currency ? ` ${currency}` : "";
  return `${n.toLocaleString()}${sym}`;
}

function ago(sec: number, now: number) {
  if (!sec) return "未同步";
  const d = Math.max(0, now - sec);
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

type SyncKind = "products" | "stocks" | "prices" | "all";

export function ManagePanel() {
  const [view, setView] = useState<ManageView | null>(null);
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<SyncKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyNm, setBusyNm] = useState<number | null>(null);
  const [editingNm, setEditingNm] = useState<number | null>(null);
  const [cooldown, setCooldown] = useState(0); // seconds left on prices
  const [sandbox, setSandbox] = useState(false); // which store these cards live in
  const cdRef = useRef(0);

  // read the local DB (instant, no network)
  const loadDb = useCallback(async (wh: number | null) => {
    let v = await api.dbListCards(wh);
    let chosen = wh;
    if (chosen == null && v.warehouses.length) chosen = v.warehouses[0].id;
    // if we auto-picked a warehouse, re-read so per-card stock matches it
    if (chosen !== wh) v = await api.dbListCards(chosen);
    setView(v);
    setCooldown(v.sync.pricesCooldownRemaining);
    cdRef.current = v.sync.pricesCooldownRemaining;
    setWarehouseId(chosen);
    return v;
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const cfg = await api.getSettings().catch(() => null);
        setSandbox(!!cfg?.wbSandbox);
        const def = cfg?.defaultWarehouseId || 0;
        const v = await loadDb(def || null);
        // if a default warehouse exists but the first read used null, re-read for stock
        if (def && v.warehouseId == null) await loadDb(def);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadDb]);

  // cooldown ticker
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => {
      cdRef.current = Math.max(0, cdRef.current - 1);
      setCooldown(cdRef.current);
      if (cdRef.current <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [cooldown > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }

  async function onWarehouse(id: number) {
    setWarehouseId(id);
    api.saveSettings({ defaultWarehouseId: id }).catch(() => {});
    await loadDb(id);
  }

  async function runSync(kind: SyncKind) {
    setSyncing(kind);
    setError(null);
    try {
      if (kind === "all") {
        await api.syncWarehouses().catch(() => null);
        await api.syncProducts();
        if (warehouseId) await api.syncStocks(warehouseId).catch(() => null);
        // prices only if not cooling down
        if (cooldown <= 0) {
          try {
            const r = await api.syncPrices();
            flash(r.message);
          } catch (e) {
            flash(e instanceof Error ? e.message : String(e));
          }
        } else {
          flash(`价格冷却中，已跳过（约 ${cooldown}s 后可单独同步价格）`);
        }
      } else if (kind === "products") {
        const r = await api.syncProducts();
        flash(r.message);
      } else if (kind === "stocks") {
        if (!warehouseId) {
          setError("请先选择仓库。");
          setSyncing(null);
          return;
        }
        const r = await api.syncStocks(warehouseId);
        flash(r.message);
      } else if (kind === "prices") {
        const r = await api.syncPrices();
        flash(r.message);
      }
      await loadDb(warehouseId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // refresh cooldown from DB even on failure
      await loadDb(warehouseId).catch(() => {});
    } finally {
      setSyncing(null);
    }
  }

  async function doSetStock(card: ManagedCard, amount: number) {
    if (!warehouseId) return setError("请先选择仓库。");
    if (!card.skus.length) return setError(`${card.vendorCode} 没有条码(sku)，无法设库存。`);
    setBusyNm(card.nmID);
    try {
      await api.setCardStock(warehouseId, card.skus, amount);
      setEditingNm(null);
      await loadDb(warehouseId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyNm(null);
    }
  }

  async function doSetPrice(card: ManagedCard, price: number, discount: number) {
    // Confirm the exact value before pushing to the store — a fat-fingered extra
    // zero on a price is a direct, hard-to-undo financial mistake.
    const final = discount > 0 ? Math.round(price * (1 - discount / 100)) : price;
    if (
      !window.confirm(
        `确认修改价格？\n\n` +
          `${card.title || card.vendorCode}（nmID ${card.nmID}）\n` +
          `划线价 ${price.toLocaleString()} · 折扣 ${discount}% → 到手约 ${final.toLocaleString()}\n\n` +
          `会异步推送到${sandbox ? "沙盒" : "真实"}店铺（约 1 分钟生效）。`
      )
    )
      return;
    setBusyNm(card.nmID);
    try {
      await api.setCardPrice(card.nmID, price, discount);
      flash("价格已提交，WB 约 1 分钟异步生效（本地已先更新显示）。");
      setEditingNm(null);
      await loadDb(warehouseId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const url = msg.match(/https?:\/\/\S+/)?.[0];
      if (url && confirm("价格接口限流或有规则说明。打开查看？\n\n" + msg)) api.openUrl(url);
      else setError(msg);
    } finally {
      setBusyNm(null);
    }
  }

  async function doTrash(card: ManagedCard) {
    if (!confirm(`删除卡片「${card.title || card.vendorCode}」(nmID ${card.nmID})？\n会移入 WB 回收站（30 天内可恢复）。`)) return;
    setBusyNm(card.nmID);
    try {
      await api.trashCards([card.nmID]);
      await loadDb(warehouseId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyNm(null);
    }
  }

  const cards = view?.cards ?? [];
  const sync = view?.sync;
  const now = sync?.nowEpoch ?? 0;
  const warehouses = view?.warehouses ?? [];
  const neverSynced = sync ? sync.products.lastSyncAt === 0 : false;

  return (
    <div className="animate-fade-up">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
            <Boxes className="h-6 w-6 text-wb-pink" /> 商品管理
            <span
              className={clsx(
                "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                sandbox
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300"
                  : "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300"
              )}
              title={sandbox ? "当前操作的是沙盒店铺（测试）" : "当前操作的是真实店铺，改价/删卡会影响线上"}
            >
              {sandbox ? "沙盒" : "线上"}
            </span>
          </h1>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
            <Database className="h-3.5 w-3.5" /> 读取本地缓存（秒开、不限流）。用「同步」按需从 WB 拉取。
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-slate-900/[0.1] bg-slate-900/[0.02] px-3 py-1.5 dark:border-white/[0.08] dark:bg-white/[0.02]">
          <WarehouseIcon className="h-4 w-4 text-slate-400" />
          <select
            className="bg-transparent text-sm text-slate-800 outline-none dark:text-slate-200"
            value={warehouseId ?? ""}
            onChange={(e) => onWarehouse(Number(e.target.value))}
            disabled={warehouses.length === 0}
          >
            {warehouses.length === 0 && <option value="">无仓库（先同步）</option>}
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}（{w.id}）
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* sync toolbar */}
      <div className="card mb-4 flex flex-wrap items-center gap-2 p-3">
        <button className="btn-primary px-3 py-2 text-xs" onClick={() => runSync("all")} disabled={!!syncing}>
          {syncing === "all" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CloudDownload className="h-3.5 w-3.5" />}
          一键同步
        </button>
        <SyncBtn label="商品" meta={sync?.products} now={now} busy={syncing === "products"} disabled={!!syncing} onClick={() => runSync("products")} />
        <SyncBtn label="库存" meta={sync?.stocks} now={now} busy={syncing === "stocks"} disabled={!!syncing || !warehouseId} onClick={() => runSync("stocks")} />
        <button
          className="btn-ghost px-3 py-2 text-xs"
          onClick={() => runSync("prices")}
          disabled={!!syncing || cooldown > 0}
          title={cooldown > 0 ? "价格接口冷却中" : "价格接口限流较严，按需同步"}
        >
          {syncing === "prices" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Tag className="h-3.5 w-3.5" />}
          {cooldown > 0 ? `价格 ${cooldown}s` : "同步价格"}
          <span className="ml-1 text-[10px] text-slate-400">{sync ? ago(sync.prices.lastSyncAt, now) : ""}</span>
        </button>
        <span className="ml-auto text-[11px] text-slate-400 dark:text-slate-500">
          {warehouseId ? `库存来自仓库 ${warehouseId}` : "未选仓库"}
        </span>
      </div>

      {toast && (
        <div className="mb-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.08] px-4 py-2.5 text-xs text-emerald-700 dark:text-emerald-200">
          {toast}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/[0.08] px-4 py-3 text-sm text-rose-600 dark:text-rose-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : cards.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-20 text-center">
          <Package className="mb-3 h-10 w-10 text-slate-300 dark:text-slate-600" />
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {neverSynced ? "本地缓存为空 —— 点上方「一键同步」从 WB 拉取" : "WB 上没有商品卡片"}
          </p>
          {neverSynced ? (
            <button className="btn-primary mt-4" onClick={() => runSync("all")} disabled={!!syncing}>
              {syncing === "all" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}
              一键同步
            </button>
          ) : (
            <Link href="/" className="btn-primary mt-4">去生成第一个</Link>
          )}
        </div>
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
            共 {cards.length} 个商品 · 商品 {sync ? ago(sync.products.lastSyncAt, now) : ""}更新
            {!sync || sync.prices.lastSyncAt === 0 ? " · 价格未同步" : ""}
          </p>
          <div className="space-y-3">
            {cards.map((c) => (
              <CardRow
                key={c.nmID}
                card={c}
                hasWarehouse={!!warehouseId}
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

function SyncBtn({
  label,
  meta,
  now,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  meta?: { lastSyncAt: number };
  now: number;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button className="btn-ghost px-3 py-2 text-xs" onClick={onClick} disabled={disabled}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
      同步{label}
      <span className="ml-1 text-[10px] text-slate-400">{meta ? ago(meta.lastSyncAt, now) : ""}</span>
    </button>
  );
}

function CardRow({
  card,
  hasWarehouse,
  busy,
  open,
  onToggle,
  onSetStock,
  onSetPrice,
  onTrash,
}: {
  card: ManagedCard;
  hasWarehouse: boolean;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onSetStock: (amount: number) => void;
  onSetPrice: (price: number, discount: number) => void;
  onTrash: () => void;
}) {
  const st = STATUS[card.status] ?? STATUS.ok;
  const [stockInput, setStockInput] = useState(card.stock ?? 99);
  const [priceInput, setPriceInput] = useState(card.price ?? 0);
  const [discountInput, setDiscountInput] = useState(card.discount ?? 0);

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-4 p-3">
        {card.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.photo} alt={card.title} className="h-20 w-16 shrink-0 rounded-lg border border-slate-900/10 object-cover dark:border-white/10" />
        ) : (
          <div className="grid h-20 w-16 shrink-0 place-items-center rounded-lg bg-slate-900/[0.04] dark:bg-white/5">
            <Package className="h-6 w-6 text-slate-300 dark:text-slate-600" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-medium text-slate-800 dark:text-slate-100">{card.title || card.vendorCode}</h3>
            <span className={clsx("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium", st.cls)}>{st.label}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {card.price == null ? "价待同步" : money(card.price, card.currency)}
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
            <div className="text-lg font-semibold tabular-nums text-slate-800 dark:text-slate-100">{card.stock != null ? card.stock : "—"}</div>
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
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className={clsx("h-4 w-4 transition-transform", open && "rotate-180")} />}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-slate-900/[0.06] bg-slate-900/[0.015] px-3 py-3 dark:border-white/[0.06] dark:bg-white/[0.015]">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-900/[0.07] p-3 dark:border-white/[0.07]">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                <Boxes className="h-3.5 w-3.5 text-wb-pink" /> 库存（FBS）
              </div>
              {hasWarehouse ? (
                <div className="flex items-center gap-2">
                  <input type="number" min={0} className="input px-2.5 py-1.5 text-sm" value={stockInput} onChange={(e) => setStockInput(Math.max(0, Number(e.target.value) || 0))} />
                  <button className="btn-ghost shrink-0 px-3 py-1.5 text-xs" onClick={() => onSetStock(stockInput)} disabled={busy || !card.skus.length}>
                    <PackagePlus className="h-3.5 w-3.5" /> 设库存
                  </button>
                  <button className="btn-ghost shrink-0 px-3 py-1.5 text-xs text-rose-600 dark:text-rose-300" onClick={() => { if (confirm("把库存设为 0（下架）？")) onSetStock(0); }} disabled={busy || !card.skus.length}>
                    <PackageMinus className="h-3.5 w-3.5" /> 下架
                  </button>
                </div>
              ) : (
                <p className="text-xs text-slate-400 dark:text-slate-500">先在右上角选择仓库</p>
              )}
            </div>

            <div className="rounded-xl border border-slate-900/[0.07] p-3 dark:border-white/[0.07]">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                <Tag className="h-3.5 w-3.5 text-wb-pink" /> 价格 / 折扣（划线价）
              </div>
              <div className="flex items-center gap-2">
                <input type="number" min={0} className="input px-2.5 py-1.5 text-sm" value={priceInput} onChange={(e) => setPriceInput(Math.max(0, Number(e.target.value) || 0))} placeholder="价格" />
                <input type="number" min={0} max={99} className="input w-20 px-2.5 py-1.5 text-sm" value={discountInput} onChange={(e) => setDiscountInput(Math.max(0, Math.min(99, Number(e.target.value) || 0)))} placeholder="折扣%" />
                <button className="btn-ghost shrink-0 px-3 py-1.5 text-xs" onClick={() => onSetPrice(priceInput, discountInput)} disabled={busy || priceInput <= 0}>
                  <RefreshCw className="h-3.5 w-3.5" /> 改价
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">价格接口限流较严，提交后约 1 分钟异步生效。</p>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-end gap-2">
            <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => api.openUrl(`https://www.wildberries.ru/catalog/${card.nmID}/detail.aspx`)}>
              <ExternalLink className="h-3.5 w-3.5" /> 查看商品页
            </button>
            <button className="btn-ghost px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-500/10 dark:text-rose-300" onClick={onTrash} disabled={busy}>
              <Trash2 className="h-3.5 w-3.5" /> 删卡
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
