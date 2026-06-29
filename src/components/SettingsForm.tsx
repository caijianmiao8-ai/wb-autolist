"use client";

import { useEffect, useState } from "react";
import {
  Save,
  Check,
  Loader2,
  Wand2,
  Settings as SettingsIcon,
  Eye,
  EyeOff,
  ChevronDown,
  CheckCircle2,
  Download,
  Video,
} from "lucide-react";
import clsx from "clsx";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import { EnvBadge } from "./EnvBadge";
import { TemplateEditor } from "./TemplateEditor";
import { envKind } from "@/lib/env";
import type { Warehouse, EngineStatus, DubPreflight } from "@/lib/types";

interface Redacted {
  authEnabled: boolean;
  dryRun: boolean;
  wbContentTokenSet: boolean;
  wbPricesTokenSet: boolean;
  wbTokenExpiresInDays: number | null;
  wbPricesTokenExpiresInDays: number | null;
  wbSandbox: boolean;
  imageProvider: string;
  openaiKeySet: boolean;
  aurixelKeySet: boolean;
  aurixelChatModel: string;
  pollinationsTokenSet: boolean;
  publicBaseUrl: string;
  defaultWarehouseId: number;
  defaultStock: number;
  autoStock: boolean;
  defaultLength: number;
  defaultWidth: number;
  defaultHeight: number;
  defaultWeight: number;
}

