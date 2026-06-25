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
  RefreshCw,
  Video,
} from "lucide-react";
import clsx from "clsx";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import { EnvBadge } from "./EnvBadge";
import type { Listing, StageLog } from "@/lib/types";

type Step = "input" | "generating" | "preview" | "publishing" | "done";

interface SettingsState {
  wbContentTokenSet: boolean;
  dryRun: boolean;
  imageProvider: string;
  wbSandbox: boolean;
  wbTokenExpiresInDays: number | null;
  defaultLength: number;
  defaultWidth: number;
  defaultHeight: number;
  defaultWeight: number;
}

export function Workbench() {
  const [step, setStep] = useState<Step>("input");
  const [productName, setProductName] = useState("");
  const [keywordInput, setKeywordInput] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [price, setPrice] = useState(1990);
  // default 0 — never ship a struck-through "discount" the seller didn't choose.
  const [discount, setDiscount] = useState(0);
  const [brand, setBrand] = useState("");
  // package dims (cm) + gross weight (kg) — pre-filled from the seller's
  // configured defaults once settings load.
  const [length, setLength] = useState(20);
  const [width, setWidth] = useState(15);
  const [height, setHeight] = useState(5);
  const [weight, setWeight] = useState(0.3);
  const [basePhotos, setBasePhotos] = useState<string[]>([]);
  // English product video to dub into Russian and attach to the card (optional).
  const [videoPath, setVideoPath] = useState<string | null>(null);
  // Collapse power-user fields (brand/dims/prompt/count/main-first) by default —
  // a plain seller only needs name + keywords + price + photos/video.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");
  const [imageCount, setImageCount] = useState(3);
  const [mainOnly, setMainOnly] = useState(false);
  const [regenLoading, setRegenLoading] = useState<number | null>(null);
  const [restLoading, setRestLoading] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);

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
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        // pre-fill package dims from the seller's configured defaults
        if (s.defaultLength) setLength(s.defaultLength);
        if (s.defaultWidth) setWidth(s.defaultWidth);
        if (s.defaultHeight) setHeight(s.defaultHeight);
        if (s.defaultWeight) setWeight(s.defaultWeight);
      })
      .catch(() => {});
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
  const sandbox = settings ? settings.wbSandbox : false;
  const live = !dryRun && !sandbox; // real store — the one that needs a guard

  // What WB actually receives: the pre-discount "struck-through" base price
  // (= final ÷ (1−discount)). Surface it so a high price/discount doesn't
  // silently exceed WB's allowed range and get rejected.
  const dClamped = Math.max(0, Math.min(99, discount || 0));
  const wbBase =
    price > 0 ? (dClamped > 0 ? Math.round(price / (1 - dClamped / 100)) : Math.round(price)) : 0;
  const priceOutOfRange = wbBase > 0 && (wbBase < 4 || wbBase > 850000);

  async function onPhotos(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    const urls = await Promise.all(
      files.map(
        (f) =>
          new Promise<string>((res) => {
            const r = new FileReader();
            r.onload = () => res(r.result as string);
            r.readAsDataURL(f);
          })
      )
    );
    setBasePhotos((a) => [...a, ...urls].slice(0, 8));
    if (photoRef.current) photoRef.current.value = "";
  }

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
      const data = await api.generate(
        {
          productName,
          keywords,
          price,
          discount,
          brand,
          customPrompt,
          imageCount,
          basePhotos,
          length,
          width,
          height,
          weight,
        },
        mainOnly
      );
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
    // Guard irreversible LIVE actions: a confirm that names the environment so a
    // seller never publishes AI-generated cards to their real store by accident.
    if (!dryRun) {
      const envLine = live
        ? "⚠️ 线上真实店铺（会出现在你的真实 Wildberries 店铺）"
        : "沙盒测试环境（不影响真实店铺）";
      // Use the STORED listing values (what actually publishes), not the editable
      // form state — on a restored draft the form resets to defaults and would
      // assert numbers that don't match what gets published.
      const lDisc = Math.max(0, Math.min(99, listing.discount || 0));
      const lBase =
        listing.price > 0
          ? lDisc > 0
            ? Math.round(listing.price / (1 - lDisc / 100))
            : Math.round(listing.price)
          : 0;
      const ok = window.confirm(
        `确认上架到 ${envLine}？\n\n` +
          `商品：${listing.productName || productName}\n` +
          `到手价：${listing.price} · 折扣 ${lDisc}%（划线价 ≈ ${lBase.toLocaleString()}）`
      );
      if (!ok) return;
    }
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
      setListing(updated);
      setDone({
        stage: updated.stage,
        nmID: updated.nmID,
        dryRun: updated.dryRun,
        sandbox: updated.sandbox,
        error: updated.error,
      });
      setStep("done");
      // Don't let a now-published listing restore as an editable 'preview' draft
      // (which would re-show Publish and re-hit the prices quota on a re-click).
      try {
        sessionStorage.removeItem("wb:listingId");
      } catch {
        /* ignore */
      }
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

  async function doRegenerate(index: number) {
    if (!listing) return;
    setRegenLoading(index);
    setError(null);
    try {
      const updated = await api.regenerateImage(listing.id, index, basePhotos, customPrompt);
      setListing(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "重生成失败");
    } finally {
      setRegenLoading(null);
    }
  }

  async function doGenerateRest() {
    if (!listing) return;
    setRestLoading(true);
    setError(null);
    setGenMsg("生成其余图片…");
    const unlisten = await listen<{ message: string }>("generate:progress", (e) =>
      setGenMsg(e.payload.message)
    );
    try {
      const updated = await api.generateRest(listing.id, basePhotos, customPrompt);
      setListing(updated);
      setGenMsg("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成其余失败");
    } finally {
      unlisten();
      setRestLoading(false);
    }
  }

  return (
    <div className="animate-fade-up">
      {/* Hero */}
      <div className="mb-8 max-w-2xl">
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-slate-900 dark:text-white sm:text-[34px]">
          商品自动化上架工作流
        </h1>
        <p className="mt-2.5 text-[15px] leading-relaxed text-slate-500 dark:text-slate-400">
          输入商品名与关键字，生成主图、宣传图与俄文文案，发布到 Wildberries。
        </p>
        {settings && (
          <div className="mt-3">
            <EnvBadge dryRun={dryRun} sandbox={sandbox} />
          </div>
        )}
      </div>

      {dryRun && (
        <div className="mb-6 flex items-start gap-3 rounded-2xl border border-amber-400/20 bg-amber-500/[0.07] px-4 py-3.5 text-sm text-amber-700 dark:text-amber-200/90">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div className="leading-relaxed">
            当前为 <b className="font-semibold">演示模式</b>（未配置 Wildberries Token）。流程会完整跑通并生成图片，但不会真实上架。
            <Link href="/settings" className="ml-1 inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-200 underline decoration-amber-400/40 underline-offset-2 hover:decoration-amber-300">
              <Settings className="h-3.5 w-3.5" /> 去配置 Token
            </Link>
          </div>
        </div>
      )}

      {!dryRun &&
        settings?.wbTokenExpiresInDays != null &&
        settings.wbTokenExpiresInDays <= 14 && (
          <div
            className={clsx(
              "mb-6 flex items-start gap-3 rounded-2xl border px-4 py-3.5 text-sm",
              settings.wbTokenExpiresInDays < 0
                ? "border-rose-400/30 bg-rose-500/[0.08] text-rose-700 dark:text-rose-200"
                : "border-amber-400/20 bg-amber-500/[0.07] text-amber-700 dark:text-amber-200/90"
            )}
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="leading-relaxed">
              WB Token{" "}
              {settings.wbTokenExpiresInDays < 0
                ? "已过期"
                : settings.wbTokenExpiresInDays === 0
                ? "今天内到期"
                : `还有 ${settings.wbTokenExpiresInDays} 天过期`}
              —— 到期后无法上架/同步。请到 WB 卖家后台「设置 → 访问 API」重新生成，并在
              <Link href="/settings" className="ml-1 font-medium underline underline-offset-2">
                设置
              </Link>
              更新。
            </div>
          </div>
        )}

      <StepBar listing={listing} step={step} />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(360px,400px)_1fr]">
        {/* ── 左:输入(始终可见) ── */}
        <div className="card h-fit p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
            <Tag className="h-4 w-4 text-wb-pink" /> 商品信息
          </div>

          <label className="label">商品名 *</label>
          <input
            className="input mb-4"
            placeholder="如：无线蓝牙耳机 / Беспроводные наушники"
            value={productName}
            onChange={(e) => setProductName(e.target.value)}
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
                    className="text-slate-500 hover:text-rose-600 dark:hover:text-rose-400"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <label className="label">售价（到手价 · 按店铺币种）</label>
          <input
            type="number"
            className="input mb-1.5"
            value={price}
            min={1}
            onChange={(e) => setPrice(Number(e.target.value))}
          />
          {price > 0 && (
            <p
              className={clsx(
                "mb-4 text-xs leading-relaxed",
                priceOutOfRange ? "text-rose-600 dark:text-rose-400" : "text-slate-500"
              )}
            >
              提交给 WB 的划线价 ≈ <b>{wbBase.toLocaleString()}</b>（到手 {price} ÷ (1−{dClamped}%)）
              {priceOutOfRange &&
                "；⚠ 超出常见区间 4–850000，可能被 WB 拒绝（跨境店按 CNY 计）"}
            </p>
          )}

          {showAdvanced && (
            <>
              <label className="label">折扣 (%)</label>
              <input
                type="number"
                className="input mb-4"
                value={discount}
                min={0}
                max={99}
                onChange={(e) => setDiscount(Math.max(0, Math.min(99, Number(e.target.value) || 0)))}
              />

              <label className="label">品牌（可选）</label>
              <input
                className="input mb-4"
                placeholder="留空则自动生成"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
              />

              <label className="label">包裹尺寸 / 重量（按真实填写）</label>
              <div className="mb-1 grid grid-cols-4 gap-2">
                {([
                  ["长", length, setLength, 1, "cm"],
                  ["宽", width, setWidth, 1, "cm"],
                  ["高", height, setHeight, 1, "cm"],
                  ["重", weight, setWeight, 0.1, "kg"],
                ] as const).map(([lab, val, setter, step, unit]) => (
                  <div key={lab}>
                    <input
                      type="number"
                      min={step}
                      step={step}
                      className="input text-center"
                      value={val}
                      onChange={(e) => setter(Math.max(0, Number(e.target.value) || 0))}
                    />
                    <span className="mt-0.5 block text-center text-[10px] text-slate-400">
                      {lab} {unit}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mb-4 text-xs text-slate-500">
                WB 按包裹体积/重量计物流与仓储费，并在入库时复测——填错会被多收费甚至罚款。默认用「设置」里的值。
              </p>
            </>
          )}

          <label className="label">素材（都可选）</label>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            {/* 参考产品图 → 喂 AI */}
            <div className="rounded-xl border border-slate-900/[0.08] bg-slate-900/[0.02] p-3 dark:border-white/[0.07] dark:bg-white/[0.02]">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-200">
                <ImageIcon className="h-3.5 w-3.5 text-wb-purple" /> 参考产品图
              </div>
              <div className="flex flex-wrap gap-1.5">
                {basePhotos.map((p, i) => (
                  <div key={i} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p} alt="" className="h-12 w-12 rounded-lg border border-slate-900/10 object-cover dark:border-white/10" />
                    <button
                      type="button"
                      onClick={() => setBasePhotos((a) => a.filter((_, idx) => idx !== i))}
                      className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-rose-500 text-[10px] text-white"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => photoRef.current?.click()}
                  className="grid h-12 w-12 place-items-center rounded-lg border border-dashed border-slate-900/15 text-slate-400 transition hover:border-wb-purple/50 hover:text-wb-purple dark:border-white/15"
                >
                  <Plus className="h-4 w-4" />
                </button>
                <input ref={photoRef} type="file" accept="image/*" multiple hidden onChange={onPhotos} />
              </div>
              <p className="mt-2 text-[11px] leading-snug text-slate-400">
                你的真实产品图。AI 据此出主图/详情图;<b>留空则全自动生成</b>。
              </p>
            </div>

            {/* 英文产品视频 → 配俄语 */}
            <div className="rounded-xl border border-slate-900/[0.08] bg-slate-900/[0.02] p-3 dark:border-white/[0.07] dark:bg-white/[0.02]">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-200">
                <Video className="h-3.5 w-3.5 text-wb-pink" /> 产品视频 · 英文
              </div>
              {videoPath ? (
                <div className="flex items-center gap-2 rounded-lg border border-slate-900/10 bg-white px-2.5 py-2 text-xs dark:border-white/10 dark:bg-white/[0.04]">
                  <Video className="h-4 w-4 shrink-0 text-wb-pink" />
                  <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-300">
                    {videoPath.split(/[\\/]/).pop()}
                  </span>
                  <button
                    type="button"
                    onClick={() => setVideoPath(null)}
                    className="text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={async () => {
                    const p = await api.dubPickVideo().catch(() => null);
                    if (p) setVideoPath(p);
                  }}
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-900/15 text-xs text-slate-400 transition hover:border-wb-pink/50 hover:text-wb-pink dark:border-white/15"
                >
                  <Plus className="h-4 w-4" /> 选择视频
                </button>
              )}
              <p className="mt-2 text-[11px] leading-snug text-slate-400">
                你的英文产品视频。生成时<b>自动配成俄语</b>,随卡片上架。
              </p>
            </div>
          </div>

          {showAdvanced && (
            <>
              <label className="label">自定义提示词（可选）</label>
              <textarea
                className="input mb-4"
                rows={2}
                placeholder="如：极简风、青绿配色、突出 304 不锈钢"
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
              />

              <label className="label">生成图片数量（1–12）</label>
              <input
                type="number"
                className="input mb-1.5"
                min={1}
                max={12}
                value={imageCount}
                onChange={(e) => setImageCount(Math.max(1, Math.min(12, Number(e.target.value) || 3)))}
              />
              <p className="mb-2 text-xs text-slate-500">
                预计 ~{imageCount} 张 × 约 2.5 分钟 ≈ <b>{Math.ceil(imageCount * 2.5)} 分钟</b>（逐张生成，可在「设置」改模板风格）
              </p>
              <label className="mb-5 flex cursor-pointer items-start gap-2.5 text-sm text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-wb-purple"
                  checked={mainOnly}
                  onChange={(e) => setMainOnly(e.target.checked)}
                />
                <span>
                  先只出主图
                  <span className="mt-0.5 block text-xs text-slate-500">确认满意后再出其余，省出图额度</span>
                </span>
              </label>
            </>
          )}

          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            className="mb-4 flex w-full items-center justify-between border-t border-slate-900/[0.06] pt-3 text-xs text-slate-500 hover:text-slate-700 dark:border-white/[0.06] dark:hover:text-slate-300"
          >
            高级选项（折扣 / 品牌 / 包裹 / 提示词 / 图片数量）
            <span>{showAdvanced ? "收起 ▲" : "展开 ▼"}</span>
          </button>

          <button className="btn-primary w-full" onClick={handleGenerate}>
            <Sparkles className="h-4 w-4" /> 一键生成
          </button>
          <p className="mt-2 text-center text-[11px] text-slate-400">
            生成俄语图文 + 配图{videoPath ? "、并把视频配成俄语" : ""} · 消耗你的 Aurixel 余额
          </p>

          {error && (
            <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{error}</p>
          )}
        </div>

        {/* ── 右:实时预览(始终在视野内) ── */}
        <div className="space-y-4">
          {!listing && step !== "generating" && (
            <div className="card flex min-h-[320px] flex-col items-center justify-center p-8 text-center">
              <div className="mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-slate-900/[0.04] dark:bg-white/5">
                <ImageIcon className="h-7 w-7 text-slate-400" />
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                填好左侧 → 点「一键生成」
                <br />
                这里出主图 / 详情图 + 俄文文案(带中文对照)
              </p>
            </div>
          )}
          {step === "generating" && <GeneratingState msg={genMsg} />}
          {listing && (
            <>
              {step !== "publishing" && step !== "done" && (
                <button
                  onClick={reset}
                  className="text-xs text-slate-500 transition hover:text-slate-800 dark:hover:text-slate-200"
                >
                  ← 重新开始
                </button>
              )}
              <ImagesPanel listing={listing} onRegenerate={doRegenerate} regenLoading={regenLoading} />
              <CopyPanel key={listing.id} listing={listing} onUpdate={setListing} />
              {videoPath && (
                <VideoPanel listing={listing} videoPath={videoPath} onUpdate={setListing} />
              )}

              {/* main-first: generate the remaining images on approval */}
              {listing.partial && (
                <button className="btn-primary w-full" onClick={doGenerateRest} disabled={restLoading}>
                  {restLoading ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> {genMsg || "生成其余…"}</>
                  ) : (
                    <><Sparkles className="h-4 w-4" /> 满意，继续生成其余 {Math.max(0, (listing.requestedImages ?? imageCount) - listing.images.length)} 张</>
                  )}
                </button>
              )}

              {/* Publish action — hidden once the card is live (nmID set), so a
                  restored published listing can't be re-published by mistake. */}
              {!listing.partial && !listing.nmID && step !== "publishing" && step !== "done" && (
                <button className="btn-primary w-full" onClick={handlePublish}>
                  <Rocket className="h-4 w-4" />
                  {dryRun ? "演示上架" : live ? "上架到 Wildberries（线上）" : "上架到沙盒（测试）"}
                </button>
              )}
              {!listing.partial && !!listing.nmID && step !== "publishing" && step !== "done" && (
                <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/[0.08] px-4 py-3 text-sm text-emerald-700 dark:text-emerald-200">
                  此商品已上架（nmID {listing.nmID}）。如需补图/改价，请到「上架记录」或「商品管理」操作。
                </div>
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

function StepBar({ listing, step }: { listing: Listing | null; step: Step }) {
  const cur = !listing ? 1 : step === "publishing" || step === "done" ? 3 : 2;
  const steps = ["输入", "预览", "发布"];
  return (
    <div className="mb-8 flex items-center justify-center">
      {steps.map((s, i) => {
        const n = i + 1;
        const done = n < cur;
        const act = n === cur;
        return (
          <div key={s} className="flex items-center">
            <div
              className={clsx(
                "grid h-7 w-7 place-items-center rounded-full text-xs font-medium transition-all",
                act
                  ? "bg-gradient-to-br from-wb-pink to-wb-purple text-white shadow-sm"
                  : done
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "border border-slate-900/10 text-slate-400 dark:border-white/10"
              )}
            >
              {done ? <CheckCircle2 className="h-4 w-4" /> : n}
            </div>
            <span
              className={clsx(
                "ml-1.5 text-xs",
                act ? "font-medium text-slate-900 dark:text-white" : "text-slate-400"
              )}
            >
              {s}
            </span>
            {i < steps.length - 1 && (
              <div className="mx-3 h-px w-8 bg-slate-900/10 dark:bg-white/10" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function GeneratingState({ msg }: { msg?: string }) {
  return (
    <div className="card p-6">
      <div className="mb-4 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
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

function ImagesPanel({
  listing,
  onRegenerate,
  regenLoading,
}: {
  listing: Listing;
  onRegenerate: (i: number) => void;
  regenLoading: number | null;
}) {
  const labels: Record<string, string> = {
    main: "主图",
    gallery: "细节图",
    promo: "宣传图",
  };
  return (
    <div className="card p-6">
      <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
        <ImageIcon className="h-4 w-4 text-wb-pink" /> 生成的图片
        <span className="text-xs font-normal text-slate-400">（不满意可单张重生成）</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {listing.images.map((img, i) => {
          const busy = regenLoading === i;
          return (
            <div key={img.id} className="group relative overflow-hidden rounded-xl border border-slate-900/10 dark:border-white/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.kind} className="aspect-[3/4] w-full object-cover" />
              <div className="absolute left-2 top-2">
                <span className="chip border-white/20 bg-black/50 text-white backdrop-blur">
                  {labels[img.kind] ?? img.kind}
                </span>
              </div>
              <div className="absolute right-2 top-2 flex gap-1.5 opacity-0 transition group-hover:opacity-100">
                <button
                  onClick={() => onRegenerate(i)}
                  disabled={regenLoading !== null}
                  title="重新生成这一张"
                  className="grid h-8 w-8 place-items-center rounded-lg bg-black/50 text-white backdrop-blur disabled:opacity-50"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
                <a
                  href={img.url}
                  download
                  className="grid h-8 w-8 place-items-center rounded-lg bg-black/50 text-white backdrop-blur"
                >
                  <Download className="h-4 w-4" />
                </a>
              </div>
              {busy && (
                <div className="absolute inset-0 grid place-items-center bg-black/40 backdrop-blur-sm">
                  <div className="flex flex-col items-center gap-1.5 text-white">
                    <Loader2 className="h-6 w-6 animate-spin" />
                    <span className="text-[11px]">重生成中…</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CopyPanel({ listing, onUpdate }: { listing: Listing; onUpdate?: (l: Listing) => void }) {
  const copy = listing.copy;
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState("");
  const [eDesc, setEDesc] = useState("");
  const [eBullets, setEBullets] = useState("");
  const [savingCopy, setSavingCopy] = useState(false);
  const [copyErr, setCopyErr] = useState<string | null>(null);
  // Bilingual view: 俄(发布用) / 中(参考) / 双语. Chinese is reference-only.
  const [lang, setLang] = useState<"ru" | "zh" | "both">("both");
  const showRu = lang !== "zh";
  const showZh = lang !== "ru";
  if (!copy) return null;

  function startEdit() {
    if (!copy) return;
    setETitle(copy.title);
    setEDesc(copy.description);
    setEBullets(copy.bullets.join("\n"));
    setCopyErr(null);
    setEditing(true);
  }
  async function saveCopy() {
    setSavingCopy(true);
    setCopyErr(null);
    try {
      const bullets = eBullets.split("\n").map((s) => s.trim()).filter(Boolean);
      const updated = await api.updateCopy(listing.id, eTitle, eDesc, bullets);
      onUpdate?.(updated);
      setEditing(false);
    } catch (e) {
      setCopyErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingCopy(false);
    }
  }

  return (
    <div className="card p-6">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
          <Sparkles className="h-4 w-4 text-wb-pink" /> 文案（俄文 listing）
        </div>
        {!editing ? (
          <div className="flex items-center gap-2">
            <div className="flex gap-0.5 rounded-lg border border-slate-900/[0.08] bg-slate-900/[0.03] p-0.5 dark:border-white/[0.06] dark:bg-white/[0.03]">
              {(["ru", "zh", "both"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setLang(m)}
                  className={clsx(
                    "rounded-md px-2 py-0.5 text-[11px] font-medium transition",
                    lang === m
                      ? "bg-white text-slate-900 shadow-sm dark:bg-white/[0.12] dark:text-white"
                      : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                  )}
                >
                  {m === "ru" ? "俄" : m === "zh" ? "中" : "双语"}
                </button>
              ))}
            </div>
            {/* edit only on an unpublished draft — live edits wouldn't reach WB */}
            {!listing.nmID && (
              <button
                className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                onClick={startEdit}
              >
                编辑
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3 text-xs">
            <button
              className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              onClick={() => setEditing(false)}
              disabled={savingCopy}
            >
              取消
            </button>
            <button
              className="flex items-center gap-1 font-medium text-wb-pink disabled:opacity-50"
              onClick={saveCopy}
              disabled={savingCopy || !eTitle.trim()}
            >
              {savingCopy && <Loader2 className="h-3 w-3 animate-spin" />} 保存
            </button>
          </div>
        )}
      </div>
      {editing ? (
        <div className="space-y-3 text-sm">
          <div>
            <span className="label">标题（{eTitle.length}/60）</span>
            <input
              className="input"
              maxLength={60}
              value={eTitle}
              onChange={(e) => setETitle(e.target.value)}
            />
          </div>
          <div>
            <span className="label">描述（{eDesc.length}/2000）</span>
            <textarea
              className="input"
              rows={5}
              maxLength={2000}
              value={eDesc}
              onChange={(e) => setEDesc(e.target.value)}
            />
          </div>
          <div>
            <span className="label">卖点（每行一条）</span>
            <textarea
              className="input"
              rows={4}
              value={eBullets}
              onChange={(e) => setEBullets(e.target.value)}
            />
          </div>
          {copyErr && <p className="text-xs text-rose-600 dark:text-rose-400">{copyErr}</p>}
        </div>
      ) : (
      <div className="space-y-3 text-sm">
        <div>
          <span className="label">标题（{copy.title.length}/60）</span>
          {showRu && (
            <p className="rounded-lg bg-slate-900/[0.04] dark:bg-white/5 px-3 py-2 text-slate-900 dark:text-slate-100">{copy.title}</p>
          )}
          {showZh && copy.titleZh && (
            <p className={clsx("text-slate-500 dark:text-slate-400", showRu ? "mt-1 px-3 text-xs" : "rounded-lg bg-slate-900/[0.04] dark:bg-white/5 px-3 py-2 text-slate-700 dark:text-slate-300")}>
              {copy.titleZh}
            </p>
          )}
        </div>
        <div>
          <span className="label">描述</span>
          {showRu && (
            <p className="max-h-32 overflow-auto rounded-lg bg-slate-900/[0.04] dark:bg-white/5 px-3 py-2 leading-relaxed text-slate-700 dark:text-slate-300">
              {copy.description}
            </p>
          )}
          {showZh && copy.descriptionZh && (
            <p className={clsx("max-h-32 overflow-auto leading-relaxed text-slate-500 dark:text-slate-400", showRu ? "mt-1 px-3 text-xs" : "rounded-lg bg-slate-900/[0.04] dark:bg-white/5 px-3 py-2 text-slate-700 dark:text-slate-300")}>
              {copy.descriptionZh}
            </p>
          )}
        </div>
        {copy.bullets.length > 0 && (
          <div>
            <span className="label">卖点</span>
            <ul className="space-y-1.5">
              {copy.bullets.map((b, i) => (
                <li key={i} className="flex items-start gap-2 text-slate-700 dark:text-slate-300">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span>
                    {showRu && <span>{b}</span>}
                    {showZh && copy.bulletsZh?.[i] && (
                      <span className={clsx("block text-slate-500 dark:text-slate-400", showRu ? "mt-0.5 text-xs" : "")}>
                        {copy.bulletsZh[i]}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-3 pt-1 text-xs text-slate-500 dark:text-slate-400">
          <span>类目: <b className="text-slate-800 dark:text-slate-200">{copy.categoryHint || "—"}</b></span>
          <span>品牌: <b className="text-slate-800 dark:text-slate-200">{copy.brand}</b></span>
          <span>vendorCode: <b className="text-slate-800 dark:text-slate-200">{listing.vendorCode}</b></span>
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
            <summary className="cursor-pointer text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200">
              文生图提示词（英文）
            </summary>
            <p className="mt-1.5 rounded-lg bg-slate-900/[0.04] dark:bg-white/5 px-3 py-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              {copy.imagePrompt}
            </p>
          </details>
        )}
      </div>
      )}
    </div>
  );
}

function VideoPanel({
  listing,
  videoPath,
  onUpdate,
}: {
  listing: Listing;
  videoPath: string;
  onUpdate: (l: Listing) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const done = !!listing.videoRu;

  async function dub() {
    setBusy(true);
    setErr(null);
    setStage("自检…");
    let un: (() => void) | null = null;
    try {
      const pf = await api.dubPreflight();
      if (!pf.ready) {
        const miss: string[] = [];
        if (!pf.node) miss.push("Node 运行时");
        if (!pf.ffmpeg || !pf.ffprobe) miss.push("FFmpeg");
        if (!pf.aurixelKey) miss.push("Aurixel 密钥(去设置填)");
        if (!pf.cliFound) miss.push("配音脚本");
        throw new Error("运行环境未就绪:缺 " + miss.join("、"));
      }
      un = await listen<{ stage: string }>("dub:progress", (e) => setStage(e.payload.stage));
      const out = await api.dubStart({ inputPath: videoPath, quality: "standard", voiceMode: "clone" });
      onUpdate(await api.setListingVideo(listing.id, out));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "配音失败");
    } finally {
      un?.();
      setBusy(false);
      setStage("");
    }
  }

  async function reDub() {
    onUpdate(await api.setListingVideo(listing.id, ""));
  }

  return (
    <div className="card p-6">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
        <Video className="h-4 w-4 text-wb-pink" /> 产品视频
        {done && (
          <span className="chip border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-3 w-3" /> 已配俄语
          </span>
        )}
      </div>
      <div className="mb-3 truncate text-xs text-slate-500 dark:text-slate-400">
        {videoPath.split(/[\\/]/).pop()}
      </div>
      {done ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-emerald-700 dark:text-emerald-300">
            俄语配音已生成,发布时随卡片一起上传到 WB。
          </span>
          <button className="btn-ghost px-3 py-1.5 text-xs" onClick={reDub}>
            <RefreshCw className="h-3.5 w-3.5" /> 重配
          </button>
        </div>
      ) : busy ? (
        <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <Loader2 className="h-4 w-4 animate-spin text-wb-pink" /> 配音中…
          <span className="text-xs text-slate-400">{stage}</span>
        </div>
      ) : (
        <button className="btn-primary" onClick={dub} disabled={!!listing.nmID}>
          <Video className="h-4 w-4" /> 配成俄语
        </button>
      )}
      {err && <p className="mt-2 break-words text-xs text-rose-600 dark:text-rose-400">{err}</p>}
      <p className="mt-2 text-[11px] text-slate-400">把英文视频配成俄语 · 消耗你的 Aurixel 余额 · ~1–2 分钟</p>
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
  // A card created but with a warning (e.g. some images failed to upload) must
  // NOT read as a clean success — surface it as "partial" so the seller knows to
  // fix it, never as a green "上架成功" for an imageless/priceless card.
  const success = !!done && done.stage === "live" && !done.error;
  const partial = !!done && !!done.nmID && !!done.error && !success;
  return (
    <div className="card p-6">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
        {publishing ? (
          <Loader2 className="h-4 w-4 animate-spin text-wb-pink" />
        ) : success ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        ) : partial ? (
          <AlertTriangle className="h-4 w-4 text-amber-500" />
        ) : (
          <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400" />
        )}
        上架流程
      </div>

      <div className="max-h-64 space-y-2 overflow-auto rounded-lg bg-slate-900/[0.05] dark:bg-black/20 p-3 font-mono text-xs">
        {logs.map((l, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className={clsx(l.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
              {l.ok ? "✓" : "✗"}
            </span>
            <span className="text-slate-700 dark:text-slate-300">{l.message}</span>
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
              ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
              : partial
              ? "border-amber-400/30 bg-amber-500/10 text-amber-700 dark:text-amber-200"
              : "border-rose-400/30 bg-rose-500/10 text-rose-700 dark:text-rose-200"
          )}
        >
          {success || partial ? (
            <div>
              <div className="font-medium">
                {success
                  ? done.dryRun
                    ? "演示完成（未真实上架）"
                    : "上架成功"
                  : "卡片已创建，但未全部完成"}
              </div>
              {done.nmID && (
                <div className="mt-1 text-xs">
                  nmID: <b>{done.nmID}</b>
                  {!done.dryRun && done.sandbox && (
                    <span className="ml-2 text-amber-600 dark:text-amber-300/90">
                      沙盒卡片 · 无公开商品页（仅卖家 API 可见）
                    </span>
                  )}
                  {!done.dryRun && !done.sandbox && (
                    <button
                      type="button"
                      onClick={() =>
                        api.openUrl(`https://www.wildberries.ru/catalog/${done.nmID}/detail.aspx`)
                      }
                      className="ml-2 underline"
                    >
                      查看商品页 ↗（WB 审核后可见）
                    </button>
                  )}
                </div>
              )}
              {partial && done.error && (
                <div className="mt-2 text-xs leading-relaxed">{done.error}</div>
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
