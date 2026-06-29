// Dub quality presets — one user-facing choice mapping to the backend's
// `quality` + `keepBackground` knobs. Lets the seller decide whether to pay the
// heavy local-ML cost (voice-select / Demucs both need uvx + a first-run torch
// download). Default is "fast": pure-cloud, no download, instant — the seller
// opts into the heavier presets for better clone consistency / background music.

export type DubPreset = "fast" | "standard" | "high";

export const DUB_PRESET_DEFAULT: DubPreset = "fast";

export const DUB_PRESETS: { id: DubPreset; label: string; hint: string }[] = [
  { id: "fast", label: "快速", hint: "纯云端 · 不下载模型 · 最快（无背景音乐）" },
  { id: "standard", label: "标准", hint: "声纹择优，音色更稳 · 首次需联网下载模型(几百MB)" },
  { id: "high", label: "高质量", hint: "声纹择优 + 保留背景音乐(Demucs) · 首次下载最大、最慢" },
];

/** Map a preset to the backend dub options. */
export function dubPresetOptions(p: DubPreset): {
  quality: "fast" | "standard" | "high";
  keepBackground: boolean;
} {
  if (p === "high") return { quality: "high", keepBackground: true };
  if (p === "standard") return { quality: "standard", keepBackground: false };
  return { quality: "fast", keepBackground: false };
}