export function SettingsForm() {
  const [redacted, setRedacted] = useState<Redacted | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [balance, setBalance] = useState<{ usd: number; rmb: number } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [showTpl, setShowTpl] = useState(false);
  // per-row inline editors
  const [editWb, setEditWb] = useState(false);
  const [editAi, setEditAi] = useState(false);
  const [editPkg, setEditPkg] = useState(false);
  const [editPriceTok, setEditPriceTok] = useState(false);

  const [wbContentToken, setWbContentToken] = useState("");
  const [wbPricesToken, setWbPricesToken] = useState("");
  const [wbSandbox, setWbSandbox] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [imageProvider, setImageProvider] = useState("pollinations");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [aurixelApiKey, setAurixelApiKey] = useState("");
  const [aurixelChatModel, setAurixelChatModel] = useState("gpt-5.5");
  const [pollinationsToken, setPollinationsToken] = useState("");
  const [autoStock, setAutoStock] = useState(false);
  const [defaultStock, setDefaultStock] = useState(99);
  const [defaultWarehouseId, setDefaultWarehouseId] = useState(0);
  const [defaultLength, setDefaultLength] = useState(20);
  const [defaultWidth, setDefaultWidth] = useState(15);
  const [defaultHeight, setDefaultHeight] = useState(5);
  const [defaultWeight, setDefaultWeight] = useState(0.3);
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);

  useEffect(() => {
    api.getSettings().then((d) => {
      setRedacted(d);
      setImageProvider(d.imageProvider || "pollinations");
      setWbSandbox(!!d.wbSandbox);
      setDryRun(d.dryRun);
      setAurixelChatModel(d.aurixelChatModel || "gpt-5.5");
      setAutoStock(d.autoStock ?? false);
      setDefaultStock(d.defaultStock ?? 99);
      setDefaultWarehouseId(d.defaultWarehouseId ?? 0);
      setDefaultLength(d.defaultLength ?? 20);
      setDefaultWidth(d.defaultWidth ?? 15);
      setDefaultHeight(d.defaultHeight ?? 5);
      setDefaultWeight(d.defaultWeight ?? 0.3);
    });
    api.listWarehouses().then(setWarehouses).catch(() => setWarehouses([]));
    // Aurixel balance — only if a key is configured (read-only GET /v1/balance).
    api
      .getSettings()
      .then((d) => {
        if (d.aurixelKeySet) api.aurixelBalance().then(setBalance).catch(() => {});
      })
      .catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    const patch: Record<string, string | boolean | number> = {
      imageProvider,
      wbSandbox,
      dryRun,
      autoStock,
      defaultStock,
      defaultWarehouseId,
      defaultLength,
      defaultWidth,
      defaultHeight,
      defaultWeight,
    };
    if (wbContentToken.trim()) patch.wbContentToken = wbContentToken.trim();
    if (wbPricesToken.trim()) patch.wbPricesToken = wbPricesToken.trim();
    if (openaiApiKey.trim()) patch.openaiApiKey = openaiApiKey.trim();
    if (aurixelApiKey.trim()) patch.aurixelApiKey = aurixelApiKey.trim();
    if (aurixelChatModel) patch.aurixelChatModel = aurixelChatModel;
    if (pollinationsToken.trim()) patch.pollinationsToken = pollinationsToken.trim();

    const d = await api.saveSettings(patch);
    setRedacted(d);
    setDryRun(d.dryRun);
    setWbContentToken("");
    setWbPricesToken("");
    setOpenaiApiKey("");
    setAurixelApiKey("");
    setPollinationsToken("");
    setEditWb(false);
    setEditAi(false);
    setEditPkg(false);
    setEditPriceTok(false);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  function rerunWizard() {
    try {
      localStorage.setItem("wb:rerunSetup", "1");
    } catch {
      /* ignore */
    }
    window.location.assign("/");
  }

  const tokenSet = !!redacted?.wbContentTokenSet || !!wbContentToken.trim();
  const kind = envKind(dryRun, wbSandbox);
  const inputType = reveal ? "text" : "password";

  // 三态运行环境切换
  function pickEnv(target: "demo" | "sandbox" | "live") {
    if (target === kind) return;
    if ((target === "sandbox" || target === "live") && !tokenSet) {
      alert("请先在下方「Wildberries 店铺」配置 Token,才能切换到沙盒 / 正式。");
      return;
    }
    if (target === "live") {
      if (
        !window.confirm(
          "切换到「正式店铺」?\n\n之后所有上架 / 改价 / 库存操作都会作用于你的真实 Wildberries 店铺,且不可撤销。确认切换?"
        )
      )
        return;
      setDryRun(false);
      setWbSandbox(false);
    } else if (target === "sandbox") {
      setDryRun(false);
      setWbSandbox(true);
    } else {
      setDryRun(true); // 演示
    }
  }

  const wbExpiry =
    redacted?.wbTokenExpiresInDays != null
      ? redacted.wbTokenExpiresInDays < 0
        ? "Token 已过期"
        : `Token ${redacted.wbTokenExpiresInDays} 天后过期`
      : "";

  return (
    <div className="flex h-full min-h-0 flex-col animate-fade-up">
      {/* ── Header (pinned) ── */}
      <div className="shrink-0">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
            <SettingsIcon className="h-5 w-5 text-wb-pink" /> 设置
          </h1>
          {redacted && <EnvBadge dryRun={dryRun} sandbox={wbSandbox} className="ml-auto" />}
        </div>
      </div>

      {/* ── Body (scrolls) ── */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        <div className="mx-auto max-w-3xl pb-2">
          {/* 向导提示 */}
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-wb-purple/25 bg-wb-purple/[0.06] px-4 py-3">
            <Wand2 className="h-4 w-4 shrink-0 text-wb-purple" />
            <span className="flex-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              账号与默认值已在<b>初次设置向导</b>配置好,这里随时查看 / 修改。密钥仅存本机,不随程序上传。
            </span>
            <button onClick={rerunWizard} className="btn-ghost shrink-0 px-3 py-1.5 text-xs">
              重新运行向导
            </button>
          </div>

          {/* ════ 常用 ════ */}
          <div className="mb-1 px-1 text-[10.5px] uppercase tracking-[0.05em] text-slate-400">常用</div>
          <div className="card mb-4 px-4">
            {/* 运行环境 */}
            <Row
              k="运行环境"
              sub="切到「正式」会二次确认,并常驻顶栏告警"
              right={
                <div className="flex gap-0.5 rounded-lg border border-slate-900/[0.08] bg-slate-900/[0.03] p-0.5 dark:border-white/[0.06] dark:bg-white/[0.03]">
                  {(
                    [
                      ["演示", "demo"],
                      ["沙盒", "sandbox"],
                      ["正式", "live"],
                    ] as const
                  ).map(([lab, k]) => (
                    <button
                      key={k}
                      onClick={() => pickEnv(k)}
                      className={clsx(
                        "rounded-md px-3 py-1 text-[11.5px] font-medium transition",
                        kind === k
                          ? k === "live"
                            ? "bg-rose-600 text-white shadow-sm"
                            : k === "sandbox"
                            ? "bg-amber-500 text-white shadow-sm"
                            : "bg-white text-slate-900 shadow-sm dark:bg-white/[0.14] dark:text-white"
                          : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                      )}
                    >
                      {lab}
                    </button>
                  ))}
                </div>
              }
            />
            {/* WB 店铺 */}
            <Row
              k="Wildberries 店铺"
              subEl={
                redacted?.wbContentTokenSet ? (
                  <span className="flex items-center gap-1 text-[10.5px] text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" /> 已连接{wbExpiry ? ` · ${wbExpiry}` : ""}
                  </span>
                ) : (
                  <span className="text-[10.5px] text-amber-600 dark:text-amber-400">未连接 · 处于演示模式</span>
                )
              }
              right={
                <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setEditWb((v) => !v)}>
                  {editWb ? "收起" : redacted?.wbContentTokenSet ? "续期 / 修改" : "配置"}
                </button>
              }
            />
            {editWb && (
              <div className="pb-3">
                <input
                  type={inputType}
                  className="input mb-2"
                  placeholder={redacted?.wbContentTokenSet ? "留空保持不变" : "粘贴 Content 范围 Token(JWT)"}
                  value={wbContentToken}
                  onChange={(e) => setWbContentToken(e.target.value)}
                />
                <p className="text-[11px] text-slate-500">
                  卖家后台「设置 → 访问 API」生成,勾选 <b>Контент</b> 与 <b>Цены и скидки</b>,且非只读。
                </p>
              </div>
            )}
            {/* Aurixel */}
            <Row
              last
              k="Aurixel(AI 引擎)"
              subEl={
                redacted?.aurixelKeySet ? (
                  <span className="flex items-center gap-1 text-[10.5px] text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" /> 已连接 · 文案 {redacted.aurixelChatModel}
                    {balance && (
                      <span className="text-slate-500 dark:text-slate-400">
                        {" "}
                        · 余额 ${balance.usd.toFixed(2)}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-[10.5px] text-amber-600 dark:text-amber-400">未连接</span>
                )
              }
              right={
                <div className="flex gap-1.5">
                  <button
                    className="btn-ghost px-3 py-1.5 text-xs"
                    onClick={() => api.openUrl("https://aurixel.ai")}
                  >
                    充值
                  </button>
                  <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setEditAi((v) => !v)}>
                    {editAi ? "收起" : "修改"}
                  </button>
                </div>
              }
            />
            {editAi && (
              <div className="pb-3">
                <input
                  type={inputType}
                  className="input mb-2"
                  placeholder={redacted?.aurixelKeySet ? "留空保持不变" : "ck_..."}
                  value={aurixelApiKey}
                  onChange={(e) => setAurixelApiKey(e.target.value)}
                />
                <select className="input" value={aurixelChatModel} onChange={(e) => setAurixelChatModel(e.target.value)}>
                  <option value="gpt-5.5">gpt-5.5</option>
                  <option value="gpt-4o">gpt-4o</option>
                  <option value="claude-opus-4-8">claude-opus-4-8</option>
                  <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                  <option value="gemini-3-pro-preview">gemini-3-pro-preview</option>
                </select>
              </div>
            )}
          </div>

          {/* ════ 高级 ════ */}
          <button
            onClick={() => setAdvanced((v) => !v)}
            className="flex w-full items-center justify-between rounded-xl border border-slate-900/[0.1] bg-white px-4 py-3 text-sm text-slate-600 hover:bg-slate-900/[0.02] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-slate-300"
          >
            <span className="flex items-center gap-2">
              <SettingsIcon className="h-4 w-4 text-wb-purple" /> 高级设置
              <span className="text-[10.5px] text-slate-400">(普通卖家通常不用动)</span>
            </span>
            <ChevronDown className={clsx("h-4 w-4 text-slate-400 transition-transform", advanced && "rotate-180")} />
          </button>

          {advanced && (
            <div className="card mt-2 px-4">
              {/* 默认发货仓库 */}
              <Row
                k="默认发货仓库"
                right={
                  <select
                    className="input max-w-[200px] py-1.5 text-sm"
                    value={defaultWarehouseId || ""}
                    onChange={(e) => setDefaultWarehouseId(Number(e.target.value) || 0)}
                  >
                    <option value="">（暂不设置）</option>
                    {warehouses?.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                }
              />
              {/* 包裹尺寸 */}
              <Row
                k="常用包裹尺寸 / 重量"
                right={
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    {defaultLength}×{defaultWidth}×{defaultHeight}cm · {defaultWeight}kg
                    <button className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setEditPkg((v) => !v)}>
                      {editPkg ? "收起" : "修改"}
                    </button>
                  </div>
                }
              />
              {editPkg && (
                <div className="grid grid-cols-4 gap-2 pb-3">
                  {(
                    [
                      ["长cm", defaultLength, setDefaultLength, 1],
                      ["宽cm", defaultWidth, setDefaultWidth, 1],
                      ["高cm", defaultHeight, setDefaultHeight, 1],
                      ["重kg", defaultWeight, setDefaultWeight, 0.1],
                    ] as const
                  ).map(([lab, val, setter, step]) => (
                    <div key={lab}>
                      <input
                        type="number"
                        min={0}
                        step={step}
                        className="input py-1.5 text-center text-sm"
                        value={val}
                        onChange={(e) => setter(Math.max(0, Number(e.target.value) || 0))}
                      />
                      <span className="mt-0.5 block text-center text-[10px] text-slate-400">{lab}</span>
                    </div>
                  ))}
                </div>
              )}
              {/* 新品默认库存 — 留空更稳 */}
              <Row
                k="新品默认库存"
                sub="留空 = 上架后去「商品管理」逐个补货(更稳)"
                right={
                  <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-wb-purple"
                      checked={autoStock}
                      onChange={(e) => setAutoStock(e.target.checked)}
                    />
                    {autoStock ? (
                      <input
                        type="number"
                        min={0}
                        className="input w-20 py-1.5 text-sm"
                        value={defaultStock}
                        onChange={(e) => setDefaultStock(Math.max(0, Number(e.target.value) || 0))}
                      />
                    ) : (
                      <span className="text-slate-400">留空</span>
                    )}
                  </label>
                }
              />
              {/* 配图引擎 */}
              <Row
                k="配图引擎"
                right={
                  <select
                    className="input max-w-[220px] py-1.5 text-sm"
                    value={imageProvider}
                    onChange={(e) => setImageProvider(e.target.value)}
                  >
                    <option value="aurixel">Aurixel(推荐)</option>
                    <option value="pollinations">Pollinations(免 Key)</option>
                    <option value="openai">OpenAI</option>
                  </select>
                }
              />
              {imageProvider === "openai" && (
                <div className="pb-3">
                  <input
                    type={inputType}
                    className="input"
                    placeholder={redacted?.openaiKeySet ? "OpenAI Key 留空保持不变" : "sk-..."}
                    value={openaiApiKey}
                    onChange={(e) => setOpenaiApiKey(e.target.value)}
                  />
                </div>
              )}
              {imageProvider === "pollinations" && (
                <div className="pb-3">
                  <input
                    type={inputType}
                    className="input"
                    placeholder={redacted?.pollinationsTokenSet ? "Pollinations Token 留空保持不变" : "可选 · 解除限流/水印"}
                    value={pollinationsToken}
                    onChange={(e) => setPollinationsToken(e.target.value)}
                  />
                </div>
              )}
              {/* 价格单独 Token */}
              <Row
                last
                k="价格用单独 Token"
                sub="一般一个多权限 Token 就够,无需开"
                right={
                  <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setEditPriceTok((v) => !v)}>
                    {editPriceTok ? "收起" : redacted?.wbPricesTokenSet ? "已设 · 修改" : "设置"}
                  </button>
                }
              />
              {editPriceTok && (
                <div className="pb-3">
                  <input
                    type={inputType}
                    className="input"
                    placeholder="留空则复用上面的店铺 Token"
                    value={wbPricesToken}
                    onChange={(e) => setWbPricesToken(e.target.value)}
                  />
                </div>
              )}

              {/* 配音引擎(视频配音用) */}
              <DubEngineRow />

              {/* 显示密钥 */}
              <div className="border-t border-slate-900/[0.06] py-3 dark:border-white/[0.06]">
                <button
                  type="button"
                  onClick={() => setReveal((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                >
                  {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  {reveal ? "隐藏密钥明文" : "显示密钥明文"}
                </button>
              </div>
            </div>
          )}

          {/* 图文模板 · 可改提示词(高级,默认折叠) */}
          <button
            onClick={() => setShowTpl((v) => !v)}
            className="mt-3 flex w-full items-center justify-between rounded-xl border border-slate-900/[0.1] bg-white px-4 py-3 text-sm text-slate-600 hover:bg-slate-900/[0.02] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-slate-300"
          >
            <span className="flex items-center gap-2">
              <SettingsIcon className="h-4 w-4 text-wb-purple" /> 图文模板 · 提示词
              <span className="text-[10.5px] text-slate-400">(高级·每档可改,即时生效)</span>
            </span>
            <ChevronDown
              className={clsx("h-4 w-4 text-slate-400 transition-transform", showTpl && "rotate-180")}
            />
          </button>
          {showTpl && (
            <div className="mt-2">
              <TemplateEditor />
            </div>
          )}
        </div>
      </div>

      {/* ── Sticky save ── */}
      <div className="shrink-0 border-t border-slate-900/[0.06] pt-3 dark:border-white/[0.06]">
        <div className="mx-auto max-w-3xl">
          <button className="btn-primary w-full" onClick={save} disabled={saving}>
            {saving ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> 保存中…</>
            ) : saved ? (
              <><Check className="h-4 w-4" /> 已保存</>
            ) : (
              <><Save className="h-4 w-4" /> 保存设置</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// One setting row: label (+ optional sub) on the left, control on the right.
function Row({
  k,
  sub,
  subEl,
  right,
  last,
}: {
  k: string;
  sub?: string;
  subEl?: React.ReactNode;
  right: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={clsx(
        "flex items-center justify-between gap-3 py-3",
        !last && "border-b border-slate-900/[0.06] dark:border-white/[0.06]"
      )}
    >
      <div className="min-w-0">
        <div className="text-[13px] text-slate-800 dark:text-slate-100">{k}</div>
        {sub && <div className="mt-0.5 text-[10.5px] text-slate-500 dark:text-slate-400">{sub}</div>}
        {subEl && <div className="mt-0.5">{subEl}</div>}
      </div>
      <div className="shrink-0">{right}</div>
    </div>
  );
}

// 配音引擎(Demucs/voice-select 模型)：测试 + 预下载。下载在后端跑,设置页挂载时
// 查 dub_engine_status + 订阅 dub:engine,切 tab 回来进度还在;防呆=下载中按钮禁用、
// 二次确认、可取消。
function DubEngineRow() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [pre, setPre] = useState<DubPreflight | null>(null);
  const [testing, setTesting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [msg, setMsg] = useState("");
  const [elapsed, setElapsed] = useState(0);
  // Result of the REAL functional self-test (actual Demucs separation), not just
  // the binary-presence preflight. ok=true 才是真的「可配音」。
  const [testResult, setTestResult] = useState<{ ok: boolean; reason?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    let un: (() => void) | null = null;
    api
      .dubEngineStatus()
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        if (s.preparing) {
          setPreparing(true);
          setMsg(s.lastMsg);
        }
      })
      .catch(() => {});
    listen<{ preparing: boolean; msg?: string; ready?: boolean; error?: boolean }>(
      "dub:engine",
      (e) => {
        const p = e.payload;
        if (p.msg) setMsg(p.msg);
        setPreparing(p.preparing);
        if (!p.preparing) api.dubEngineStatus().then(setStatus).catch(() => {});
      }
    ).then((u) => (alive ? (un = u) : u()));
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  // elapsed timer while preparing (proves "alive", not frozen)
  useEffect(() => {
    if (!preparing) {
      setElapsed(0);
      return;
    }
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [preparing]);

  async function test() {
    // 1) instant preflight — are the binaries / key / script even present?
    setTestResult(null);
    setTesting(true);
    let p: DubPreflight | null = null;
    try {
      p = await api.dubPreflight();
      setPre(p);
    } catch {
      setTesting(false);
      return;
    }
    setTesting(false);
    // missing core pieces → preflight message already says what; don't bother separating.
    if (!p || !p.node || !p.ffmpeg || !p.ffprobe || !p.cliFound) return;
    // 2) the ACCURATE part: actually run one Demucs separation through the dub path.
    //    (uvx --version passing ≠ demucs can separate — that's what fooled us before.)
    setPreparing(true);
    setMsg("测试中：真跑一次背景分离…");
    try {
      await api.dubSelftest();
      setTestResult({ ok: true });
    } catch (e) {
      setTestResult({ ok: false, reason: e instanceof Error ? e.message : String(e) });
    } finally {
      setPreparing(false);
      api.dubEngineStatus().then(setStatus).catch(() => {});
    }
  }

  async function download() {
    if (
      !window.confirm(
        "下载配音引擎（Demucs + PyTorch）？\n\n首次约 0.5–1GB、可能几分钟；可在后台进行、随时取消。下载好后视频配音「标准/高质量」不再等待。"
      )
    )
      return;
    setPreparing(true);
    setMsg("正在准备…");
    try {
      await api.dubPrepareEngine();
    } catch {
      /* 末态经 dub:engine 事件展示 */
    } finally {
      setPreparing(false);
      api.dubEngineStatus().then(setStatus).catch(() => {});
    }
  }

  const fmtElapsed = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  const missing = pre
    ? [
        !pre.node && "Node",
        (!pre.ffmpeg || !pre.ffprobe) && "FFmpeg",
        !pre.uvx && "uvx(降级运行)",
        !pre.cliFound && "配音脚本",
      ].filter(Boolean)
    : [];

  return (
    <div className="border-t border-slate-900/[0.06] py-3 dark:border-white/[0.06]">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[13px] text-slate-800 dark:text-slate-100">
            <Video className="h-3.5 w-3.5 text-wb-pink" /> 配音引擎（视频配音用）
          </div>
          <div className="mt-0.5 text-[10.5px] text-slate-500 dark:text-slate-400">
            {status?.ready ? (
              <span className="text-emerald-600 dark:text-emerald-400">✓ 已就绪，配音不再等下载</span>
            ) : (
              "首次配音「标准/高质量」需联网下载模型；可在此预先下载"
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button className="btn-ghost px-3 py-1.5 text-xs" onClick={test} disabled={testing || preparing}>
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "测试"}
          </button>
          {preparing ? (
            <button
              className="btn-ghost px-3 py-1.5 text-xs text-rose-600 dark:text-rose-400"
              onClick={() => api.dubCancel().catch(() => {})}
            >
              取消
            </button>
          ) : (
            <button className="btn-ghost px-3 py-1.5 text-xs" onClick={download}>
              <Download className="h-3.5 w-3.5" /> 下载引擎
            </button>
          )}
        </div>
      </div>

      {preparing && (
        <div className="mt-2">
          <div className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-wb-pink" />
            <span className="min-w-0 flex-1 truncate">{msg || "下载中…"}</span>
            <span className="shrink-0 tabular-nums text-slate-400">已用时 {fmtElapsed}</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-900/[0.08] dark:bg-white/10">
            <div className="skeleton h-full w-full rounded-full" />
          </div>
          <p className="mt-1 text-[10px] text-slate-400">首次约 0.5–1GB，进度看着不动属正常；切到别的页面也会继续。</p>
        </div>
      )}

      {!preparing && pre && (
        <p
          className={clsx(
            "mt-2 text-[11px]",
            missing.length ? "text-amber-600 dark:text-amber-400" : "text-slate-500 dark:text-slate-400"
          )}
        >
          {missing.length ? `缺：${missing.join("、")}` : "运行组件齐全（能否真分离以「测试」结果为准）"}
          {!pre.aurixelKey && "（还需在上面配 Aurixel 密钥）"}
        </p>
      )}

      {!preparing &&
        testResult &&
        (testResult.ok ? (
          <p className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">
            ✓ 测试通过：已真跑一次背景分离，「高质量」配音可用
          </p>
        ) : (
          <div className="mt-1">
            <p className="text-[11px] text-rose-600 dark:text-rose-400">
              ✗ 测试未通过 —— 这样配音会降级（无背景音乐）。原因↓
            </p>
            {testResult.reason && (
              <pre className="mt-1 max-h-40 select-text overflow-auto whitespace-pre-wrap break-words rounded-md bg-rose-500/[0.06] px-2 py-1 text-[10px] leading-relaxed text-rose-700/80 dark:text-rose-300/70">
                {testResult.reason}
              </pre>
            )}
          </div>
        ))}
    </div>
  );
}
