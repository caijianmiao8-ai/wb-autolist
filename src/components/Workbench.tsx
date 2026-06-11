"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Sparkles,
  Loader2,
  Rocket,
  ImageIcon,
  Tag,
  Plus,
  X,
  Download,
  CheckCircle2,
  AlertTriangle,
  Settings,
} from "lucide-react";
import clsx from "clsx";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import type { Listing, StageLog } from "@/lib/types";

type Step = "input" | "generating" | "preview" | "publishing" | "done";

interface SettingsState {
  wbContentTokenSet: boolean;
  dryRun: boolean;
  imageProvider: string;
}

export function Workbench() {
  const [step, setStep] = useState<Step>("input");
  const [productName, setProductName] = useState("");
  const [keywordInput, setKeywordInput] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [price, setPrice] = useState(1990);
  const [discount, setDiscount] = useState(30);
  const [brand, setBrand] = useState("");

  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<StageLog[]>([]);
  const [done, setDone] = useState<{
    stage: string;
    nmID: number | null;
    dryRun: boolean;
    sandbox: boolean;
    error: string | null;
  } | null>(null);

  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [genMsg, setGenMsg] = useState("");
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {});
  }, []);

  // Restore the in-progress product when returning to this tab (navigation
  // unmounts the component, so the generated preview would otherwise be lost).
  useEffect(() => {
    if (typeof window === "undefined") return;
    // mid-generation when we left → show the generating state again
    if (sessionStorage.getItem("wb:generating")) {
      setStep("generating");
    } else {
      const id = sessionStorage.getItem("wb:listingId");
      if (id) {
        api
          .getListing(id)
          .then((l) => {
            if (l) {
              setListing(l);
              setStep("preview");
            }
          })
          .catch(() => {});
      }
    }

    // live generation progress + completion (works even after navigating back)
    let alive = true;
    let unProgress: (() => void) | null = null;
    let unDone: (() => void) | null = null;
    listen<{ message: string }>("generate:progress", (e) => setGenMsg(e.payload.message)).then(
      (u) => (alive ? (unProgress = u) : u())
    );
    listen<Listing>("generate:done", (e) => {
      setListing(e.payload);
      setStep("preview");
      setGenMsg("");
      try {
        sessionStorage.setItem("wb:listingId", e.payload.id);
        sessionStorage.removeItem("wb:generating");
      } catch {
        /* ignore */
      }
    }).then((u) => (alive ? (unDone = u) : u()));
    return () => {
      alive = false;
      unProgress?.();
      unDone?.();
    };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const dryRun = settings ? settings.dryRun : true;

  // What WB actually receives: the pre-discount "struck-through" base price
  // (= final ÷ (1−discount)). Surface it so a high price/discount doesn't
  // silently exceed WB's allowed range and get rejected.
  const dClamped = Math.max(0, Math.min(99, discount || 0));
  const wbBase =
    price > 0 ? (dClamped > 0 ? Math.round(price / (1 - dClamped / 100)) : Math.round(price)) : 0;
  const priceOutOfRange = wbBase > 0 && (wbBase < 4 || wbBase > 850000);

  function addKeyword() {
    const parts = keywordInput
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) {
      setKeywords((k) => Array.from(new Set([...k, ...parts])).slice(0, 20));
      setKeywordInput("");
    }
  }

  async function handleGenerate() {
    if (!productName.trim()) {
      setError("请填写商品名");
      return;
    }
    setError(null);
    setStep("generating");
    setListing(null);
    setDone(null);
    setLogs([]);
    setGenMsg("开始生成…");
    try {
      sessionStorage.setItem("wb:generating", "1");
    } catch {
      /* ignore */
    }
    try {
      const data = await api.generate({ productName, keywords, price, discount, brand });
      setListing(data);
      setStep("preview");
      setGenMsg("");
      try {
        sessionStorage.setItem("wb:listingId", data.id);
        sessionStorage.removeItem("wb:generating");
      } catch {
        /* ignore */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成失败");
      setStep("input");
      try {
        sessionStorage.removeItem("wb:generating");
      } catch {
        /* ignore */
      }
    }
  }

  async function handlePublish() {
    if (!listing) return;
    setStep("publishing");
    setLogs([]);
    setDone(null);
    setError(null);

    // Live progress arrives as "publish:progress" events from the Rust backend.
    const unlisten = await listen<{ id: string; stage: string; ok: boolean; message: string }>(
      "publish:progress",
      (e) => {
        if (e.payload.id !== listing.id) return;
        setLogs((l) => [
          ...l,
          {
            ts: new Date().toISOString(),
            stage: e.payload.stage as StageLog["stage"],
            ok: e.payload.ok,
            message: e.payload.message,
          },
        ]);
      }
    );
    try {
      const updated = await api.publish(listing.id);
      setDone({
        stage: updated.stage,
        nmID: updated.nmID,
        dryRun: updated.dryRun,
        sandbox: updated.sandbox,
        error: updated.error,
      });
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "上架失败");
      setStep("preview");
    } finally {
      unlisten();
    }
  }

  function reset() {
    setStep("input");
    setListing(null);
    setLogs([]);
    setDone(null);
    setError(null);
    try {
      sessionStorage.removeItem("wb:listingId");
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="animate-fade-up">
      {/* Hero */}
      <div className="mb-8 max-w-2xl">
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-white sm:text-[34px]">
          商品自动化上架工作流
        </h1>
        <p className="mt-2.5 text-[15px] leading-relaxed text-slate-400">
          输入商品名与关键字，生成主图、宣传图与俄文文案，发布到 Wildberries。
        </p>
      </div>

      {dryRun && (
        <div className="mb-6 flex items-start gap-3 rounded-2xl border border-amber-400/20 bg-amber-500/[0.07] px-4 py-3.5 text-sm text-amber-200/90">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div className="leading-relaxed">
            当前为 <b className="font-semibold">演示模式</b>（未配置 Wildberries Token）。流程会完整跑通并生成图片，但不会真实上架。
            <Link href="/settings" className="ml-1 inline-flex items-center gap-1 font-medium text-amber-200 underline decoration-amber-400/40 underline-offset-2 hover:decoration-amber-300">
              <Settings className="h-3.5 w-3.5" /> 去配置 Token
            </Link>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[400px_1fr]">
        {/* ── Input ── */}
        <div className="card h-fit p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-200">
            <Tag className="h-4 w-4 text-wb-pink" /> 商品信息
          </div>

          <label className="label">商品名 *</label>
          <input
            className="input mb-4"
            placeholder="如：无线蓝牙耳机 / Беспроводные наушники"
            value={productName}
            onChange={(e) => setProductName(e.target.value)}
            disabled={step === "generating" || step === "publishing"}
          />

          <label className="label">关键字</label>
          <div className="mb-2 flex gap-2">
            <input
              className="input"
              placeholder="回车添加，逗号分隔"
              value={keywordInput}
              onChange={(e) => setKeywordInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addKeyword();
                }
              }}
            />
            <button className="btn-ghost px-3" onClick={addKeyword} type="button">
              <Plus className="h-4 w-4" />
            </button>
          </div>
          {keywords.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {keywords.map((k) => (
                <span key={k} className="chip">
                  {k}
                  <button
                    onClick={() => setKeywords((arr) => arr.filter((x) => x !== k))}
                    className="text-slate-500 hover:text-rose-400"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="mb-1.5 grid grid-cols-2 gap-3">
            <div>
              <label className="label">到手价（按店铺币种）</label>
              <input
                type="number"
                className="input"
                value={price}
                min={1}
                onChange={(e) => setPrice(Number(e.target.value))}
              />
            </div>
            <div>
              <label className="label">折扣 (%)</label>
              <input
                type="number"
                className="input"
                value={discount}
                min={0}
                max={99}
                onChange={(e) => setDiscount(Number(e.target.value))}
              />
            </div>
          </div>
          {price > 0 && (
            <p
              className={clsx(
                "mb-4 text-xs leading-relaxed",
                priceOutOfRange ? "text-rose-400" : "text-slate-500"
              )}
            >
              提交给 WB 的划线价 ≈ <b>{wbBase.toLocaleString()}</b>（到手 {price} ÷ (1−{dClamped}%)）
              {priceOutOfRange &&
                "；⚠ 超出常见区间 4–850000，可能被 WB 拒绝（跨境店按 CNY 计）"}
            </p>
          )}

          <label className="label">品牌（可选）</label>
          <input
            className="input mb-5"
            placeholder="留空则自动生成"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
          />

          <button
            className="btn-primary w-full"
            onClick={handleGenerate}
            disabled={step === "generating" || step === "publishing"}
          >
            {step === "generating" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> 生成中…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" /> 一键生成
              </>
            )}
          </button>

          {error && (
            <p className="mt-3 text-sm text-rose-400">{error}</p>
          )}
        </div>

        {/* ── Preview / Result ── */}
        <div className="space-y-6">
          {step === "input" && !listing && <EmptyState />}
          {step === "generating" && <GeneratingState msg={genMsg} />}

          {listing && (
            <>
              <ImagesPanel listing={listing} />
              <CopyPanel listing={listing} />

              {/* Publish action */}
              {step !== "publishing" && step !== "done" && (
                <button className="btn-primary w-full" onClick={handlePublish}>
                  <Rocket className="h-4 w-4" />
                  {dryRun ? "演示上架" : "上架到 Wildberries"}
                </button>
              )}

              {(step === "publishing" || step === "done") && (
                <ProgressPanel
                  logs={logs}
                  done={done}
                  publishing={step === "publishing"}
                  logEndRef={logEndRef}
                  onReset={reset}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="card flex min-h-[360px] flex-col items-center justify-center p-8 text-center">
      <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-white/5">
        <ImageIcon className="h-8 w-8 text-slate-500" />
      </div>
      <p className="text-sm text-slate-400">
        填写左侧商品信息，点击「一键生成」
        <br />
        将生成主图、宣传图与俄文 listing 文案
      </p>
    </div>
  );
}

function GeneratingState({ msg }: { msg?: string }) {
  return (
    <div className="card p-6">
      <div className="mb-4 flex items-center gap-2 text-sm text-slate-300">
        <Loader2 className="h-4 w-4 animate-spin text-wb-pink" /> {msg || "正在生成图片与文案…"}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton aspect-[3/4] rounded-xl" />
        ))}
      </div>
      <div className="mt-4 space-y-2">
        <div className="skeleton h-4 w-3/4 rounded" />
        <div className="skeleton h-4 w-full rounded" />
        <div className="skeleton h-4 w-5/6 rounded" />
      </div>
    </div>
  );
}

function ImagesPanel({ listing }: { listing: Listing }) {
  const labels: Record<string, string> = {
    main: "主图",
    gallery: "细节图",
    promo: "宣传图",
  };
  return (
    <div className="card p-6">
      <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-200">
        <ImageIcon className="h-4 w-4 text-wb-pink" /> 生成的图片
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {listing.images.map((img) => (
          <div key={img.id} className="group relative overflow-hidden rounded-xl border border-white/10">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.url}
              alt={img.kind}
              className="aspect-[3/4] w-full object-cover"
            />
            <div className="absolute left-2 top-2">
              <span className="chip bg-black/50 backdrop-blur">
                {labels[img.kind] ?? img.kind}
              </span>
            </div>
            <a
              href={img.url}
              download
              className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-lg bg-black/50 text-white opacity-0 backdrop-blur transition group-hover:opacity-100"
            >
              <Download className="h-4 w-4" />
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}

function CopyPanel({ listing }: { listing: Listing }) {
  const copy = listing.copy;
  if (!copy) return null;
  return (
    <div className="card p-6">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-200">
        <Sparkles className="h-4 w-4 text-wb-pink" /> 文案（俄文 listing）
      </div>
      <div className="space-y-3 text-sm">
        <div>
          <span className="label">标题（{copy.title.length}/60）</span>
          <p className="rounded-lg bg-white/5 px-3 py-2 text-slate-100">{copy.title}</p>
        </div>
        <div>
          <span className="label">描述</span>
          <p className="max-h-32 overflow-auto rounded-lg bg-white/5 px-3 py-2 leading-relaxed text-slate-300">
            {copy.description}
          </p>
        </div>
        {copy.bullets.length > 0 && (
          <div>
            <span className="label">卖点</span>
            <ul className="space-y-1">
              {copy.bullets.map((b, i) => (
                <li key={i} className="flex items-start gap-2 text-slate-300">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  {b}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-3 pt-1 text-xs text-slate-400">
          <span>类目: <b className="text-slate-200">{copy.categoryHint || "—"}</b></span>
          <span>品牌: <b className="text-slate-200">{copy.brand}</b></span>
          <span>vendorCode: <b className="text-slate-200">{listing.vendorCode}</b></span>
        </div>
        {copy.keywords.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {copy.keywords.map((k) => (
              <span key={k} className="chip text-xs">{k}</span>
            ))}
          </div>
        )}
        {copy.imagePrompt && (
          <details className="pt-1">
            <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-200">
              文生图提示词（英文）
            </summary>
            <p className="mt-1.5 rounded-lg bg-white/5 px-3 py-2 text-xs leading-relaxed text-slate-400">
              {copy.imagePrompt}
            </p>
          </details>
        )}
      </div>
    </div>
  );
}

function ProgressPanel({
  logs,
  done,
  publishing,
  logEndRef,
  onReset,
}: {
  logs: StageLog[];
  done: { stage: string; nmID: number | null; dryRun: boolean; sandbox: boolean; error: string | null } | null;
  publishing: boolean;
  logEndRef: React.RefObject<HTMLDivElement>;
  onReset: () => void;
}) {
  const success = done && done.stage === "live";
  return (
    <div className="card p-6">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-200">
        {publishing ? (
          <Loader2 className="h-4 w-4 animate-spin text-wb-pink" />
        ) : success ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
        ) : (
          <AlertTriangle className="h-4 w-4 text-rose-400" />
        )}
        上架流程
      </div>

      <div className="max-h-64 space-y-2 overflow-auto rounded-lg bg-black/20 p-3 font-mono text-xs">
        {logs.map((l, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className={clsx(l.ok ? "text-emerald-400" : "text-rose-400")}>
              {l.ok ? "✓" : "✗"}
            </span>
            <span className="text-slate-300">{l.message}</span>
          </div>
        ))}
        {logs.length === 0 && <span className="text-slate-500">准备中…</span>}
        <div ref={logEndRef} />
      </div>

      {done && (
        <div
          className={clsx(
            "mt-4 rounded-xl border px-4 py-3 text-sm",
            success
              ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
              : "border-rose-400/30 bg-rose-500/10 text-rose-200"
          )}
        >
          {success ? (
            <div>
              <div className="font-medium">
                {done.dryRun ? "演示完成（未真实上架）" : "上架成功"}
              </div>
              {done.nmID && (
                <div className="mt-1 text-xs">
                  nmID: <b>{done.nmID}</b>
                  {!done.dryRun && done.sandbox && (
                    <span className="ml-2 text-amber-300/90">
                      沙盒卡片 · 无公开商品页（仅卖家 API 可见）
                    </span>
                  )}
                  {!done.dryRun && !done.sandbox && (
                    <a
                      href={`https://www.wildberries.ru/catalog/${done.nmID}/detail.aspx`}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 underline"
                    >
                      查看商品页 ↗（WB 审核后可见）
                    </a>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div>
              <div className="font-medium">上架失败</div>
              <div className="mt-1 text-xs">{done.error}</div>
            </div>
          )}
          <button className="btn-ghost mt-3 w-full" onClick={onReset}>
            再来一个
          </button>
        </div>
      )}
    </div>
  );
}
