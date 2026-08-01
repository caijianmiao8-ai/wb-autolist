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
  Eye,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Search,
} from "lucide-react";
import clsx from "clsx";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import { DUB_PRESETS, DUB_PRESET_DEFAULT, dubPresetOptions, type DubPreset } from "@/lib/dub";
import { EnvBadge } from "./EnvBadge";
import type { Listing, StageLog, WbCharacteristic, WbColor, WbSubject } from "@/lib/types";

type Step = "input" | "generating" | "preview" | "review" | "publishing" | "done";

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

// Single-product draft persistence — the input form unmounts on tab switch
// (Next.js route change), which used to wipe everything the seller typed. Small
// text fields go in wb:draft; the (base64, potentially MB-sized) photos go in a
// SEPARATE key so a keystroke doesn't re-serialize megabytes, and so a quota
// overflow on photos never costs the text fields. Session-scoped (clears on quit).
const DRAFT_KEY = "wb:draft";
const DRAFT_PHOTOS_KEY = "wb:draftPhotos";
// A single-product dub runs in the BACKEND (one at a time) and outlives a tab
// switch. Persist {id} while it runs so a remounted VideoPanel can re-attach to
// its progress/result events instead of looking idle (and re-dubbing into the
// still-occupied slot, which read as "配音失败").
const DUBBING_KEY = "wb:dubbing";
type Draft = {
  productName?: string;
  keywords?: string[];
  price?: number;
  discount?: number;
  brand?: string;
  length?: number;
  width?: number;
  height?: number;
  weight?: number;
  showAdvanced?: boolean;
  customPrompt?: string;
  imageCount?: number;
  mainOnly?: boolean;
  basePhotos?: string[];
};
function loadDraft(): Draft {
  if (typeof window === "undefined") return {};
  let d: Draft = {};
  try {
    d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "{}");
  } catch {
    d = {};
  }
  try {
    const p = sessionStorage.getItem(DRAFT_PHOTOS_KEY);
    if (p) d.basePhotos = JSON.parse(p);
  } catch {
    /* photos optional */
  }
  return d;
}

