"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, Layers, Boxes, Settings, Wallet, X, ArrowRight, ArrowLeft, HelpCircle } from "lucide-react";

// First-run USAGE tour. Each step SPOTLIGHTS a real UI region (via a data-tour
// anchor) and floats a bubble next to it, so the user learns where things are.
// Steps whose anchor isn't on the current screen fall back to a centered card.
// Shown once (localStorage flag), re-openable from the top-bar "?".
type Step = {
  icon: React.ComponentType<{ className?: string }>;
  anchor?: string; // [data-tour="..."]; omit → centered
  title: string;
  lines: string[];
};

const STEPS: Step[] = [
  {
    icon: Sparkles,
    title: "欢迎使用 WB AutoList",
    lines: ["AI 帮你把商品做成俄文图文 + 配音视频，一键上架 Wildberries。", "花 30 秒认认各处在哪 —— 右上角「?」随时可重看。"],
  },
  {
    icon: Sparkles,
    anchor: "nav-home",
    title: "① 工作台（单品上架）",
    lines: ["单个商品在这里做：填信息 → AI 生成 → 复核 → 上架。"],
  },
  {
    icon: Sparkles,
    anchor: "form",
    title: "填这几样就够",
    lines: ["商品名 + 关键词 + 价格，再传图片/英文视频。", "其余留空 AI 自动补。中途切走再回来，填的内容会保留。"],
  },
  {
    icon: ArrowRight,
    anchor: "generate",
    title: "点这里开始生成",
    lines: ["AI 出俄文图文（可选配音+字幕），完成后进入复核，确认无误再上架。"],
  },
  {
    icon: Layers,
    anchor: "nav-batch",
    title: "② 批量上架",
    lines: ["用 Excel 一次导入多个商品，批量生成并上架。"],
  },
  {
    icon: Boxes,
    anchor: "nav-manage",
    title: "③ 商品管理 / 上架记录",
    lines: ["商品管理：看已上架商品的实时价格/库存并修改。", "上架记录：回看每一单的过程。"],
  },
  {
    icon: Settings,
    anchor: "nav-settings",
    title: "④ 设置",
    lines: ["填 Aurixel / Wildberries 密钥、默认包裹尺寸。", "视频配音先点「配音引擎 → 测试」，绿了再用高质量。"],
  },
  {
    icon: Wallet,
    anchor: "balance",
    title: "余额随时看",
    lines: ["右上角是 Aurixel 余额，点它充值。"],
  },
  {
    icon: HelpCircle,
    anchor: "help",
    title: "随时重看本指引",
    lines: ["以后点这个「?」就能再走一遍。开始用吧！"],
  },
];

type Rect = { top: number; left: number; width: number; height: number };

export function GuideOverlay({ onClose }: { onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => setMounted(true), []);

  const step = STEPS[i];

  // Measure the current step's anchor (and re-measure on resize). useLayoutEffect
  // so the bubble appears already-positioned, no flicker.
  useLayoutEffect(() => {
    if (!mounted) return;
    function measure() {
      const sel = step.anchor ? `[data-tour="${step.anchor}"]` : null;
      const el = sel ? (document.querySelector(sel) as HTMLElement | null) : null;
      if (el) {
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      } else {
        setRect(null); // centered fallback
      }
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [i, mounted, step.anchor]);

  if (!mounted) return null;

  const last = i === STEPS.length - 1;
  const Icon = step.icon;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const PAD = 8; // spotlight padding around the target
  const BW = Math.min(340, vw - 24); // bubble width

  // Bubble position: prefer below the target, else above; clamp horizontally.
  let bubbleStyle: React.CSSProperties;
  if (rect) {
    const below = rect.top + rect.height + 12;
    const placeBelow = below + 180 < vh; // rough bubble height budget
    const top = placeBelow ? below + PAD : Math.max(12, rect.top - PAD - 200);
    let left = rect.left + rect.width / 2 - BW / 2;
    left = Math.max(12, Math.min(left, vw - BW - 12));
    bubbleStyle = { position: "fixed", top, left, width: BW };
  } else {
    bubbleStyle = { position: "fixed", top: "50%", left: "50%", width: BW, transform: "translate(-50%,-50%)" };
  }

  const bubble = (
    <div style={bubbleStyle} className="z-[101] rounded-2xl border border-slate-900/10 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-wb-ink">
      <div className="mb-2 flex items-start justify-between">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-wb-pink/10 text-wb-pink">
          <Icon className="h-5 w-5" />
        </div>
        <button type="button" onClick={onClose} title="跳过" className="grid h-7 w-7 place-items-center rounded text-slate-400 transition hover:bg-slate-900/[0.05] hover:text-slate-700 dark:hover:bg-white/[0.06]">
          <X className="h-4 w-4" />
        </button>
      </div>
      <h2 className="text-[15px] font-semibold text-slate-900 dark:text-slate-50">{step.title}</h2>
      <ul className="mt-1.5 space-y-1">
        {step.lines.map((l, k) => (
          <li key={k} className="flex gap-1.5 text-[12.5px] leading-relaxed text-slate-600 dark:text-slate-300">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-wb-pink/70" />
            <span>{l}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-1">
          {STEPS.map((_, k) => (
            <span key={k} className={"h-1.5 rounded-full transition-all " + (k === i ? "w-4 bg-wb-pink" : "w-1.5 bg-slate-300 dark:bg-white/20")} />
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          {i > 0 && (
            <button type="button" onClick={() => setI((v) => v - 1)} className="flex items-center gap-0.5 rounded-lg px-2 py-1 text-[12px] font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100">
              <ArrowLeft className="h-3.5 w-3.5" /> 上一步
            </button>
          )}
          <button type="button" onClick={() => (last ? onClose() : setI((v) => v + 1))} className="flex items-center gap-1 rounded-lg bg-wb-pink px-3.5 py-1.5 text-[12px] font-semibold text-white shadow-sm transition hover:brightness-105">
            {last ? "开始使用" : <>下一步 <ArrowRight className="h-3.5 w-3.5" /></>}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[100]">
      {/* click-catcher: makes the underlying app inert during the tour */}
      <div className="absolute inset-0" onClick={(e) => e.stopPropagation()} />
      {rect ? (
        // spotlight cutout: the big box-shadow dims everything except the target
        <div
          className="pointer-events-none absolute rounded-xl ring-2 ring-wb-pink"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: "0 0 0 9999px rgba(2,6,23,0.6)",
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-slate-950/60" />
      )}
      {bubble}
    </div>,
    document.body
  );
}
