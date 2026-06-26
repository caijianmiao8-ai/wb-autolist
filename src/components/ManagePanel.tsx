"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Boxes,
  Loader2,
  RefreshCw,
  Warehouse as WarehouseIcon,
  Package,
  Tag,
  Trash2,
  ExternalLink,
  CloudDownload,
  Clock,
  AlertTriangle,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { EnvBadge } from "./EnvBadge";
import type { ManageView, ManagedCard, ManagedStatus } from "@/lib/types";

// Human-readable status — never the raw WB enum. Dot + label, like the mockup.
const STATUS: Record<ManagedStatus, { label: string; cls: string }> = {
  live: { label: "可售", cls: "text-emerald-700 bg-emerald-500/15 dark:text-emerald-300" },
  no_stock: { label: "缺货", cls: "text-amber-700 bg-amber-500/15 dark:text-amber-300" },
  no_price: { label: "待定价", cls: "text-amber-700 bg-amber-500/15 dark:text-amber-300" },
  price_unknown: { label: "价待刷新", cls: "text-slate-600 bg-slate-500/15 dark:text-slate-300" },
  rejected: { label: "被驳回", cls: "text-rose-700 bg-rose-500/15 dark:text-rose-300" },
  ok: { label: "待选仓库", cls: "text-slate-600 bg-slate-500/15 dark:text-slate-300" },
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

export function ManagePanel() {
  const [view, setView] = useState<ManageView | null>(null);
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyNm, setBusyNm] = useState<number | null>(null);
  const [pending, setPending] = useState<Set<number>>(new Set());
  const [cooldown, setCooldown] = useState(0);
  const [dryRun, setDryRun] = useState(true);
  const [sandbox, setSandbox] = useState(false);
  const cdRef = useRef(0);

  const loadDb = useCallback(async (wh: number | null) => {
    let v = await api.dbListCards(wh);
    let chosen = wh;
    if (chosen == null && v.warehouses.length) chosen = v.warehouses[0].id;
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
        setDryRun(cfg ? cfg.dryRun : true);
        const def = cfg?.defaultWarehouseId || 0;
        const v = await loadDb(def || null);
        if (def && v.warehouseId == null) await loadDb(def);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadDb]);

  useEffect(() => {
    const onFocus = () => {
      api
        .getSettings()
        .then((s) => {
          setSandbox(!!s.wbSandbox);
          setDryRun(s.dryRun);
        })
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

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

  // One 刷新 = all domains (内部分域调度), prices skipped while cooling down.
  async function refresh() {
    setSyncing(true);
    setError(null);
    try {
      await api.syncWarehouses().catch(() => null);
      await api.syncProducts();
      if (warehouseId) await api.syncStocks(warehouseId).catch(() => null);
      if (cooldown <= 0) {
        try {
          await api.syncPrices();
        } catch {
          /* prices throttled — non-fatal */
        }
      }
      await loadDb(warehouseId);
      setPending(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await loadDb(warehouseId).catch(() => {});
    } finally {
      setSyncing(false);
    }
  }

  function markPending(nm: number) {
    setPending((s) => new Set(s).add(nm));
  }

  // The inline editors / inline red card ARE the confirmation — no window.confirm.
  async function doSetStock(card: ManagedCard, amount: number, isUnlist: boolean) {
    if (!warehouseId) return setError("请先在右上角选择仓库。");
    if (!card.skus.length) return setError(`「${card.title || card.vendorCode}」没有条码,无法设库存。`);
    setBusyNm(card.nmID);
    try {
      await api.setCardStock(warehouseId, card.skus, amount);
      markPending(card.nmID);
      flash(isUnlist ? "已提交下架,约 1 分钟生效。" : "库存已提交,约 1 分钟生效。");
      await loadDb(warehouseId);
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
      flash("价格已提交,WB 约 1 分钟异步生效(本地已先更新显示)。");
      markPending(card.nmID);
      await loadDb(warehouseId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const url = msg.match(/https?:\/\/\S+/)?.[0];
      if (url && confirm("WB 限制改价频率,或有规则说明。打开查看?\n\n" + msg)) api.openUrl(url);
      else setError(msg);
    } finally {
      setBusyNm(null);
    }
  }

  async function doTrash(card: ManagedCard) {
    const store = sandbox ? "沙盒测试" : "真实";
    if (
      !window.confirm(
        `删除「${card.title || card.vendorCode}」?\n\n· 从${store}店铺移入 WB 回收站(30 天内可恢复)\n· 本地记录一并清除`
      )
    )
      return;
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
  const sellable = cards.filter((c) => c.status === "live").length;
  const todo = cards.length - sellable;

  return (
    <div className="flex h-full min-h-0 flex-col animate-fade-up">
      {/* ── Header (pinned) ── */}
      <div className="shrink-0">
        <div className="mb-1.5 flex flex-wrap items-center gap-2.5">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
            <Boxes className="h-5 w-5 text-wb-pink" /> 商品管理
          </h1>
          <EnvBadge dryRun={dryRun} sandbox={sandbox} />
          <button
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-900/[0.1] bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-900/[0.03] disabled:opacity-50 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-slate-200"
            onClick={refresh}
            disabled={syncing}
            title="从 Wildberries 拉取最新商品/库存/价格"
          >
            {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </button>
          {/* 当前仓库:X ▾ (button-styled select) */}
          <label
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-lg border border-slate-900/[0.1] bg-white px-3 py-1.5 text-xs font-medium text-slate-700 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-slate-200",
              warehouses.length === 0 && "opacity-60"
            )}
          >
            <WarehouseIcon className="h-3.5 w-3.5 text-slate-400" />
            当前仓库:
            <select
              className="max-w-[150px] cursor-pointer bg-transparent outline-none"
              value={warehouseId ?? ""}
              onChange={(e) => onWarehouse(Number(e.target.value))}
              disabled={warehouses.length === 0}
            >
              {warehouses.length === 0 && <option value="">（先刷新）</option>}
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span>
            共 <b className="text-slate-700 dark:text-slate-200">{cards.length}</b> 商品 ·{" "}
            <b className="text-emerald-600 dark:text-emerald-400">{sellable}</b> 可售 /{" "}
            <b className="text-amber-600 dark:text-amber-400">{todo}</b> 待处理
          </span>
          {sync && <span>· 上次更新 {ago(sync.products.lastSyncAt, now)}</span>}
          {cooldown > 0 && (
            <span className="text-amber-600 dark:text-amber-300">
              · WB 限制改价频率,约 {cooldown}s 后可再改价
            </span>
          )}
        </div>

        {toast && (
          <div className="mb-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.08] px-4 py-2.5 text-xs text-emerald-700 dark:text-emerald-200">
            {toast}
          </div>
        )}
        {error && (
          <div className="mb-3 rounded-xl border border-rose-500/30 bg-rose-500/[0.08] px-4 py-2.5 text-sm text-rose-600 dark:text-rose-300">
            {error}
          </div>
        )}
      </div>

      {/* ── List (scrolls internally) ── */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-slate-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : cards.length === 0 ? (
          <div className="card flex flex-col items-center justify-center py-20 text-center">
            <Package className="mb-3 h-10 w-10 text-slate-300 dark:text-slate-600" />
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {neverSynced ? "本地还没有数据 —— 点右上角「刷新」从 WB 拉取" : "WB 上没有商品卡片"}
            </p>
            {neverSynced ? (
              <button className="btn-primary mt-4" onClick={refresh} disabled={syncing}>
                {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}
                刷新
              </button>
            ) : (
              <Link href="/" className="btn-primary mt-4">
                去生成第一个
              </Link>
            )}
          </div>
        ) : (
          <div className="space-y-2.5 pb-2">
            {cards.map((c) => (
              <CardRow
                key={c.nmID}
                card={c}
                hasWarehouse={!!warehouseId}
                priceLocked={cooldown > 0}
                cooldown={cooldown}
                sandbox={sandbox}
                pending={pending.has(c.nmID)}
                busy={busyNm === c.nmID}
                onSetStock={(amt, unlist) => doSetStock(c, amt, unlist)}
                onSetPrice={(p, d) => doSetPrice(c, p, d)}
                onTrash={() => doTrash(c)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type Panel = "price" | "stock" | "unlist" | "detail" | null;

function CardRow({
  card,
  hasWarehouse,
  priceLocked,
  cooldown,
  sandbox,
  pending,
  busy,
  onSetStock,
  onSetPrice,
  onTrash,
}: {
  card: ManagedCard;
  hasWarehouse: boolean;
  priceLocked: boolean;
  cooldown: number;
  sandbox: boolean;
  pending: boolean;
  busy: boolean;
  onSetStock: (amount: number, isUnlist: boolean) => void;
  onSetPrice: (price: number, discount: number) => void;
  onTrash: () => void;
}) {
  const st = STATUS[card.status] ?? STATUS.ok;
  const [panel, setPanel] = useState<Panel>(null);
  const [stockInput, setStockInput] = useState(card.stock ?? 99);
  const [priceInput, setPriceInput] = useState(card.price ?? 0);
  const [discountInput, setDiscountInput] = useState(card.discount ?? 0);

  useEffect(() => {
    setStockInput(card.stock ?? 99);
    setPriceInput(card.price ?? 0);
    setDiscountInput(card.discount ?? 0);
  }, [card.stock, card.price, card.discount]);

  function toggle(p: Panel) {
    setPanel((cur) => (cur === p ? null : p));
  }

  const final =
    card.discountedPrice != null
      ? card.discountedPrice
      : card.price != null && card.discount
      ? Math.round(card.price * (1 - card.discount / 100))
      : card.price;
  const editFinal = discountInput > 0 ? Math.round(priceInput * (1 - discountInput / 100)) : priceInput;
  const isUnpriced = card.status === "no_price";

  return (
    <div className="card overflow-hidden">
      <div className="flex items-start gap-3 p-3">
        {card.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.photo}
            alt={card.title}
            className="h-14 w-14 shrink-0 rounded-lg border border-slate-900/10 object-cover dark:border-white/10"
          />
        ) : (
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-slate-900/[0.04] dark:bg-white/5">
            <Package className="h-5 w-5 text-slate-300 dark:text-slate-600" />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
            {card.title || card.vendorCode}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span
              className={clsx(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                st.cls
              )}
            >
              ● {st.label}
            </span>
            {pending && (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-500/10 px-2 py-0.5 text-[11px] text-slate-500 dark:text-slate-300">
                <Clock className="h-3 w-3" /> 待确认 · 约 1 分钟生效
              </span>
            )}
            {card.price != null &&
              (card.discount ? (
                <span className="text-xs text-slate-600 dark:text-slate-300">
                  原价 {money(card.price, card.currency)} → <b className="text-slate-800 dark:text-slate-100">到手 {money(final ?? null, card.currency)}</b>
                </span>
              ) : (
                <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
                  {money(card.price, card.currency)}
                </span>
              ))}
            {card.stock != null && <span className="text-xs text-slate-500 dark:text-slate-400">库存 {card.stock}</span>}
          </div>
          {isUnpriced && card.statusNote && (
            <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-300/90">{card.statusNote}</div>
          )}
        </div>

        {/* exposed actions */}
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="flex gap-1.5">
            <button
              className="rounded-lg border border-slate-900/[0.1] bg-white px-2.5 py-1 text-[11.5px] text-slate-600 transition hover:bg-slate-900/[0.03] disabled:opacity-50 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-slate-300"
              onClick={() => toggle("price")}
              disabled={busy || priceLocked}
              title={priceLocked ? `WB 限制改价频率,约 ${cooldown}s 后可再改` : "改价 / 折扣"}
            >
              改价
            </button>
            <button
              className="rounded-lg border border-slate-900/[0.1] bg-white px-2.5 py-1 text-[11.5px] text-slate-600 transition hover:bg-slate-900/[0.03] disabled:opacity-50 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-slate-300"
              onClick={() => toggle("stock")}
              disabled={busy || !hasWarehouse}
            >
              库存
            </button>
            <button
              className="rounded-lg border border-rose-500/30 bg-white px-2.5 py-1 text-[11.5px] text-rose-600 transition hover:bg-rose-500/10 disabled:opacity-50 dark:bg-white/[0.04] dark:text-rose-300"
              onClick={() => toggle("unlist")}
              disabled={busy || !hasWarehouse}
            >
              下架
            </button>
          </div>
          <button
            onClick={() => toggle("detail")}
            disabled={busy}
            className="text-[10.5px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : panel === "detail" ? "详情 ▴" : "详情 ▾"}
          </button>
        </div>
      </div>

      {/* ── inline panels ── */}
      {panel === "price" && (
        <div className="border-t border-slate-900/[0.06] bg-slate-900/[0.015] px-3 py-3 dark:border-white/[0.06] dark:bg-white/[0.015]">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
            <Tag className="h-3.5 w-3.5 text-wb-pink" /> 改价 · 原价 / 折扣
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="number"
              min={0}
              className="input w-28 px-2.5 py-1.5 text-sm"
              value={priceInput}
              onChange={(e) => setPriceInput(Math.max(0, Number(e.target.value) || 0))}
              placeholder="原价"
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
            <span className="text-xs text-slate-500">→ 到手约 <b className="text-slate-800 dark:text-slate-100">{editFinal.toLocaleString()} ₽</b></span>
            <div className="ml-auto flex gap-2">
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setPanel(null)}>取消</button>
              <button
                className="btn-primary px-3 py-1.5 text-xs"
                onClick={() => {
                  onSetPrice(priceInput, discountInput);
                  setPanel(null);
                }}
                disabled={busy || priceInput <= 0}
              >
                确认改价
              </button>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">提交后约 1 分钟异步生效到{sandbox ? "沙盒" : "真实"}店铺。</p>
        </div>
      )}

      {panel === "stock" && (
        <div className="border-t border-slate-900/[0.06] bg-slate-900/[0.015] px-3 py-3 dark:border-white/[0.06] dark:bg-white/[0.015]">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
            <Boxes className="h-3.5 w-3.5 text-wb-pink" /> 设库存
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="number"
              min={0}
              className="input w-28 px-2.5 py-1.5 text-sm"
              value={stockInput}
              onChange={(e) => setStockInput(Math.max(0, Number(e.target.value) || 0))}
            />
            <div className="ml-auto flex gap-2">
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setPanel(null)}>取消</button>
              <button
                className="btn-primary px-3 py-1.5 text-xs"
                onClick={() => {
                  onSetStock(stockInput, false);
                  setPanel(null);
                }}
                disabled={busy || !card.skus.length}
              >
                设库存
              </button>
            </div>
          </div>
        </div>
      )}

      {panel === "unlist" && (
        <div className="border-t border-slate-900/[0.06] px-3 py-3 dark:border-white/[0.06]">
          <div className="rounded-xl border-[1.5px] border-rose-400/70 bg-rose-500/[0.04] p-3.5">
            <div className="flex items-center gap-1.5 text-sm font-medium text-rose-700 dark:text-rose-300">
              <AlertTriangle className="h-4 w-4" /> 下架「{card.title || card.vendorCode}」?
            </div>
            <div className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              · 会从<b>{sandbox ? "沙盒" : "真实"}</b>店铺下架,买家将<b>无法搜索 / 购买</b>。<br />
              · 卡片不会删除;补货后需<b>重新设置库存</b>才能恢复销售。
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setPanel(null)}>取消</button>
              <button
                className="rounded-xl bg-rose-600 px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-rose-700 disabled:opacity-50"
                onClick={() => {
                  onSetStock(0, true);
                  setPanel(null);
                }}
                disabled={busy || !card.skus.length}
              >
                确认下架
              </button>
            </div>
          </div>
        </div>
      )}

      {panel === "detail" && (
        <div className="border-t border-slate-900/[0.06] bg-slate-900/[0.015] px-3 py-3 dark:border-white/[0.06] dark:bg-white/[0.015]">
          <div className="rounded-lg bg-slate-900/[0.04] px-3 py-2 font-mono text-[10.5px] text-slate-500 dark:bg-black/20 dark:text-slate-400">
            nmID {card.nmID} · vendorCode {card.vendorCode}
            {card.subjectName ? ` · ${card.subjectName}` : ""} · {card.characteristics} 项特征
            {card.skus[0] ? ` · barcode ${card.skus[0]}` : ""}
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button
              className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-40"
              onClick={() => api.openUrl(`https://www.wildberries.ru/catalog/${card.nmID}/detail.aspx`)}
              disabled={sandbox}
              title={sandbox ? "沙盒卡片没有公开商品页" : "在浏览器打开 WB 商品页"}
            >
              <ExternalLink className="h-3.5 w-3.5" /> 查看商品页
            </button>
            <button
              className="btn-ghost px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-500/10 dark:text-rose-300"
              onClick={onTrash}
              disabled={busy}
            >
              <Trash2 className="h-3.5 w-3.5" /> 删除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