export function Workbench() {
  // Read any in-progress draft ONCE so the form survives tab switches.
  const [draft0] = useState<Draft>(loadDraft);
  const [step, setStep] = useState<Step>("input");
  const [productName, setProductName] = useState(draft0.productName ?? "");
  const [keywordInput, setKeywordInput] = useState("");
  const [keywords, setKeywords] = useState<string[]>(draft0.keywords ?? []);
  const [price, setPrice] = useState(draft0.price ?? 1990);
  // default 0 — never ship a struck-through "discount" the seller didn't choose.
  const [discount, setDiscount] = useState(draft0.discount ?? 0);
  const [brand, setBrand] = useState(draft0.brand ?? "");
  // package dims (cm) + gross weight (kg) — pre-filled from the seller's
  // configured defaults once settings load (unless a draft already has them).
  const [length, setLength] = useState(draft0.length ?? 20);
  const [width, setWidth] = useState(draft0.width ?? 15);
  const [height, setHeight] = useState(draft0.height ?? 5);
  const [weight, setWeight] = useState(draft0.weight ?? 0.3);
  const [basePhotos, setBasePhotos] = useState<string[]>(draft0.basePhotos ?? []);
  // English product video to dub into Russian and attach to the card (optional).
  // Restore the picked English video across tab switches (so the dub card +
  // 「配成俄语」button don't vanish when the listing re-hydrates into preview).
  const [videoPath, setVideoPath] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return sessionStorage.getItem("wb:videoPath");
    } catch {
      return null;
    }
  });
  // Collapse power-user fields (brand/dims/prompt/count/main-first) by default —
  // a plain seller only needs name + keywords + price + photos/video.
  const [showAdvanced, setShowAdvanced] = useState(draft0.showAdvanced ?? false);
  const [customPrompt, setCustomPrompt] = useState(draft0.customPrompt ?? "");
  const [imageCount, setImageCount] = useState(draft0.imageCount ?? 5);
  const [mainOnly, setMainOnly] = useState(draft0.mainOnly ?? false);
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
        // pre-fill package dims from the seller's configured defaults — but only if
        // a restored draft didn't already carry the seller's edited dims (else the
        // defaults would clobber what they typed before switching tabs).
        if (s.defaultLength && draft0.length == null) setLength(s.defaultLength);
        if (s.defaultWidth && draft0.width == null) setWidth(s.defaultWidth);
        if (s.defaultHeight && draft0.height == null) setHeight(s.defaultHeight);
        if (s.defaultWeight && draft0.weight == null) setWeight(s.defaultWeight);
      })
      .catch(() => {});
  }, [draft0]);

  // Persist the input form so a tab switch (which unmounts this component) never
  // wipes what the seller typed. Text fields are tiny → save on every change.
  useEffect(() => {
    try {
      const d: Draft = {
        productName,
        keywords,
        price,
        discount,
        brand,
        length,
        width,
        height,
        weight,
        showAdvanced,
        customPrompt,
        imageCount,
        mainOnly,
      };
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch {
      /* sessionStorage unavailable/full — text draft is best-effort */
    }
  }, [productName, keywords, price, discount, brand, length, width, height, weight, showAdvanced, customPrompt, imageCount, mainOnly]);

  // Photos separately (base64 → can be MBs): only re-serialize when they change,
  // and degrade gracefully if it overflows the quota (text draft still survives).
  useEffect(() => {
    try {
      if (basePhotos.length) sessionStorage.setItem(DRAFT_PHOTOS_KEY, JSON.stringify(basePhotos));
      else sessionStorage.removeItem(DRAFT_PHOTOS_KEY);
    } catch {
      try {
        sessionStorage.removeItem(DRAFT_PHOTOS_KEY);
      } catch {
        /* ignore */
      }
    }
  }, [basePhotos]);

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

  // Keep the picked video persisted so a tab switch → remount keeps the dub card.
  useEffect(() => {
    try {
      if (videoPath) sessionStorage.setItem("wb:videoPath", videoPath);
      else sessionStorage.removeItem("wb:videoPath");
    } catch {
      /* ignore */
    }
  }, [videoPath]);

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
      // Also clear the input DRAFT: once published, returning to the tab must start
      // a BLANK form for the next product — not re-show this finished one's fields.
      try {
        sessionStorage.removeItem("wb:listingId");
        sessionStorage.removeItem(DRAFT_KEY);
        sessionStorage.removeItem(DRAFT_PHOTOS_KEY);
        sessionStorage.removeItem("wb:videoPath");
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
    setVideoPath(null); // new product → drop the previous video (effect clears storage)
    // 重新开始 = a brand-new product → clear the typed form + persisted draft so the
    // next one starts blank (dims fall back to the seller's configured defaults).
    setProductName("");
    setKeywords([]);
    setKeywordInput("");
    setBrand("");
    setBasePhotos([]);
    setCustomPrompt("");
    setPrice(1990);
    setDiscount(0);
    setImageCount(5);
    setMainOnly(false);
    setShowAdvanced(false);
    setLength(settings?.defaultLength ?? 20);
    setWidth(settings?.defaultWidth ?? 15);
    setHeight(settings?.defaultHeight ?? 5);
    setWeight(settings?.defaultWeight ?? 0.3);
    try {
      sessionStorage.removeItem("wb:listingId");
      sessionStorage.removeItem(DRAFT_KEY);
      sessionStorage.removeItem(DRAFT_PHOTOS_KEY);
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

  const restMissing = listing
    ? Math.max(0, (listing.requestedImages ?? imageCount) - listing.images.length)
    : 0;
  const onInput = step === "input" || step === "generating";

  return (
    <div className="flex h-full min-h-0 flex-col animate-fade-up">
      {/* ── Hero band: title · env · step indicator — one compact row ── */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
          单品上架
        </h1>
        {settings && <EnvBadge dryRun={dryRun} sandbox={sandbox} />}
        <StepBar
          step={step}
          className="ml-auto"
          onJump={(n) => {
            if (step === "publishing" || step === "done" || !listing) return;
            if (n === 2) setStep("preview");
            else if (n === 3 && !listing.partial && !listing.nmID) setStep("review");
          }}
        />
      </div>

      {/* demo / token-expiry notice — one slim line, mutually exclusive */}
      {dryRun ? (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-500/[0.07] px-3 py-1.5 text-xs text-amber-700 dark:text-amber-200/90">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          <span>演示模式（未配 WB Token）：完整跑通并出图，但不会真实上架。</span>
          <Link
            href="/settings"
            className="ml-auto inline-flex shrink-0 items-center gap-1 font-medium underline"
          >
            <Settings className="h-3 w-3" /> 去配置
          </Link>
        </div>
      ) : (
        settings?.wbTokenExpiresInDays != null &&
        settings.wbTokenExpiresInDays <= 14 && (
          <div
            className={clsx(
              "mb-3 flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs",
              settings.wbTokenExpiresInDays < 0
                ? "border-rose-400/30 bg-rose-500/[0.08] text-rose-700 dark:text-rose-200"
                : "border-amber-400/20 bg-amber-500/[0.07] text-amber-700 dark:text-amber-200/90"
            )}
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>
              WB Token{" "}
              {settings.wbTokenExpiresInDays < 0
                ? "已过期"
                : settings.wbTokenExpiresInDays === 0
                ? "今天内到期"
                : `还有 ${settings.wbTokenExpiresInDays} 天过期`}
              —— 到期后无法上架/同步。
            </span>
            <Link href="/settings" className="ml-auto shrink-0 font-medium underline">
              去更新
            </Link>
          </div>
        )
      )}

      {/* ── Two zones: 控制台(左) · 预览(右) — fill remaining height, scroll inside ── */}
      <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(380px,420px)_1fr]">
        {/* ════ 左:控制台 ════ */}
        <section className="card flex min-h-0 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            {onInput ? (
              <InputForm
                productName={productName}
                setProductName={setProductName}
                keywordInput={keywordInput}
                setKeywordInput={setKeywordInput}
                keywords={keywords}
                setKeywords={setKeywords}
                addKeyword={addKeyword}
                price={price}
                setPrice={setPrice}
                wbBase={wbBase}
                dClamped={dClamped}
                priceOutOfRange={priceOutOfRange}
                basePhotos={basePhotos}
                setBasePhotos={setBasePhotos}
                photoRef={photoRef}
                onPhotos={onPhotos}
                videoPath={videoPath}
                setVideoPath={setVideoPath}
                showAdvanced={showAdvanced}
                setShowAdvanced={setShowAdvanced}
                discount={discount}
                setDiscount={setDiscount}
                brand={brand}
                setBrand={setBrand}
                length={length}
                setLength={setLength}
                width={width}
                setWidth={setWidth}
                height={height}
                setHeight={setHeight}
                weight={weight}
                setWeight={setWeight}
                customPrompt={customPrompt}
                setCustomPrompt={setCustomPrompt}
                imageCount={imageCount}
                setImageCount={setImageCount}
                mainOnly={mainOnly}
                setMainOnly={setMainOnly}
                disabled={step === "generating"}
              />
            ) : (
              listing && (
                <ProductSummary
                  listing={listing}
                  videoPath={videoPath}
                  onReset={reset}
                  locked={step === "publishing" || step === "done"}
                />
              )
            )}
          </div>

          {/* sticky action footer — the one CTA is always in view */}
          <div className="shrink-0 border-t border-slate-900/[0.06] px-5 py-4 dark:border-white/[0.06]">
            {error && step !== "publishing" && (
              <p className="mb-2.5 text-xs leading-relaxed text-rose-600 dark:text-rose-400">
                {error}
              </p>
            )}
            <PrimaryAction
              step={step}
              listing={listing}
              dryRun={dryRun}
              live={live}
              genMsg={genMsg}
              restLoading={restLoading}
              restMissing={restMissing}
              hasVideo={!!videoPath}
              onGenerate={handleGenerate}
              onPublish={handlePublish}
              onGenerateRest={doGenerateRest}
              onGoReview={() => setStep("review")}
              onBackToPreview={() => setStep("preview")}
              onReset={reset}
            />
          </div>
        </section>

        {/* ════ 右:预览 ════ */}
        <section className="min-h-0 overflow-y-auto pr-0.5">
          {step === "input" && (
            <LivePreview
              productName={productName}
              price={price}
              discount={dClamped}
              wbBase={wbBase}
              basePhotos={basePhotos}
              imageCount={imageCount}
              hasVideo={!!videoPath}
            />
          )}
          {step === "generating" && <GeneratingState msg={genMsg} />}
          {step === "preview" && listing && (
            <div className="space-y-4">
              <ImagesPanel
                listing={listing}
                onRegenerate={doRegenerate}
                regenLoading={regenLoading}
              />
              <CopyPanel key={listing.id} listing={listing} onUpdate={setListing} />
              {/* 视频归位:作为媒体的一部分,放在预览右侧图文下方 */}
              {videoPath && (
                <VideoPanel listing={listing} videoPath={videoPath} onUpdate={setListing} />
              )}
            </div>
          )}
          {step === "review" && listing && (
            <ReviewCard
              listing={listing}
              dryRun={dryRun}
              sandbox={sandbox}
              videoPath={videoPath}
              onUpdate={setListing}
            />
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
        </section>
      </div>
    </div>
  );
}

// ── Left: the input form (input/generating step) ──
interface InputFormProps {
  productName: string;
  setProductName: (v: string) => void;
  keywordInput: string;
  setKeywordInput: (v: string) => void;
  keywords: string[];
  setKeywords: React.Dispatch<React.SetStateAction<string[]>>;
  addKeyword: () => void;
  price: number;
  setPrice: (v: number) => void;
  wbBase: number;
  dClamped: number;
  priceOutOfRange: boolean;
  basePhotos: string[];
  setBasePhotos: React.Dispatch<React.SetStateAction<string[]>>;
  photoRef: React.RefObject<HTMLInputElement>;
  onPhotos: (e: React.ChangeEvent<HTMLInputElement>) => void;
  videoPath: string | null;
  setVideoPath: (v: string | null) => void;
  showAdvanced: boolean;
  setShowAdvanced: React.Dispatch<React.SetStateAction<boolean>>;
  discount: number;
  setDiscount: (v: number) => void;
  brand: string;
  setBrand: (v: string) => void;
  length: number;
  setLength: (v: number) => void;
  width: number;
  setWidth: (v: number) => void;
  height: number;
  setHeight: (v: number) => void;
  weight: number;
  setWeight: (v: number) => void;
  customPrompt: string;
  setCustomPrompt: (v: string) => void;
  imageCount: number;
  setImageCount: (v: number) => void;
  mainOnly: boolean;
  setMainOnly: (v: boolean) => void;
  disabled: boolean;
}

function InputForm(p: InputFormProps) {
  return (
    <fieldset disabled={p.disabled} data-tour="form" className="space-y-4 disabled:opacity-60">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
        <Tag className="h-4 w-4 text-wb-pink" /> 商品信息
      </div>

      <div>
        <label className="label">商品名 *</label>
        <input
          className="input"
          placeholder="如：无线蓝牙耳机 / Беспроводные наушники"
          value={p.productName}
          onChange={(e) => p.setProductName(e.target.value)}
        />
      </div>

      <div>
        <label className="label">关键字</label>
        <div className="flex gap-2">
          <input
            className="input"
            placeholder="回车添加，逗号分隔"
            value={p.keywordInput}
            onChange={(e) => p.setKeywordInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                p.addKeyword();
              }
            }}
          />
          <button className="btn-ghost px-3" onClick={p.addKeyword} type="button">
            <Plus className="h-4 w-4" />
          </button>
        </div>
        {p.keywords.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {p.keywords.map((k) => (
              <span key={k} className="chip">
                {k}
                <button
                  type="button"
                  onClick={() => p.setKeywords((arr) => arr.filter((x) => x !== k))}
                  className="text-slate-500 hover:text-rose-600 dark:hover:text-rose-400"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div>
        <label className="label">售价（到手价 · 按店铺币种）</label>
        <input
          type="number"
          className="input"
          value={p.price}
          min={1}
          onChange={(e) => p.setPrice(Number(e.target.value))}
        />
        {p.price > 0 && (
          <p
            className={clsx(
              "mt-1.5 text-xs leading-relaxed",
              p.priceOutOfRange ? "text-rose-600 dark:text-rose-400" : "text-slate-500"
            )}
          >
            提交给 WB 的划线价 ≈ <b>{p.wbBase.toLocaleString()}</b>（到手 {p.price} ÷ (1−
            {p.dClamped}%)）
            {p.priceOutOfRange && "；⚠ 超出常见区间 4–850000，可能被 WB 拒绝（跨境店按 CNY 计）"}
          </p>
        )}
      </div>

      {/* 素材:两个独立、含义清晰的上传区 */}
      <div>
        <label className="label">素材（都可选）</label>
        <div className="grid gap-3 sm:grid-cols-2">
          {/* 参考产品图 → 喂 AI */}
          <div className="rounded-xl border border-slate-900/[0.08] bg-slate-900/[0.02] p-3 dark:border-white/[0.07] dark:bg-white/[0.02]">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-200">
              <ImageIcon className="h-3.5 w-3.5 text-wb-purple" /> 参考产品图
            </div>
            <div className="flex flex-wrap gap-1.5">
              {p.basePhotos.map((ph, i) => (
                <div key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={ph}
                    alt=""
                    className="h-12 w-12 rounded-lg border border-slate-900/10 object-cover dark:border-white/10"
                  />
                  <button
                    type="button"
                    onClick={() => p.setBasePhotos((a) => a.filter((_, idx) => idx !== i))}
                    className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-rose-500 text-[10px] text-white"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => p.photoRef.current?.click()}
                className="grid h-12 w-12 place-items-center rounded-lg border border-dashed border-slate-900/15 text-slate-400 transition hover:border-wb-purple/50 hover:text-wb-purple dark:border-white/15"
              >
                <Plus className="h-4 w-4" />
              </button>
              <input
                ref={p.photoRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={p.onPhotos}
              />
            </div>
            <p className="mt-2 text-[11px] leading-snug text-slate-400">
              你的真实产品图。AI 据此出图；<b>留空则全自动生成</b>。
            </p>
          </div>

          {/* 英文产品视频 → 配俄语 */}
          <div className="rounded-xl border border-slate-900/[0.08] bg-slate-900/[0.02] p-3 dark:border-white/[0.07] dark:bg-white/[0.02]">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-200">
              <Video className="h-3.5 w-3.5 text-wb-pink" /> 产品视频 · 英文
            </div>
            {p.videoPath ? (
              <div className="flex items-center gap-2 rounded-lg border border-slate-900/10 bg-white px-2.5 py-2 text-xs dark:border-white/10 dark:bg-white/[0.04]">
                <Video className="h-4 w-4 shrink-0 text-wb-pink" />
                <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-300">
                  {p.videoPath.split(/[\\/]/).pop()}
                </span>
                <button
                  type="button"
                  onClick={() => p.setVideoPath(null)}
                  className="text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  const path = await api.dubPickVideo().catch(() => null);
                  if (path) p.setVideoPath(path);
                }}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-900/15 text-xs text-slate-400 transition hover:border-wb-pink/50 hover:text-wb-pink dark:border-white/15"
              >
                <Plus className="h-4 w-4" /> 选择视频
              </button>
            )}
            <p className="mt-2 text-[11px] leading-snug text-slate-400">
              你的英文产品视频。生成时<b>自动配成俄语</b>，随卡片上架。
            </p>
          </div>
        </div>
      </div>

      {/* 高级选项 fold */}
      <div className="border-t border-slate-900/[0.06] pt-3 dark:border-white/[0.06]">
        <button
          type="button"
          onClick={() => p.setShowAdvanced((s) => !s)}
          className="flex w-full items-center justify-between text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
        >
          高级选项（折扣 / 品牌 / 包裹 / 提示词 / 图片数量）
          <span>{p.showAdvanced ? "收起 ▲" : "展开 ▼"}</span>
        </button>

        {p.showAdvanced && (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">折扣 (%)</label>
                <input
                  type="number"
                  className="input"
                  value={p.discount}
                  min={0}
                  max={99}
                  onChange={(e) =>
                    p.setDiscount(Math.max(0, Math.min(99, Number(e.target.value) || 0)))
                  }
                />
              </div>
              <div>
                <label className="label">品牌（可选）</label>
                <input
                  className="input"
                  placeholder="留空自动生成"
                  value={p.brand}
                  onChange={(e) => p.setBrand(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="label">包裹尺寸 / 重量（按真实填写）</label>
              <div className="grid grid-cols-4 gap-2">
                {(
                  [
                    ["长", p.length, p.setLength, 1, "cm"],
                    ["宽", p.width, p.setWidth, 1, "cm"],
                    ["高", p.height, p.setHeight, 1, "cm"],
                    ["重", p.weight, p.setWeight, 0.1, "kg"],
                  ] as const
                ).map(([lab, val, setter, stepv, unit]) => (
                  <div key={lab}>
                    <input
                      type="number"
                      min={stepv}
                      step={stepv}
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
              <p className="mt-1 text-[11px] text-slate-500">
                WB 按包裹体积/重量计物流与仓储费并在入库复测——填错会被多收费。默认用「设置」里的值。
              </p>
            </div>

            <div>
              <label className="label">自定义提示词（可选）</label>
              <textarea
                className="input"
                rows={2}
                placeholder="如：极简风、青绿配色、突出 304 不锈钢"
                value={p.customPrompt}
                onChange={(e) => p.setCustomPrompt(e.target.value)}
              />
            </div>

            <div>
              <label className="label">生成图片数量</label>
              <div className="flex items-center gap-1.5">
                {[5, 8, 10].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => p.setImageCount(n)}
                    className={clsx(
                      "flex-1 rounded-lg border px-2 py-1.5 text-[12px] font-medium transition",
                      p.imageCount === n
                        ? "border-wb-pink bg-wb-pink/10 text-wb-pink"
                        : "border-slate-900/[0.1] text-slate-500 hover:text-slate-800 dark:border-white/[0.1] dark:text-slate-400 dark:hover:text-slate-200"
                    )}
                  >
                    {n} 张
                  </button>
                ))}
                <input
                  type="number"
                  className="input w-20"
                  min={1}
                  max={12}
                  value={p.imageCount}
                  onChange={(e) =>
                    p.setImageCount(Math.max(1, Math.min(12, Number(e.target.value) || 5)))
                  }
                  title="自定义（1–12）"
                />
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                主图(带设计) + 卖点/功能/场景/细节/尺寸/包装等不同图位；约 ~{p.imageCount} 张 ×
                2.5 分钟 ≈ <b>{Math.ceil(p.imageCount * 2.5)} 分钟</b>（逐张生成）
              </p>
            </div>

            <label className="flex cursor-pointer items-start gap-2.5 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-wb-purple"
                checked={p.mainOnly}
                onChange={(e) => p.setMainOnly(e.target.checked)}
              />
              <span>
                先只出主图
                <span className="mt-0.5 block text-xs text-slate-500">
                  确认满意后再出其余，省出图额度
                </span>
              </span>
            </label>
          </div>
        )}
      </div>
    </fieldset>
  );
}

// ── Left: product summary + actions (preview/publishing/done step) ──
function ProductSummary({
  listing,
  videoPath,
  onReset,
  locked,
}: {
  listing: Listing;
  videoPath: string | null;
  onReset: () => void;
  locked: boolean;
}) {
  const main = listing.images.find((i) => i.kind === "main") ?? listing.images[0];
  const lDisc = Math.max(0, Math.min(99, listing.discount || 0));
  const lBase =
    listing.price > 0
      ? lDisc > 0
        ? Math.round(listing.price / (1 - lDisc / 100))
        : Math.round(listing.price)
      : 0;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
          <Tag className="h-4 w-4 text-wb-pink" /> 本次商品
        </div>
        {!locked && (
          <button
            onClick={onReset}
            className="inline-flex items-center gap-1 text-xs text-slate-500 transition hover:text-slate-800 dark:hover:text-slate-200"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> 重新开始
          </button>
        )}
      </div>

      <div className="flex gap-3">
        <div className="h-20 w-16 shrink-0 overflow-hidden rounded-lg border border-slate-900/10 bg-slate-900/[0.03] dark:border-white/10 dark:bg-white/5">
          {main ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={main.url} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-slate-300">
              <ImageIcon className="h-5 w-5" />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
            {listing.productName || listing.copy?.title || "未命名商品"}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-base font-semibold text-wb-pink">
              {listing.price.toLocaleString()} ₽
            </span>
            {lDisc > 0 && (
              <span className="text-xs text-slate-400 line-through">{lBase.toLocaleString()}</span>
            )}
          </div>
          {listing.keywords.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {listing.keywords.slice(0, 4).map((k) => (
                <span key={k} className="chip px-2 py-0.5 text-[11px]">
                  {k}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 视频状态(只读;配音操作在右侧预览的视频卡) */}
      {videoPath && (
        <div className="flex items-center gap-1.5 border-t border-slate-900/[0.06] pt-3 text-[11px] text-slate-500 dark:border-white/[0.06] dark:text-slate-400">
          <Video className="h-3.5 w-3.5 text-wb-pink" />
          {listing.videoRu ? "视频已配俄语" : "视频待配(在预览点「配成俄语」)"}
        </div>
      )}

      {/* 类目/品牌 small facts */}
      {listing.copy && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-900/[0.06] pt-3 text-xs text-slate-500 dark:border-white/[0.06] dark:text-slate-400">
          <span>
            类目：
            <b className="text-slate-700 dark:text-slate-200">
              {listing.copy.categoryHint || "—"}
            </b>
          </span>
          <span>
            品牌：<b className="text-slate-700 dark:text-slate-200">{listing.copy.brand || "—"}</b>
          </span>
        </div>
      )}
    </div>
  );
}

// ── Right (review step): pre-publish 复核卡 — a clean summary before上架 ──
function ReviewCard({
  listing,
  dryRun,
  sandbox,
  videoPath,
  onUpdate,
}: {
  listing: Listing;
  dryRun: boolean;
  sandbox: boolean;
  videoPath: string | null;
  onUpdate?: (l: Listing) => void;
}) {
  const lDisc = Math.max(0, Math.min(99, listing.discount || 0));
  const base =
    listing.price > 0
      ? lDisc > 0
        ? Math.round(listing.price / (1 - lDisc / 100))
        : Math.round(listing.price)
      : 0;
  const cat = listing.subjectName || listing.copy?.categoryHint || "AI 自动选";
  const envLabel = dryRun ? "演示(不真实上架)" : sandbox ? "沙盒测试店铺" : "真实店铺(线上)";
  const media =
    `${listing.images.length} 图` +
    (listing.videoRu ? " + 1 俄语视频 ✓含俄配" : videoPath ? " + 1 视频(未配俄语)" : "");

  const rows: [string, React.ReactNode][] = [
    [
      "售价(到手价)",
      <span key="p">
        <b className="text-slate-900 dark:text-slate-100">{listing.price.toLocaleString()} ₽</b>
        {lDisc > 0 && (
          <span className="ml-1.5 text-xs text-slate-400">
            划线 {base.toLocaleString()} · -{lDisc}%
          </span>
        )}
      </span>,
    ],
    ["包裹尺寸/重量", <DimsCell key="d" listing={listing} onUpdate={onUpdate} />],
    ["类目", cat],
    ["媒体", media],
    [
      "上架到",
      <span
        key="e"
        className={clsx(
          "rounded-full border px-2 py-0.5 text-[11px] font-medium",
          dryRun
            ? "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300"
            : sandbox
            ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300"
            : "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300"
        )}
      >
        {envLabel}
      </span>,
    ],
  ];

  return (
    <div className="card p-6">
      <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
        <Rocket className="h-4 w-4 text-wb-pink" /> 发布复核
        <span className="ml-auto text-xs font-normal text-slate-400">确认无误后点左下「确认上架」</span>
      </div>

      <div className="rounded-xl border border-slate-900/[0.08] dark:border-white/[0.07]">
        {rows.map(([k, v], i) => (
          <div
            key={k}
            className={clsx(
              "flex items-center justify-between gap-3 px-4 py-3 text-sm",
              i < rows.length - 1 && "border-b border-slate-900/[0.06] dark:border-white/[0.06]"
            )}
          >
            <span className="text-slate-500 dark:text-slate-400">{k}</span>
            <span className="text-right text-slate-800 dark:text-slate-100">{v}</span>
          </div>
        ))}
      </div>

      {/* 高级 · 全部商品参数(默认折叠) */}
      <ParamsEditor listing={listing} />

      <div className="mt-3 flex items-start gap-1.5 rounded-xl bg-slate-900/[0.04] px-3.5 py-2.5 text-[11px] leading-relaxed text-slate-500 dark:bg-white/5 dark:text-slate-400">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
        库存默认不自动设;上架后到「商品管理」给商品设库存才会真正可售。不展开「全部商品参数」时,特征按类目 AI 自动填。
      </div>
    </div>
  );
}

// 复核里「包裹尺寸/重量」可就地改 —— WB 按体积/重量计物流仓储费,发布前能改最稳。
function DimsCell({ listing, onUpdate }: { listing: Listing; onUpdate?: (l: Listing) => void }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [l, setL] = useState(listing.length || 20);
  const [w, setW] = useState(listing.width || 15);
  const [h, setH] = useState(listing.height || 5);
  const [kg, setKg] = useState(listing.weight || 0.3);

  // Resync the edit fields if the listing's dimensions change from elsewhere
  // (while not actively editing), so reopening never shows stale values.
  useEffect(() => {
    if (editing) return;
    setL(listing.length || 20);
    setW(listing.width || 15);
    setH(listing.height || 5);
    setKg(listing.weight || 0.3);
  }, [listing.length, listing.width, listing.height, listing.weight, editing]);

  const has = !!(listing.length || listing.width || listing.height || listing.weight);
  const text = has
    ? `${listing.length ?? "—"}×${listing.width ?? "—"}×${listing.height ?? "—"}cm · ${listing.weight ?? "—"}kg`
    : "默认";

  async function save() {
    setSaving(true);
    try {
      const updated = await api.updateDimensions(listing.id, {
        length: Math.max(0, l),
        width: Math.max(0, w),
        height: Math.max(0, h),
        weight: Math.max(0, kg),
      });
      onUpdate?.(updated);
      setEditing(false);
    } catch {
      /* keep editing open so the user can retry */
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-2">
        {text}
        <button
          className="text-[11px] text-wb-purple hover:underline"
          onClick={() => setEditing(true)}
        >
          改
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1">
      {(
        [
          ["长", l, setL, 1],
          ["宽", w, setW, 1],
          ["高", h, setH, 1],
          ["重", kg, setKg, 0.1],
        ] as const
      ).map(([lab, val, setter, step]) => (
        <span key={lab} className="inline-flex items-center gap-0.5">
          <input
            type="number"
            min={0}
            step={step}
            value={val}
            onChange={(e) => setter(Math.max(0, Number(e.target.value) || 0))}
            className="input w-14 px-1 py-1 text-center text-xs"
          />
          <span className="text-[10px] text-slate-400">{lab}</span>
        </span>
      ))}
      <button
        className="btn-primary ml-1 px-2.5 py-1 text-[11px]"
        onClick={save}
        disabled={saving}
      >
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "存"}
      </button>
      <button
        className="text-[11px] text-slate-400 hover:text-slate-600"
        onClick={() => setEditing(false)}
      >
        取消
      </button>
    </span>
  );
}

// 高级·全部商品参数 编辑器 —— 默认折叠。展开后按类目拉特征字典,可逐项编辑;
// 留空的项发布时 AI 兜底。保存写入 listing,publish 时「用户值优先」。
function ParamsEditor({ listing }: { listing: Listing }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [subjectId, setSubjectId] = useState<number | null>(listing.subjectId ?? null);
  const [subjectName, setSubjectName] = useState<string>(
    listing.subjectName ?? listing.copy?.categoryHint ?? ""
  );
  const [charcs, setCharcs] = useState<WbCharacteristic[]>([]);
  const [values, setValues] = useState<Record<number, string>>({});
  const [colors, setColors] = useState<WbColor[]>([]);
  const [tnved, setTnved] = useState<string>(listing.tnved ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [predicting, setPredicting] = useState(false);
  const [catQuery, setCatQuery] = useState("");
  const [catResults, setCatResults] = useState<WbSubject[]>([]);
  const [catSearching, setCatSearching] = useState(false);

  async function loadFor(sid: number, sname: string) {
    setLoading(true);
    setErr(null);
    const fmt = (v: unknown) =>
      Array.isArray(v) ? (v as unknown[]).join(", ") : String(v ?? "");
    try {
      // Only the category dictionary blocks the form (fast). Show it right away.
      const [cs, cols] = await Promise.all([
        api.subjectCharacteristics(sid),
        api.wbColors().catch(() => [] as WbColor[]),
      ]);
      setCharcs(cs);
      setColors(cols);
      const saved = listing.characteristics ?? [];
      const pre: Record<number, string> = {};
      saved.forEach((c) => {
        pre[c.id] = fmt(c.value);
      });
      setValues(pre);
      setSubjectId(sid);
      setSubjectName(sname);
      setLoaded(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "读取类目特征失败");
      setLoading(false);
      return;
    }
    setLoading(false); // form is interactive now

    // Background (don't block the form): AI pre-fill of ~20 standard values, and
    // the TNVED lookup. The「AI 正在填充」indicator covers the predict.
    if ((listing.characteristics ?? []).length === 0) {
      setPredicting(true);
      api
        .predictCharacteristics(listing.id, sid)
        .then((pred) => {
          const pv: Record<number, string> = {};
          pred.forEach((c) => {
            pv[c.id] = fmt(c.value);
          });
          setValues((cur) => (Object.keys(cur).length ? cur : pv));
        })
        .catch(() => {
          /* non-fatal: leave blank, publish still auto-fills */
        })
        .finally(() => setPredicting(false));
    }
    if (!tnved) {
      api
        .wbTnved(sid)
        .then((t) => {
          if (t) setTnved(t);
        })
        .catch(() => {});
    }
  }

  async function expand() {
    const next = !open;
    setOpen(next);
    if (next && !loaded && !loading) {
      let sid = subjectId;
      let sname = subjectName;
      if (!sid) {
        try {
          const res = await api.searchSubjects(subjectName || listing.productName);
          if (res[0]) {
            sid = res[0].subjectID;
            sname = res[0].subjectName;
          }
        } catch {
          /* ignore */
        }
      }
      if (sid) await loadFor(sid, sname);
      else setErr("未能自动解析类目,请在下方搜索手动选一个。");
    }
  }

  async function searchCat() {
    if (!catQuery.trim()) return;
    setCatSearching(true);
    try {
      setCatResults(await api.searchSubjects(catQuery.trim()));
    } catch {
      setCatResults([]);
    } finally {
      setCatSearching(false);
    }
  }
  async function pickCat(s: WbSubject) {
    setCatResults([]);
    setCatQuery("");
    setLoaded(false);
    await loadFor(s.subjectID, s.subjectName);
  }

  function valueFor(c: WbCharacteristic): unknown {
    const raw = (values[c.charcID] ?? "").trim();
    if (!raw) return null;
    if (c.charcType === 4) {
      const n = Number(raw);
      return Number.isNaN(n) ? null : n;
    }
    return raw
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function save() {
    if (!subjectId) {
      setErr("请先选类目");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const characteristics = charcs
        .map((c) => ({ id: c.charcID, value: valueFor(c) }))
        .filter((x) => x.value !== null && !(Array.isArray(x.value) && x.value.length === 0));
      await api.updateParams(listing.id, {
        subjectId,
        subjectName,
        characteristics,
        tnved: tnved.trim(),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  const isColor = (c: WbCharacteristic) => /цвет|color/i.test(c.name);

  return (
    <div className="mt-3 rounded-xl border border-slate-900/[0.08] dark:border-white/[0.07]">
      <button
        type="button"
        onClick={expand}
        className="flex w-full items-center justify-between px-4 py-3 text-sm"
      >
        <span className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
          <Settings className="h-4 w-4 text-wb-purple" /> 高级 · 全部商品参数
          <span className="text-[11px] font-normal text-slate-400">(默认按 AI 推荐,可逐项改)</span>
        </span>
        <ChevronDown
          className={clsx("h-4 w-4 text-slate-400 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="border-t border-slate-900/[0.06] px-4 py-3 dark:border-white/[0.06]">
          {/* 类目 + 改类目 */}
          <div className="mb-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500">类目</span>
              <span className="text-xs font-medium text-slate-800 dark:text-slate-100">
                {subjectName || "未解析"}
              </span>
            </div>
            <div className="mt-1.5 flex gap-2">
              <input
                className="input px-2.5 py-1.5 text-xs"
                placeholder="改类目:搜关键词(如 наушники / 耳机)"
                value={catQuery}
                onChange={(e) => setCatQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    searchCat();
                  }
                }}
              />
              <button className="btn-ghost shrink-0 px-2.5 py-1.5 text-xs" onClick={searchCat} disabled={catSearching}>
                {catSearching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              </button>
            </div>
            {catResults.length > 0 && (
              <div className="mt-1.5 max-h-32 overflow-auto rounded-lg border border-slate-900/[0.08] dark:border-white/[0.07]">
                {catResults.map((s) => (
                  <button
                    key={s.subjectID}
                    onClick={() => pickCat(s)}
                    className="block w-full px-3 py-1.5 text-left text-xs hover:bg-slate-900/[0.04] dark:hover:bg-white/5"
                  >
                    {s.subjectName}
                    {s.parentName && <span className="text-slate-400"> · {s.parentName}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {loading ? (
            <div className="flex items-center gap-2 py-4 text-xs text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> 读取该类目的全部参数…
            </div>
          ) : charcs.length > 0 ? (
            <>
              <div className="mb-1.5 flex items-center gap-2 text-xs text-slate-500">
                {predicting ? (
                  <span className="flex items-center gap-1.5 text-wb-purple">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> AI 正在按类目填充标准特征值…
                  </span>
                ) : (
                  <>
                    商品特征(该类目共 {charcs.length} 项,已为你填好{" "}
                    <b className="text-slate-700 dark:text-slate-200">
                      {Object.values(values).filter((v) => v && v.trim()).length}
                    </b>{" "}
                    项;可逐项改,留空的发布时仍会 AI 兜底)
                  </>
                )}
              </div>
              <div className="max-h-72 space-y-2 overflow-auto pr-1">
                {charcs.map((c) => (
                  <div key={c.charcID} className="grid grid-cols-[1fr_1.4fr] items-center gap-2">
                    <span
                      className="min-w-0 text-xs text-slate-600 dark:text-slate-300"
                      title={c.nameZh ? `${c.nameZh} · ${c.name}` : c.name}
                    >
                      <span className="block truncate text-slate-700 dark:text-slate-200">
                        {c.nameZh || c.name}
                        {c.required && <span className="text-rose-500"> *</span>}
                        {c.unitName && <span className="text-slate-400"> ({c.unitName})</span>}
                      </span>
                      {c.nameZh && c.nameZh !== c.name && (
                        <span className="block truncate text-[10px] text-slate-400">{c.name}</span>
                      )}
                    </span>
                    {isColor(c) && colors.length > 0 ? (
                      <select
                        className="input px-2 py-1.5 text-xs"
                        value={values[c.charcID] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [c.charcID]: e.target.value }))}
                      >
                        <option value="">（自动）</option>
                        {colors.map((col) => (
                          <option key={col.name} value={col.name}>
                            {col.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={c.charcType === 4 ? "number" : "text"}
                        className="input px-2 py-1.5 text-xs"
                        placeholder={c.charcType === 4 ? "数字" : "留空 = AI 填"}
                        value={values[c.charcID] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [c.charcID]: e.target.value }))}
                      />
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : loaded ? (
            <div className="py-3 text-xs text-slate-400">该类目没有可填特征。</div>
          ) : null}

          {/* TNVED */}
          <div className="mt-3 grid grid-cols-[1fr_1.4fr] items-center gap-2">
            <span className="text-xs text-slate-600 dark:text-slate-300">TNVED 海关编码</span>
            <input
              className="input px-2 py-1.5 text-xs"
              placeholder="留空 = 按类目自动"
              value={tnved}
              onChange={(e) => setTnved(e.target.value)}
            />
          </div>

          {err && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{err}</p>}
          <div className="mt-3 flex items-center justify-end gap-2">
            {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">已保存</span>}
            <button
              className="btn-primary px-3 py-1.5 text-xs"
              onClick={save}
              disabled={saving || !subjectId}
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} 保存参数
            </button>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            尺码/颜色多变体(多 barcode)暂为单一规格,后续支持。
          </p>
        </div>
      )}
    </div>
  );
}

// ── Left footer: the single primary CTA, by step ──
function PrimaryAction({
  step,
  listing,
  dryRun,
  live,
  genMsg,
  restLoading,
  restMissing,
  hasVideo,
  onGenerate,
  onPublish,
  onGenerateRest,
  onGoReview,
  onBackToPreview,
  onReset,
}: {
  step: Step;
  listing: Listing | null;
  dryRun: boolean;
  live: boolean;
  genMsg: string;
  restLoading: boolean;
  restMissing: number;
  hasVideo: boolean;
  onGenerate: () => void;
  onPublish: () => void;
  onGenerateRest: () => void;
  onGoReview: () => void;
  onBackToPreview: () => void;
  onReset: () => void;
}) {
  if (step === "input") {
    return (
      <>
        <button className="btn-primary w-full" data-tour="generate" onClick={onGenerate}>
          <Sparkles className="h-4 w-4" /> 一键生成
        </button>
        <p className="mt-2 text-center text-[11px] text-slate-400">
          生成俄语图文 + 配图 · 消耗你的 Aurixel 余额{hasVideo ? "（视频在预览里点「配成俄语」）" : ""}
        </p>
      </>
    );
  }
  if (step === "generating") {
    return (
      <button className="btn-primary w-full" disabled>
        <Loader2 className="h-4 w-4 animate-spin" /> {genMsg || "生成中…"}
      </button>
    );
  }
  if (step === "preview" && listing) {
    if (listing.partial) {
      return (
        <button className="btn-primary w-full" onClick={onGenerateRest} disabled={restLoading}>
          {restLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> {genMsg || "生成其余…"}
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" /> 满意，继续生成其余 {restMissing} 张
            </>
          )}
        </button>
      );
    }
    if (!listing.nmID) {
      return (
        <>
          <button className="btn-primary w-full" onClick={onGoReview}>
            发布复核 <ArrowRight className="h-4 w-4" />
          </button>
          <p className="mt-2 text-center text-[11px] text-slate-400">下一步看一遍要上架的内容再确认</p>
        </>
      );
    }
    return (
      <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/[0.08] px-3 py-2.5 text-xs text-emerald-700 dark:text-emerald-200">
        已上架（nmID {listing.nmID}）。补图/改价请到「商品管理」。
      </div>
    );
  }
  if (step === "review" && listing) {
    return (
      <>
        <button className="btn-primary w-full" onClick={onPublish}>
          <Rocket className="h-4 w-4" />
          {dryRun ? "确认演示上架" : live ? "确认上架到 Wildberries（线上）" : "确认上架到沙盒（测试）"}
        </button>
        <button
          className="mt-2 w-full text-center text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          onClick={onBackToPreview}
        >
          ← 返回预览修改
        </button>
      </>
    );
  }
  if (step === "publishing") {
    return (
      <button className="btn-primary w-full" disabled>
        <Loader2 className="h-4 w-4 animate-spin" /> 上架中…
      </button>
    );
  }
  // done
  return (
    <button className="btn-ghost w-full" onClick={onReset}>
      <Sparkles className="h-4 w-4" /> 再来一个
    </button>
  );
}

// ── Right (input step): live WB-card preview reflecting what you type ──
function LivePreview({
  productName,
  price,
  discount,
  wbBase,
  basePhotos,
  imageCount,
  hasVideo,
}: {
  productName: string;
  price: number;
  discount: number;
  wbBase: number;
  basePhotos: string[];
  imageCount: number;
  hasVideo: boolean;
}) {
  return (
    <div className="card flex h-full min-h-0 flex-col p-5">
      <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
        <Eye className="h-4 w-4 text-wb-pink" /> 实时预览
        <span className="ml-auto text-xs font-normal text-slate-400">生成后这里出成品</span>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center rounded-2xl border border-dashed border-slate-900/10 bg-slate-900/[0.015] p-6 dark:border-white/10 dark:bg-white/[0.015]">
        {/* a WB-card-shaped mock */}
        <div className="w-full max-w-[240px]">
          <div className="aspect-[3/4] overflow-hidden rounded-xl border border-slate-900/10 bg-white dark:border-white/10 dark:bg-white/5">
            {basePhotos[0] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={basePhotos[0]} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-slate-300 dark:text-slate-600">
                <ImageIcon className="h-9 w-9" />
                <span className="text-[11px] text-slate-400">AI 主图将显示在这里</span>
              </div>
            )}
          </div>
          <div className="mt-3">
            <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
              {productName.trim() || "商品标题（俄文）将在这里"}
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-lg font-semibold text-wb-pink">
                {price > 0 ? `${price.toLocaleString()} ₽` : "—"}
              </span>
              {discount > 0 && wbBase > 0 && (
                <span className="text-xs text-slate-400 line-through">
                  {wbBase.toLocaleString()}
                </span>
              )}
              <span className="text-[11px] text-slate-400">到手价</span>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 shrink-0 rounded-xl bg-slate-900/[0.04] px-3.5 py-3 text-xs leading-relaxed text-slate-600 dark:bg-white/5 dark:text-slate-300">
        <span className="font-medium text-slate-800 dark:text-slate-100">点「一键生成」后产出：</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <span className="chip">
            <ImageIcon className="h-3 w-3 text-wb-purple" /> 图片 ×{imageCount}
          </span>
          <span className="chip">
            <Sparkles className="h-3 w-3 text-wb-pink" /> 俄语文案 + 中文对照
          </span>
          {hasVideo && (
            <span className="chip">
              <Video className="h-3 w-3 text-wb-pink" /> 视频配俄语
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function StepBar({
  step,
  className,
  onJump,
}: {
  step: Step;
  className?: string;
  onJump?: (n: number) => void;
}) {
  const cur = step === "input" ? 1 : step === "preview" || step === "generating" ? 2 : 3;
  const steps = ["输入", "预览", "发布"];
  return (
    <div className={clsx("flex items-center", className)}>
      {steps.map((s, i) => {
        const n = i + 1;
        const isDone = n < cur;
        const act = n === cur;
        const clickable = !!onJump && n !== cur && n >= 2;
        return (
          <div key={s} className="flex items-center">
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onJump?.(n)}
              className={clsx("flex items-center", clickable && "cursor-pointer")}
            >
              <span
                className={clsx(
                  "grid h-6 w-6 place-items-center rounded-full text-[11px] font-medium transition-all",
                  act
                    ? "bg-gradient-to-br from-wb-pink to-wb-purple text-white shadow-sm"
                    : isDone
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "border border-slate-900/10 text-slate-400 dark:border-white/10"
                )}
              >
                {isDone ? <CheckCircle2 className="h-3.5 w-3.5" /> : n}
              </span>
              <span
                className={clsx(
                  "ml-1.5 text-xs",
                  act ? "font-medium text-slate-900 dark:text-white" : "text-slate-400"
                )}
              >
                {s}
              </span>
            </button>
            {i < steps.length - 1 && (
              <div className="mx-2.5 h-px w-6 bg-slate-900/10 dark:bg-white/10" />
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
  const [savingIdx, setSavingIdx] = useState<number | null>(null);
  const [savedIdx, setSavedIdx] = useState<number | null>(null);
  async function downloadImg(url: string, kind: string, i: number) {
    if (savingIdx !== null) return;
    setSavingIdx(i);
    try {
      const path = await api.saveImageFile(url, `${labels[kind] ?? kind}-${i + 1}.jpg`);
      if (path) {
        setSavedIdx(i);
        setTimeout(() => setSavedIdx((v) => (v === i ? null : v)), 1800);
      }
    } catch (e) {
      alert("保存失败：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSavingIdx(null);
    }
  }
  return (
    <div className="card p-6">
      <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
        <ImageIcon className="h-4 w-4 text-wb-pink" /> 生成的图片
        <span className="text-xs font-normal text-slate-400">（不满意可单张重生成）</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {listing.images.map((img, i) => {
          const busy = regenLoading === i;
          return (
            <div
              key={img.id}
              className="group relative overflow-hidden rounded-xl border border-slate-900/10 dark:border-white/10"
            >
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
                <button
                  onClick={() => downloadImg(img.url, img.kind, i)}
                  disabled={savingIdx !== null}
                  title="下载这张图片"
                  className="grid h-8 w-8 place-items-center rounded-lg bg-black/50 text-white backdrop-blur disabled:opacity-50"
                >
                  {savingIdx === i ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : savedIdx === i ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                </button>
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
      const bullets = eBullets
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
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
              <p className="rounded-lg bg-slate-900/[0.04] px-3 py-2 text-slate-900 dark:bg-white/5 dark:text-slate-100">
                {copy.title}
              </p>
            )}
            {showZh && copy.titleZh && (
              <p
                className={clsx(
                  "text-slate-500 dark:text-slate-400",
                  showRu
                    ? "mt-1 px-3 text-xs"
                    : "rounded-lg bg-slate-900/[0.04] px-3 py-2 text-slate-700 dark:bg-white/5 dark:text-slate-300"
                )}
              >
                {copy.titleZh}
              </p>
            )}
          </div>
          <div>
            <span className="label">描述</span>
            {showRu && (
              <p className="max-h-32 overflow-auto rounded-lg bg-slate-900/[0.04] px-3 py-2 leading-relaxed text-slate-700 dark:bg-white/5 dark:text-slate-300">
                {copy.description}
              </p>
            )}
            {showZh && copy.descriptionZh && (
              <p
                className={clsx(
                  "max-h-32 overflow-auto leading-relaxed text-slate-500 dark:text-slate-400",
                  showRu
                    ? "mt-1 px-3 text-xs"
                    : "rounded-lg bg-slate-900/[0.04] px-3 py-2 text-slate-700 dark:bg-white/5 dark:text-slate-300"
                )}
              >
                {copy.descriptionZh}
              </p>
            )}
          </div>
          {copy.bullets.length > 0 && (
            <div>
              <span className="label">卖点</span>
              <ul className="space-y-1.5">
                {copy.bullets.map((b, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-slate-700 dark:text-slate-300"
                  >
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <span>
                      {showRu && <span>{b}</span>}
                      {showZh && copy.bulletsZh?.[i] && (
                        <span
                          className={clsx(
                            "block text-slate-500 dark:text-slate-400",
                            showRu ? "mt-0.5 text-xs" : ""
                          )}
                        >
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
            <span>
              类目: <b className="text-slate-800 dark:text-slate-200">{copy.categoryHint || "—"}</b>
            </span>
            <span>
              品牌: <b className="text-slate-800 dark:text-slate-200">{copy.brand}</b>
            </span>
            <span>
              vendorCode:{" "}
              <b className="text-slate-800 dark:text-slate-200">{listing.vendorCode}</b>
            </span>
          </div>
          {copy.keywords.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {copy.keywords.map((k) => (
                <span key={k} className="chip text-xs">
                  {k}
                </span>
              ))}
            </div>
          )}
          {copy.imagePrompt && (
            <details className="pt-1">
              <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200">
                文生图提示词（英文）
              </summary>
              <p className="mt-1.5 rounded-lg bg-slate-900/[0.04] px-3 py-2 text-xs leading-relaxed text-slate-500 dark:bg-white/5 dark:text-slate-400">
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
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  // Calm, informational note for a per-speaker CLONE fallback (a secondary speaker
  // used a preset voice). NOT an engine failure — kept separate from `notice` so it
  // doesn't show the alarming "引擎未生效 / 去下载引擎" banner (downloading won't help).
  const [cloneNote, setCloneNote] = useState<string | null>(null);
  const [preset, setPreset] = useState<DubPreset>(DUB_PRESET_DEFAULT);
  // 烧入俄语字幕(默认开):WB 信息流常静音自动播放,字幕保证看懂。复用配音已有翻译,
  // 几乎零额外成本(只多一次视频重编码)。
  const [subtitles, setSubtitles] = useState(true);
  const [engineReady, setEngineReady] = useState(false);
  const canceling = useRef(false);
  const done = !!listing.videoRu;

  // Know whether the engine is already downloaded → don't keep saying "首次会下载".
  useEffect(() => {
    api.dubEngineStatus().then((s) => setEngineReady(s.ready)).catch(() => {});
  }, []);

  // Degrade/clone/subtitle notes accumulate across progress events.
  const lostRef = useRef<Set<string>>(new Set());
  // Map a dub:progress `warn` → the right calm/alarm note. Shared by the live dub()
  // and the re-attach effect so both behave identically.
  function applyWarn(w?: string) {
    if (!w) return;
    const lost = lostRef.current;
    if (/stem|background|raw audio|voice-select|single renders|stall/i.test(w)) {
      if (/stem|background|raw audio/i.test(w)) lost.add("未保留背景音乐");
      if (/voice-select|single renders/i.test(w)) lost.add("音色一致性略降");
      setNotice(
        `配音引擎未生效，已自动降级（${[...lost].join("、") || "降级出片"}）。成片仍会生成；如需最佳效果，到「设置→配音引擎」先点「测试」确认，再用「高质量」重配。`
      );
      let inner = w;
      const k = inner.indexOf("skipped (");
      if (k >= 0) inner = inner.slice(k + "skipped (".length);
      inner = inner.replace(/\)\s*—\s*raw audio[\s\S]*$/, "").trim();
      setDetail((inner || w).slice(0, 4000));
      return;
    }
    if (/preset voice|couldn't clone/i.test(w)) {
      setCloneNote(
        "检测到次要说话人，但其清晰语音不足，无法克隆，已用预设音色顶替（主播仍为克隆原声）。若此视频其实只有一位讲解人，告诉我即可改为全程同一音色。"
      );
      return;
    }
    if (/subtitle/i.test(w)) {
      setCloneNote("俄语字幕未能烧入（成片已生成、配音正常，仅缺字幕）。可重试一次；若反复失败请反馈。");
      return;
    }
  }

  // Re-attach to a dub that's still running in the backend after a tab switch
  // (the component unmounts but the node process keeps going). Show 配音中… and
  // recover the result via the dub:done / dub:progress events — instead of looking
  // idle and letting the user re-dub into the still-occupied slot ("配音失败").
  useEffect(() => {
    if (typeof window === "undefined" || done) return;
    let running = false;
    try {
      const raw = sessionStorage.getItem(DUBBING_KEY);
      running = !!raw && JSON.parse(raw)?.id === listing.id;
    } catch {
      running = false;
    }
    if (!running) return;
    setBusy(true);
    setStage("配音中…");
    setErr(null);
    lostRef.current = new Set();
    const clearFlag = () => {
      try {
        sessionStorage.removeItem(DUBBING_KEY);
      } catch {
        /* ignore */
      }
    };
    const uns: Array<() => void> = [];
    listen<{ stage: string; warn?: string; error?: string }>("dub:progress", (e) => {
      const p = e.payload;
      setStage(p.stage);
      if (p.stage === "failed") {
        setErr(p.error || "配音失败");
        setBusy(false);
        clearFlag();
      } else if (p.stage === "cancelled") {
        setBusy(false);
        clearFlag();
      } else applyWarn(p.warn);
    }).then((u) => uns.push(u));
    listen<{ out?: string }>("dub:done", (e) => {
      const out = e.payload?.out;
      if (out) api.setListingVideo(listing.id, out).then(onUpdate).catch(() => {});
      setBusy(false);
      setStage("");
      clearFlag();
    }).then((u) => uns.push(u));
    return () => uns.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing.id, done]);

  function cancel() {
    canceling.current = true;
    setStage("正在取消…");
    api.dubCancel().catch(() => {});
  }

  async function dub() {
    setBusy(true);
    setErr(null);
    setNotice(null);
    setDetail(null);
    setCloneNote(null);
    canceling.current = false;
    setStage("自检…");
    lostRef.current = new Set();
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
      // Mark a dub in-flight so a tab switch can re-attach (see the effect above).
      try {
        sessionStorage.setItem(DUBBING_KEY, JSON.stringify({ id: listing.id }));
      } catch {
        /* ignore */
      }
      // Surface auto-degrade THE MOMENT it happens (don't wait for completion).
      un = await listen<{ stage: string; warn?: string }>("dub:progress", (e) => {
        setStage(e.payload.stage);
        applyWarn(e.payload.warn);
      });
      const out = await api.dubStart({
        inputPath: videoPath,
        voiceMode: "clone",
        subtitles,
        ...dubPresetOptions(preset),
      });
      onUpdate(await api.setListingVideo(listing.id, out));
    } catch (e) {
      if (!canceling.current) setErr(e instanceof Error ? e.message : "配音失败");
    } finally {
      un?.();
      setBusy(false);
      setStage("");
      canceling.current = false;
      try {
        sessionStorage.removeItem(DUBBING_KEY);
      } catch {
        /* ignore */
      }
    }
  }

  async function reDub() {
    setNotice(null);
    setDetail(null);
    setCloneNote(null);
    onUpdate(await api.setListingVideo(listing.id, ""));
  }

  return (
    <div className="rounded-xl border border-slate-900/[0.08] bg-slate-900/[0.02] p-3.5 dark:border-white/[0.07] dark:bg-white/[0.02]">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200">
        <Video className="h-3.5 w-3.5 text-wb-pink" /> 产品视频
        {done && (
          <span className="chip border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-3 w-3" /> 已配俄语
          </span>
        )}
      </div>
      <div className="mb-2 truncate text-[11px] text-slate-500 dark:text-slate-400">
        {videoPath.split(/[\\/]/).pop()}
      </div>
      {done ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-emerald-700 dark:text-emerald-300">
            发布时随卡片一起上传。
          </span>
          <button className="btn-ghost px-2.5 py-1 text-xs" onClick={reDub}>
            <RefreshCw className="h-3 w-3" /> 重配
          </button>
        </div>
      ) : busy ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-wb-pink" /> 配音中…
            <span className="min-w-0 flex-1 truncate text-slate-400">{stage}</span>
            <button
              onClick={cancel}
              className="shrink-0 text-[11px] text-slate-500 hover:text-rose-600 dark:hover:text-rose-400"
            >
              取消
            </button>
          </div>
          {preset !== "fast" && !engineReady && (
            <p className="rounded-md bg-amber-500/[0.08] px-2 py-1 text-[10.5px] leading-relaxed text-amber-700 dark:text-amber-200">
              首次使用「{DUB_PRESETS.find((p) => p.id === preset)?.label}」会联网下载配音引擎（约
              0.5–1GB，<b>仅首次</b>），可能要几分钟、进度可能看着不动属正常；完成前别关，可随时「取消」。建议先到「设置→配音引擎」一次性下载好。
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-0.5 rounded-lg border border-slate-900/[0.08] bg-slate-900/[0.03] p-0.5 dark:border-white/[0.06] dark:bg-white/[0.03]">
            {DUB_PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPreset(p.id)}
                title={p.hint}
                className={clsx(
                  "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition",
                  preset === p.id
                    ? "bg-white text-slate-900 shadow-sm dark:bg-white/[0.14] dark:text-white"
                    : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-2 px-0.5 text-[11px] text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={subtitles}
              onChange={(e) => setSubtitles(e.target.checked)}
              className="h-3.5 w-3.5 accent-wb-pink"
            />
            烧入俄语字幕（信息流静音播放也能看懂；几乎零成本）
          </label>
          <button
            className="btn-primary w-full py-2 text-xs"
            onClick={dub}
            disabled={!!listing.nmID}
          >
            <Video className="h-3.5 w-3.5" /> 配成俄语
          </button>
        </div>
      )}
      {err && <p className="mt-2 break-words text-[11px] text-rose-600 dark:text-rose-400">{err}</p>}
      {notice && (
        <p className="mt-2 break-words rounded-md bg-amber-500/[0.1] px-2 py-1 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
          ⚠️ {notice}
        </p>
      )}
      {detail && (
        <pre className="mt-1 max-h-40 select-text overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-500/[0.06] px-2 py-1 text-[10px] leading-relaxed text-slate-400 dark:text-slate-500">
          详情：{detail}
        </pre>
      )}
      {cloneNote && (
        <p className="mt-2 break-words rounded-md bg-sky-500/[0.08] px-2 py-1 text-[11px] leading-relaxed text-sky-700 dark:text-sky-300">
          ℹ️ {cloneNote}
        </p>
      )}
      {!done && !busy && (
        <p className="mt-2 text-[11px] text-slate-400">
          {DUB_PRESETS.find((p) => p.id === preset)?.hint} · 消耗 Aurixel
        </p>
      )}
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
  done: {
    stage: string;
    nmID: number | null;
    dryRun: boolean;
    sandbox: boolean;
    error: string | null;
  } | null;
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

      <div className="max-h-64 space-y-2 overflow-auto rounded-lg bg-slate-900/[0.05] p-3 font-mono text-xs dark:bg-black/20">
        {logs.map((l, i) => (
          <div key={i} className="flex items-start gap-2">
            <span
              className={clsx(
                l.ok
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400"
              )}
            >
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
