"use client";

import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  FileVideo,
  FolderOpen,
  Play,
  RefreshCw,
  Loader2,
  CheckCircle2,
  Circle,
  AlertTriangle,
  XCircle,
  Coins,
  Cpu,
  ChevronDown,
  ChevronUp,
  Square,
  ArrowRight,
} from "lucide-react";
import clsx from "clsx";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import type { DubPreflight, DubProgress } from "@/lib/types";

type Quality = "fast" | "standard" | "high";
type VoiceMode = "clone" | "preset";
type RunStatus = "idle" | "running" | "done" | "error" | "cancelled";
type PhaseState = "pending" | "running" | "done" | "error";

// Canonical, ordered pipeline phases. The CLI emits finer-grained stage names
// (some conditional); each maps onto one phase here so the checklist stays
// stable regardless of which optional stages run.
const PHASES: { key: string; label: string; kind: "local" | "paid"; stages: string[] }[] = [
  { key: "extract", label: "提取音轨", kind: "local", stages: ["extract"] },
  { key: "separate", label: "分离背景音", kind: "local", stages: ["separate"] },
  { key: "asr", label: "语音识别", kind: "paid", stages: ["asr", "diarize-refine"] },
  { key: "translate", label: "翻译成俄语", kind: "paid", stages: ["translate"] },
  { key: "clone", label: "克隆音色", kind: "paid", stages: ["enroll(clone)", "enroll"] },
  {
    key: "synth",
    label: "合成配音",
    kind: "paid",
    stages: ["tts+fit", "iso-fit", "voice-select", "pitch-reroll"],
  },
  {
    key: "assemble",
    label: "合成成片",
    kind: "local",
    stages: ["assemble(segment)", "assemble(whole)", "gate-silence", "mux"],
  },
  { key: "verify", label: "校验", kind: "local", stages: ["verify"] },
];

const STAGE_TO_PHASE: Record<string, number> = {};
PHASES.forEach((p, i) => p.stages.forEach((s) => (STAGE_TO_PHASE[s] = i)));

const QUALITY_LABEL: Record<Quality, string> = { fast: "快速", standard: "标准", high: "高质" };
// Aurixel gateway preset voices (RU-capable). Used when 音色 = 预设.
const PRESET_VOICES = ["Cherry", "Katerina", "Serena", "Ethan", "Dylan"];

