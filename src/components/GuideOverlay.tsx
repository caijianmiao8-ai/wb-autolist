"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, Layers, Boxes, Settings, Wallet, X, ArrowRight, ArrowLeft } from "lucide-react";

// First-run USAGE guide (distinct from the setup wizard, which only collects keys).
// A short, skippable tour of what each area does — shown once (localStorage flag),
// re-openable from the "?" button in the top bar. Kept deliberately terse.
type Step = { icon: React.ComponentType<{ className?: string }>; title: string; lines: string[] };

const STEPS: Step[] = [
  {
    icon: Sparkles,
    title: "欢迎使用 WB AutoList",
    lines: [
      "AI 帮你把商品做成俄文图文 + 配音视频，一键上架到 Wildberries。",
      "花 30 秒了解各处怎么用 —— 随时可在右上角「?」重看。",
    ],
  },
  {
    icon: Sparkles,
    title: "工作台 · 单品上架",
    lines: [
      "填：商品名 + 关键词 + 价格，上传图片 / 英文视频。",
      "点「生成」→ AI 出图文(+俄语配音) → 复核无误 → 上架。",
      "中途切到别的页面再回来，填好的内容会自动保留。",
    ],
  },
  {
    icon: Layers,
    title: "批量上架",
    lines: [
      "用 Excel 一次导入多个商品，批量生成并上架。",
      "导入约 10 秒，期间请勿切换页面（会有进度遮罩）。",
    ],
  },
  {
    icon: Boxes,
    title: "商品管理 · 上架记录",
    lines: [
      "商品管理：看已上架商品的实时价格 / 库存，可直接改。",
      "上架记录：回看过往每一单的生成与上架过程。",
    ],
  },
  {
    icon: Settings,
    title: "设置",
    lines: [
      "填 Aurixel / Wildberries 密钥、默认包裹尺寸。",
      "视频配音：先点「配音引擎 → 测试」，绿了再用「高质量」。",
      "右上角 $ 随时可见 Aurixel 余额，点它充值。",
    ],
  },
];

export function GuideOverlay({ onClose }: { onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  const [i, setI] = useState(0);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const last = i === STEPS.length - 1;
  const s = STEPS[i];
  const Icon = s.icon;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-slate-900/10 bg-white p-6 shadow-2xl dark:border-white/10 dark:bg-wb-ink">
        <div className="mb-3 flex items-start justify-between">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-wb-pink/10 text-wb-pink">
            <Icon className="h-6 w-6" />
          </div>
          <button
            type="button"
            onClick={onClose}
            title="跳过"
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-900/[0.05] hover:text-slate-700 dark:hover:bg-white/[0.06] dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">{s.title}</h2>
        <ul className="mt-2 space-y-1.5">
          {s.lines.map((l, k) => (
            <li key={k} className="flex gap-2 text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-wb-pink/70" />
              <span>{l}</span>
            </li>
          ))}
        </ul>

        <div className="mt-6 flex items-center justify-between">
          {/* step dots */}
          <div className="flex items-center gap-1.5">
            {STEPS.map((_, k) => (
              <span
                key={k}
                className={
                  "h-1.5 rounded-full transition-all " +
                  (k === i ? "w-5 bg-wb-pink" : "w-1.5 bg-slate-300 dark:bg-white/20")
                }
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {i > 0 && (
              <button
                type="button"
                onClick={() => setI((v) => v - 1)}
                className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-[13px] font-medium text-slate-500 transition hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> 上一步
              </button>
            )}
            {last ? (
              <button
                type="button"
                onClick={onClose}
                className="flex items-center gap-1.5 rounded-lg bg-wb-pink px-4 py-1.5 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-105"
              >
                <Wallet className="h-3.5 w-3.5" /> 开始使用
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setI((v) => v + 1)}
                className="flex items-center gap-1 rounded-lg bg-wb-pink px-4 py-1.5 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-105"
              >
                下一步 <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
