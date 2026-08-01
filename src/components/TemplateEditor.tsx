"use client";

import { useEffect, useState } from "react";
import { Wand2, Save, Check, Loader2, RotateCcw, Eye, EyeOff } from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import type { ImageTemplate, ImageTemplates } from "@/lib/types";

// Placeholders that build_ctx fills (must match generate.rs).
const PLACEHOLDERS: [string, string][] = [
  ["{TITLE}", "俄文标题"],
  ["{CALLOUTS}", "短卖点(分号)"],
  ["{N}", "卖点数量"],
  ["{ACCENT}", "强调色(按品类)"],
  ["{KEY_BENEFIT}", "核心卖点"],
  ["{SCENE}", "使用场景"],
  ["{CATEGORY}", "类目"],
  ["{NAME}", "商品名"],
  ["{CUSTOM}", "你的自定义追加"],
];

// Sample values so the preview shows what the model will actually receive.
const SAMPLE: Record<string, string> = {
  TITLE: "Вафельница электрическая 750 Вт для дома",
  CALLOUTS: "Быстрый нагрев; Антипригарное; 2 формы; Для семьи",
  N: "4",
  ACCENT: "red",
  KEY_BENEFIT: "Быстрый нагрев",
  SCENE: "an attractive real-life scene where the product is used",
  CATEGORY: "Вафельница",
  NAME: "Вафельница",
  CUSTOM: "",
};

// TS mirror of Rust `templates::fill` — keep behaviour identical so the preview
// equals what the backend renders.
function fillTemplate(body: string, ctx: Record<string, string>): string {
  let out = body;
  for (const k of Object.keys(ctx)) out = out.split(`{${k}}`).join(ctx[k]);
  const refCustom = body.includes("{CUSTOM}");
  out = out.replace(/\{[A-Z0-9_]+\}/g, ""); // strip leftover tokens
  out = out.replace(/\s+/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim();
  if (!refCustom && ctx.CUSTOM?.trim()) out += " " + ctx.CUSTOM.trim();
  return out.trim();
}

const SLOT_LABEL: Record<string, string> = { main: "主图", promo: "宣传", gallery: "细节" };

export function TemplateEditor() {
  const [tpl, setTpl] = useState<ImageTemplates | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then((d) => setTpl(d.imageTemplates)).catch(() => {});
  }, []);

  function patch(kind: string, p: Partial<ImageTemplate>) {
    setTpl((t) =>
      t ? { ...t, templates: t.templates.map((x) => (x.kind === kind ? { ...x, ...p } : x)) } : t
    );
  }

  async function save() {
    if (!tpl) return;
    setSaving(true);
    setSaved(false);
    setErr(null);
    try {
      // save_config does a shallow merge — must send the COMPLETE object.
      await api.saveSettings({ imageTemplates: tpl });
      // Re-read what actually persisted and show it, so the edit visibly STICKS
      // (backend stamps source="user" → these are kept forever, never auto-reset).
      const d = await api.getSettings();
      if (d.imageTemplates) setTpl(d.imageTemplates);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!confirm("恢复为内置默认模板？你的修改会被覆盖。")) return;
    const d = await api.defaultTemplates();
    setTpl(d);
  }

  if (!tpl) {
    return (
      <div className="card flex items-center justify-center py-10 text-slate-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="card p-6">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
        <Wand2 className="h-4 w-4 text-wb-pink" /> 图像提示词模板（可改）
      </div>
      <p className="mb-4 text-xs leading-relaxed text-slate-500">
        每个档案的提示词都可编辑、即时生效。`{`{占位符}`}` 会在生成时自动替换；想改风格(比如换强调色、加红横幅、塞自己的话术)直接改下面的文本即可。
      </p>

      {/* placeholder legend */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {PLACEHOLDERS.map(([p, d]) => (
          <span key={p} className="chip text-[11px]" title={d}>
            <code>{p}</code>
          </span>
        ))}
      </div>

      {/* rotation */}
      <div className="mb-4 text-xs text-slate-500">
        <b className="text-slate-700 dark:text-slate-300">出图顺序</b>：{tpl.rotation.join(" → ")}
        <span className="ml-1 text-slate-400">（按"生成数量"循环；只用启用的档案）</span>
      </div>

      <div className="space-y-3">
        {tpl.templates.map((t) => (
          <div key={t.kind} className="rounded-xl border border-slate-900/[0.08] p-3 dark:border-white/[0.08]">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4 accent-wb-purple"
                checked={t.enabled}
                onChange={(e) => patch(t.kind, { enabled: e.target.checked })}
                title="是否启用"
              />
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{t.label}</span>
              <span className="chip text-[10px]">{SLOT_LABEL[t.slot] ?? t.slot}</span>
              <code className="text-[10px] text-slate-400">{t.kind}</code>
              <select
                className="ml-auto rounded-lg border border-slate-900/[0.12] bg-transparent px-2 py-1 text-[11px] text-slate-700 outline-none dark:border-white/[0.12] dark:text-slate-300"
                value={t.textMode}
                onChange={(e) => patch(t.kind, { textMode: e.target.value })}
                title="文字渲染方式"
              >
                <option value="clean">纯净照片(不加字)</option>
                <option value="overlay">叠加: 标题+卖点</option>
                <option value="overlay_header">叠加: 仅标题</option>
                <option value="overlay_badge">叠加: 角标</option>
                <option value="model">模型直接出字(易糊,不推荐)</option>
              </select>
            </div>
            <textarea
              className="input font-mono text-[11px] leading-relaxed"
              rows={5}
              value={t.body}
              onChange={(e) => patch(t.kind, { body: e.target.value })}
            />
            <button
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              onClick={() => setPreview(preview === t.kind ? null : t.kind)}
            >
              {preview === t.kind ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {preview === t.kind ? "收起预览" : "预览(示例填充)"}
            </button>
            {preview === t.kind && (
              <p className="mt-1.5 rounded-lg bg-slate-900/[0.04] px-3 py-2 text-[11px] leading-relaxed text-slate-600 dark:bg-white/[0.05] dark:text-slate-400">
                {fillTemplate(t.body, SAMPLE)}
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="mt-4 flex gap-2">
        <button className="btn-primary flex-1" onClick={save} disabled={saving}>
          {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> 保存中…</> : saved ? <><Check className="h-4 w-4" /> 已保存</> : <><Save className="h-4 w-4" /> 保存模板</>}
        </button>
        <button className="btn-ghost" onClick={reset} title="恢复内置默认">
          <RotateCcw className="h-4 w-4" /> 恢复默认
        </button>
      </div>
      {err && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">保存失败：{err}</p>}
    </div>
  );
}