function initPhases(state: PhaseState = "pending"): Record<string, PhaseState> {
  const o: Record<string, PhaseState> = {};
  PHASES.forEach((p) => (o[p.key] = state));
  return o;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function fmtElapsed(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m} 分 ${s} 秒`;
}

export function DubPanel() {
  const [preflight, setPreflight] = useState<DubPreflight | null>(null);

  const [inputPath, setInputPath] = useState<string | null>(null);
  const [brand, setBrand] = useState("");
  const [keywords, setKeywords] = useState("");
  const [tone, setTone] = useState("营销");
  const [voiceMode, setVoiceMode] = useState<VoiceMode>("clone");
  const [presetVoice, setPresetVoice] = useState(PRESET_VOICES[0]);
  const [quality, setQuality] = useState<Quality>("standard");

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [keepBackground, setKeepBackground] = useState(true);
  const [gateSilence, setGateSilence] = useState(true);
  const [diarize, setDiarize] = useState(true);
  const [keepOriginalAudio, setKeepOriginalAudio] = useState(0); // 0..100 (%)

  const [status, setStatus] = useState<RunStatus>("idle");
  const [phaseStatus, setPhaseStatus] = useState<Record<string, PhaseState>>(initPhases());
  const [logs, setLogs] = useState<DubProgress[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [resultOut, setResultOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<number | null>(null);
  const startedRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  function refreshPreflight() {
    api
      .dubPreflight()
      .then(setPreflight)
      .catch(() => setPreflight(null));
  }

  useEffect(() => {
    refreshPreflight();
    // live progress + completion streamed from the dub subprocess
    let alive = true;
    let unProg: (() => void) | null = null;
    let unDone: (() => void) | null = null;
    listen<DubProgress>("dub:progress", (e) => applyEvent(e.payload)).then((u) =>
      alive ? (unProg = u) : u()
    );
    listen<{ out: string }>("dub:done", (e) => {
      setResultOut(e.payload.out);
      setPhaseStatus(initPhases("done"));
    }).then((u) => (alive ? (unDone = u) : u()));
    return () => {
      alive = false;
      unProg?.();
      unDone?.();
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (showLog) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, showLog]);

  function applyEvent(ev: DubProgress) {
    setLogs((l) => [...l, ev]);
    if (ev.stage === "cancelled") return;
    if (ev.stage === "failed") {
      setPhaseStatus((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next)) if (next[k] === "running") next[k] = "error";
        return next;
      });
      return;
    }
    const i = STAGE_TO_PHASE[ev.stage];
    if (i == null) return;
    setPhaseStatus((prev) => {
      const next = { ...prev };
      for (let j = 0; j < i; j++) if (next[PHASES[j].key] !== "error") next[PHASES[j].key] = "done";
      next[PHASES[i].key] = ev.ok === false ? "error" : "running";
      return next;
    });
  }

  function startTimer() {
    startedRef.current = Date.now();
    setElapsed(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedRef.current) / 1000)),
      1000
    );
  }
  function stopTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  async function handlePick() {
    try {
      const p = await api.dubPickVideo();
      if (p) {
        setInputPath(p);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "选择文件失败");
    }
  }

  async function handleStart() {
    if (!inputPath) {
      setError("请先选择视频文件");
      return;
    }
    if (preflight && !preflight.ready) {
      setError("运行环境未就绪，请看下方自检条");
      return;
    }
    const ok = window.confirm(
      `开始配音？\n\n` +
        `视频：${baseName(inputPath)}\n` +
        `语言：英语 → 俄语\n` +
        `音色：${voiceMode === "clone" ? "克隆原声" : `预设音色（${presetVoice}）`}\n` +
        `质量：${QUALITY_LABEL[quality]}\n\n` +
        `会消耗你的 Aurixel 余额（按你自己的 key 计费）。\n` +
        `成片输出到源视频同目录（xxx.ru.mp4）。`
    );
    if (!ok) return;

    setStatus("running");
    setError(null);
    setResultOut(null);
    setPhaseStatus(initPhases());
    setLogs([]);
    startTimer();
    try {
      const out = await api.dubStart({
        inputPath,
        brand: brand.trim() || undefined,
        keywords: keywords.trim() || undefined,
        tone: tone.trim() || undefined,
        voiceMode,
        presetVoice: voiceMode === "preset" ? presetVoice : undefined,
        quality,
        keepBackground,
        gateSilence,
        diarize,
        keepOriginalAudio: keepOriginalAudio > 0 ? keepOriginalAudio / 100 : undefined,
      });
      setResultOut(out);
      setStatus("done");
      setPhaseStatus(initPhases("done"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("已取消")) {
        setStatus("cancelled");
      } else {
        setStatus("error");
        setError(msg);
      }
    } finally {
      stopTimer();
    }
  }

  async function handleCancel() {
    if (!window.confirm("取消当前配音任务？已花费的额度无法退回。")) return;
    try {
      await api.dubCancel();
    } catch {
      /* ignore */
    }
  }

  function handleReset() {
    setStatus("idle");
    setResultOut(null);
    setError(null);
    setPhaseStatus(initPhases());
    setLogs([]);
    setElapsed(0);
  }

  const running = status === "running";
  const ready = !!preflight?.ready;

  // preflight missing-item hints
  const missing: string[] = [];
  if (preflight) {
    if (!preflight.node) missing.push("缺 Node 运行时");
    if (!preflight.ffmpeg || !preflight.ffprobe) missing.push("缺 FFmpeg");
    if (!preflight.aurixelKey) missing.push("到「设置」填写 Aurixel 密钥");
    if (!preflight.cliFound) missing.push("配音脚本缺失（请重装应用）");
  }
  const checks = preflight
    ? [
        { ok: preflight.node, label: "Node" },
        { ok: preflight.ffmpeg && preflight.ffprobe, label: "FFmpeg" },
        { ok: preflight.aurixelKey, label: "Aurixel 密钥" },
      ]
    : [];

  return (
    <div className="animate-fade-up">
      <div className="mb-8 max-w-2xl">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
          <AudioLines className="h-6 w-6 text-wb-pink" />
          视频配音
        </h1>
        <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
          把英文产品视频配成俄语，克隆原声、保留背景音，直接用于 Wildberries 商品卡。
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        {/* ── Left: form ── */}
        <div className={clsx("card h-fit p-6", running && "pointer-events-none opacity-50")}>
          {/* preflight strip */}
          <div className="mb-5 rounded-xl border border-slate-900/[0.06] bg-slate-900/[0.03] p-3 dark:border-white/[0.06] dark:bg-white/[0.03]">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500">
                运行环境
              </span>
              <button
                type="button"
                onClick={refreshPreflight}
                title="重新检测"
                className="text-slate-400 transition hover:text-slate-700 dark:hover:text-slate-200"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {checks.map((c) => (
                <span
                  key={c.label}
                  className={clsx(
                    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
                    c.ok
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300"
                  )}
                >
                  {c.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                  {c.label}
                </span>
              ))}
              {preflight && (
                <span
                  className={clsx(
                    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
                    preflight.uvx
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300"
                  )}
                  title={preflight.uvx ? "" : "可选组件，缺失则跳过背景音保留与音色择优"}
                >
                  {preflight.uvx ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : (
                    <AlertTriangle className="h-3 w-3" />
                  )}
                  语音分离
                  <span className="opacity-60">{preflight.uvx ? "" : "·可选"}</span>
                </span>
              )}
            </div>
            {missing.length > 0 && (
              <p className="mt-2 text-xs text-rose-600 dark:text-rose-300">{missing.join("；")}</p>
            )}
            {preflight && !preflight.uvx && missing.length === 0 && (
              <p className="mt-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-300/90">
                未检测到语音分离组件：仍可配音，但会跳过「保留背景音」与「音色择优」（音质略降）。
              </p>
            )}
          </div>

          {/* video file */}
          <label className="label">视频文件</label>
          {inputPath ? (
            <div className="mb-5 flex items-center gap-3 rounded-xl border border-slate-900/[0.1] bg-slate-900/[0.03] p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-wb-pink/10 text-wb-pink">
                <FileVideo className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                  {baseName(inputPath)}
                </div>
                <div className="truncate text-xs text-slate-400">{inputPath}</div>
              </div>
              <button
                type="button"
                onClick={handlePick}
                className="shrink-0 text-xs font-medium text-wb-pink hover:underline"
              >
                重选
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handlePick}
              className="mb-5 flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-900/[0.15] bg-slate-900/[0.02] py-7 text-slate-500 transition hover:border-wb-pink/50 hover:text-wb-pink dark:border-white/[0.12] dark:bg-white/[0.02]"
            >
              <FileVideo className="h-6 w-6" />
              <span className="text-sm font-medium">选择视频文件</span>
              <span className="text-[11px] text-slate-400">mp4 / mov / mkv / webm</span>
            </button>
          )}

          {/* language */}
          <label className="label">语言</label>
          <div className="mb-5 flex items-center gap-2">
            <span className="chip">英语 · 自动识别</span>
            <ArrowRight className="h-4 w-4 text-slate-400" />
            <span className="inline-flex items-center gap-1 rounded-full border border-wb-pink/30 bg-wb-pink/10 px-2.5 py-1 text-xs font-medium text-wb-pink">
              俄语
            </span>
          </div>

          {/* translation hints */}
          <label className="label">翻译优化 · 可选</label>
          <div className="mb-5 space-y-2">
            <input
              className="input"
              placeholder="品牌名（保持原文不译）"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
            />
            <input
              className="input"
              placeholder="关键词，逗号分隔"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
            />
            <select className="input" value={tone} onChange={(e) => setTone(e.target.value)}>
              <option value="营销">语气：营销</option>
              <option value="口语">语气：口语</option>
              <option value="专业">语气：专业</option>
              <option value="中性">语气：中性</option>
            </select>
          </div>

          {/* voice mode */}
          <label className="label">配音音色</label>
          <Seg
            value={voiceMode}
            onChange={(v) => setVoiceMode(v as VoiceMode)}
            options={[
              { value: "clone", label: "克隆原声 · 推荐" },
              { value: "preset", label: "预设音色" },
            ]}
          />
          {voiceMode === "preset" ? (
            <select
              className="input mt-2"
              value={presetVoice}
              onChange={(e) => setPresetVoice(e.target.value)}
            >
              {PRESET_VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : (
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
              自动克隆视频里每个说话人的音色；清晰语音不足约 6 秒会自动改用预设音色。
            </p>
          )}

          {/* quality */}
          <label className="label mt-5">质量档位</label>
          <Seg
            value={quality}
            onChange={(v) => setQuality(v as Quality)}
            options={[
              { value: "fast", label: "快速" },
              { value: "standard", label: "标准" },
              { value: "high", label: "高质" },
            ]}
          />
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
            {quality === "fast"
              ? "最快、最省额度：每句一版，不做择优/等时微调。"
              : quality === "high"
                ? "每句生成 4 版择优，最接近原声，但更慢、更费额度。"
                : "每句生成 2 版择优，质量与花费的平衡点。"}
          </p>

          {/* advanced */}
          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            className="mt-5 flex w-full items-center justify-between border-t border-slate-900/[0.08] pt-4 text-sm text-slate-600 dark:border-white/[0.06] dark:text-slate-300"
          >
            高级选项
            {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {showAdvanced && (
            <div className="mt-3 space-y-3">
              <Toggle label="保留原视频背景音乐 / 音效" checked={keepBackground} onChange={setKeepBackground} />
              <Toggle label="静音段不出声（口型对齐）" checked={gateSilence} onChange={setGateSilence} />
              <Toggle label="多说话人分轨（各用各的音色）" checked={diarize} onChange={setDiarize} />
              <div>
                <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
                  <span>原声混入</span>
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    {keepOriginalAudio === 0 ? "完全替换" : `${keepOriginalAudio}%`}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={keepOriginalAudio}
                  onChange={(e) => setKeepOriginalAudio(Number(e.target.value))}
                  className="w-full accent-wb-pink"
                />
              </div>
            </div>
          )}

          {/* start */}
          <button
            className="btn-primary mt-6 w-full"
            onClick={handleStart}
            disabled={running || !inputPath || (preflight != null && !ready)}
          >
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> 配音中…
              </>
            ) : (
              <>
                <AudioLines className="h-4 w-4" /> 开始配音
              </>
            )}
          </button>
          <p className="mt-2 flex items-center justify-center gap-1 text-[11px] text-slate-400">
            <Coins className="h-3 w-3" /> 将消耗你的 Aurixel 余额（按你自己的 key 计费）
          </p>
        </div>

        {/* ── Right: progress / result ── */}
        <div className="space-y-6">
          {status === "idle" ? (
            <div className="card p-6">
              <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                <AudioLines className="h-4 w-4 text-wb-pink" /> 即将运行
              </div>
              <div className="opacity-60">
                <PhaseList phaseStatus={phaseStatus} />
              </div>
              <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-500/[0.07] px-4 py-3 text-xs text-amber-700 dark:text-amber-200/90">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>点「开始配音」后会先弹确认：视频、音色、质量、是否消耗 Aurixel 余额。标
                  <Coins className="mx-0.5 inline h-3 w-3" />的步骤走网关、计入你的用量。</span>
              </div>
            </div>
          ) : (
            <div className="card p-6">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                  {running ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin text-wb-pink" /> 配音中…
                      <span className="font-normal text-slate-400">已用 {fmtElapsed(elapsed)}</span>
                    </>
                  ) : status === "done" ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" /> 配音完成
                      <span className="font-normal text-slate-400">耗时 {fmtElapsed(elapsed)}</span>
                    </>
                  ) : status === "cancelled" ? (
                    <>
                      <Square className="h-4 w-4 text-slate-400" /> 已取消
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-4 w-4 text-rose-500" /> 配音失败
                    </>
                  )}
                </div>
                {running ? (
                  <button onClick={handleCancel} className="btn-ghost px-3 py-1.5 text-xs">
                    <Square className="h-3 w-3" /> 取消
                  </button>
                ) : (
                  <button onClick={handleReset} className="btn-ghost px-3 py-1.5 text-xs">
                    <RefreshCw className="h-3 w-3" /> 再配一个
                  </button>
                )}
              </div>

              <PhaseList phaseStatus={phaseStatus} />

              <p className="mt-3 flex items-center gap-1 text-[11px] text-slate-400">
                <Coins className="h-3 w-3 text-amber-500" /> 标
                <Coins className="h-3 w-3 text-amber-500" />
                的步骤走网关、计入你的 Aurixel 用量；标
                <Cpu className="h-3 w-3" />
                的在本机跑、不花钱。
              </p>

              {logs.length > 0 && (
                <div className="mt-4">
                  <button
                    onClick={() => setShowLog((s) => !s)}
                    className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                  >
                    {showLog ? "隐藏" : "查看"}技术日志（{logs.length}）
                  </button>
                  {showLog && (
                    <div className="mt-2 max-h-48 space-y-1 overflow-auto rounded-lg bg-slate-900/[0.05] p-3 font-mono text-[11px] dark:bg-black/20">
                      {logs.map((l, i) => (
                        <div key={i} className="flex items-start gap-2">
                          <span className={l.ok ? "text-emerald-600" : "text-rose-600"}>
                            {l.ok ? "✓" : "✗"}
                          </span>
                          <span className="text-slate-600 dark:text-slate-300">
                            {l.stage} · {l.ms}ms
                            {l.warn ? ` · WARN ${l.warn}` : ""}
                            {l.error ? ` · ${l.error}` : ""}
                          </span>
                        </div>
                      ))}
                      <div ref={logEndRef} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* error banner */}
          {status === "error" && error && (
            <div className="card border-rose-500/30 p-4 text-sm text-rose-600 dark:text-rose-300">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <div className="font-medium">配音失败</div>
                  <div className="mt-0.5 break-words text-xs opacity-90">{error}</div>
                </div>
              </div>
            </div>
          )}

          {/* result card */}
          {status === "done" && resultOut && (
            <div className="card p-6">
              <div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.08] px-4 py-2.5 text-sm font-medium text-emerald-700 dark:text-emerald-200">
                <CheckCircle2 className="h-4 w-4" /> 俄语配音已生成
              </div>
              <div className="mb-4 flex items-center gap-3 rounded-xl border border-slate-900/[0.08] p-3 dark:border-white/[0.07]">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-wb-pink/10 text-wb-pink">
                  <FileVideo className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                    {baseName(resultOut)}
                  </div>
                  <div className="truncate text-xs text-slate-400">{resultOut}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => api.openPath(resultOut)} className="btn-ghost justify-center text-sm">
                  <Play className="h-4 w-4" /> 打开视频
                </button>
                <button onClick={() => api.revealPath(resultOut)} className="btn-ghost justify-center text-sm">
                  <FolderOpen className="h-4 w-4" /> 在文件夹中显示
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── small building blocks ──

function Seg({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex gap-1 rounded-xl border border-slate-900/[0.08] bg-slate-900/[0.03] p-1 dark:border-white/[0.06] dark:bg-white/[0.03]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={clsx(
            "flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition",
            value === o.value
              ? "bg-white text-slate-900 shadow-sm dark:bg-white/[0.12] dark:text-white"
              : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between text-sm text-slate-600 dark:text-slate-300"
    >
      <span>{label}</span>
      <span
        className={clsx(
          "relative h-5 w-9 rounded-full transition",
          checked ? "bg-wb-pink" : "bg-slate-300 dark:bg-white/[0.15]"
        )}
      >
        <span
          className={clsx(
            "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
            checked ? "left-[18px]" : "left-0.5"
          )}
        />
      </span>
    </button>
  );
}

function PhaseList({ phaseStatus }: { phaseStatus: Record<string, PhaseState> }) {
  return (
    <div className="space-y-0.5">
      {PHASES.map((p) => {
        const st = phaseStatus[p.key] || "pending";
        return (
          <div
            key={p.key}
            className={clsx(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm",
              st === "running" && "bg-wb-pink/[0.06]"
            )}
          >
            {st === "done" ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
            ) : st === "running" ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-wb-pink" />
            ) : st === "error" ? (
              <XCircle className="h-4 w-4 shrink-0 text-rose-500" />
            ) : (
              <Circle className="h-4 w-4 shrink-0 text-slate-300 dark:text-slate-600" />
            )}
            <span
              className={clsx(
                "flex-1",
                st === "pending"
                  ? "text-slate-400"
                  : "text-slate-700 dark:text-slate-200"
              )}
            >
              {p.label}
            </span>
            {p.kind === "paid" ? (
              <Coins className="h-3.5 w-3.5 text-amber-500/70" />
            ) : (
              <Cpu className="h-3.5 w-3.5 text-slate-300 dark:text-slate-600" />
            )}
          </div>
        );
      })}
    </div>
  );
}
