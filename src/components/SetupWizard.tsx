"use client";

import { useState } from "react";
import {
  Sparkles,
  Store,
  Warehouse,
  CheckCircle2,
  XCircle,
  Loader2,
  ArrowRight,
  ArrowLeft,
  Coins,
  ExternalLink,
  PartyPopper,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import type { ConnTest, WbCheck, Warehouse as Wh } from "@/lib/types";

const STEPS = ["欢迎", "Aurixel", "店铺", "默认"];

export function SetupWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);

  const [aurixelKey, setAurixelKey] = useState("");
  const [aurixelBusy, setAurixelBusy] = useState(false);
  const [aurixelRes, setAurixelRes] = useState<ConnTest | null>(null);

  const [wbToken, setWbToken] = useState("");
  const [sandbox, setSandbox] = useState(true);
  const [wbBusy, setWbBusy] = useState(false);
  const [wbRes, setWbRes] = useState<WbCheck | null>(null);
  const [warehouses, setWarehouses] = useState<Wh[]>([]);

  const [warehouseId, setWarehouseId] = useState(0);
  const [length, setLength] = useState(20);
  const [width, setWidth] = useState(15);
  const [height, setHeight] = useState(5);
  const [weight, setWeight] = useState(0.3);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function testAurixel() {
    setAurixelBusy(true);
    setAurixelRes(null);
    try {
      setAurixelRes(await api.testAurixel(aurixelKey));
    } catch (e) {
      setAurixelRes({ ok: false, detail: e instanceof Error ? e.message : "测试失败", warehouses: [] });
    } finally {
      setAurixelBusy(false);
    }
  }

  async function testWb() {
    setWbBusy(true);
    setWbRes(null);
    try {
      const r = await api.testWb(wbToken, sandbox);
      setWbRes(r);
      if (r.ok) {
        setWarehouses(r.warehouses);
        if (r.warehouses[0]) setWarehouseId(r.warehouses[0].id);
      }
    } catch (e) {
      setWbRes({
        ok: false, formatOk: false, expired: false, expiresInDays: null,
        tokenEnv: "", envMismatch: false, content: "error", marketplace: "error",
        detail: e instanceof Error ? e.message : "测试失败", warehouses: [],
      });
    } finally {
      setWbBusy(false);
    }
  }

  async function finish() {
    setSaving(true);
    setError(null);
    try {
      await api.saveSettings({
        aurixelApiKey: aurixelKey.trim(),
        wbContentToken: wbToken.trim(),
        wbSandbox: sandbox,
        defaultWarehouseId: warehouseId,
        defaultLength: length,
        defaultWidth: width,
        defaultHeight: height,
        defaultWeight: weight,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
      setSaving(false);
    }
  }

  const canNext =
    step === 0 ? true : step === 1 ? !!aurixelRes?.ok : step === 2 ? !!wbRes?.ok : true;

  function Result({ res }: { res: ConnTest | null }) {
    if (!res) return null;
    return (
      <div
        className={clsx(
          "mt-3 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium",
          res.ok
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300"
        )}
      >
        {res.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
        {res.detail}
      </div>
    );
  }

  function WbResult({ res }: { res: WbCheck | null }) {
    if (!res) return null;
    const chip = (label: string, s: string) => {
      const good = s === "ok";
      const skip = s === "skip";
      if (skip) return null;
      return (
        <span
          className={clsx(
            "rounded px-1.5 py-0.5 text-[10px] font-semibold",
            good
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "bg-rose-500/15 text-rose-600 dark:text-rose-300"
          )}
        >
          {label} {good ? "✓" : "✗"}
        </span>
      );
    };
    return (
      <div
        className={clsx(
          "mt-3 rounded-lg border px-3 py-2 text-xs font-medium",
          res.ok
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300"
        )}
      >
        <div className="flex items-start gap-2">
          {res.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{res.detail}</span>
        </div>
        {res.formatOk && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6">
            {chip("内容 Контент", res.content)}
            {chip("营销 Маркетплейс", res.marketplace)}
            {res.tokenEnv && (
              <span className="text-[10px] text-slate-500 dark:text-slate-400">
                {res.tokenEnv === "sandbox" ? "沙盒 token" : "正式 token"}
              </span>
            )}
            {res.expiresInDays != null && res.expiresInDays >= 0 && (
              <span className="text-[10px] text-slate-500 dark:text-slate-400">· {res.expiresInDays} 天后过期</span>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="card w-full max-w-xl p-0">
        {/* brand title bar */}
        <div className="flex items-center justify-center gap-2 border-b border-slate-900/[0.06] px-6 py-3.5 dark:border-white/[0.06]">
          <span className="h-4 w-4 rounded-md bg-gradient-to-br from-wb-pink to-wb-purple" />
          <span className="text-sm font-semibold text-slate-900 dark:text-white">WB AutoList</span>
          <span className="text-sm text-slate-400">· 初次设置</span>
        </div>
        {/* stepper */}
        <div className="flex items-center justify-center gap-1 px-6 pb-3 pt-5">
          {STEPS.map((s, i) => {
            const done = i < step;
            const act = i === step;
            return (
              <div key={s} className="flex items-center">
                <div
                  className={clsx(
                    "grid h-7 w-7 place-items-center rounded-full text-xs font-medium",
                    act
                      ? "bg-gradient-to-br from-wb-pink to-wb-purple text-white"
                      : done
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "border border-slate-900/10 text-slate-400 dark:border-white/10"
                  )}
                >
                  {done ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
                </div>
                <span
                  className={clsx(
                    "ml-1.5 text-xs",
                    act ? "font-medium text-slate-900 dark:text-white" : "text-slate-400"
                  )}
                >
                  {s}
                </span>
                {i < STEPS.length - 1 && (
                  <div className="mx-2.5 h-px w-7 bg-slate-900/10 dark:bg-white/10" />
                )}
              </div>
            );
          })}
        </div>

        {/* body */}
        <div className="min-h-[260px] px-7 py-3">
          {step === 0 && (
            <div className="py-6 text-center">
              <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-wb-pink to-wb-purple">
                <Sparkles className="h-7 w-7 text-white" />
              </div>
              <h2 className="text-xl font-semibold text-slate-900 dark:text-white">
                欢迎,3 步开始在 Wildberries 卖货
              </h2>
              <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                输入商品 → AI 生成图文 / 配图 / 俄语视频 → 一键上架。先连两个账号,大约 1 分钟。
              </p>
            </div>
          )}

          {step === 1 && (
            <div className="py-2">
              <div className="flex items-center gap-2 text-base font-medium text-slate-900 dark:text-white">
                <Sparkles className="h-4 w-4 text-wb-pink" /> 连接 Aurixel(AI 引擎)
              </div>
              <p className="mb-4 mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                文案、配图、把视频配成俄语都用它,按你自己的用量计费。
              </p>
              <label className="label">API Key</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  className="input"
                  placeholder="ck-…"
                  value={aurixelKey}
                  onChange={(e) => setAurixelKey(e.target.value)}
                />
                <button className="btn-ghost shrink-0" onClick={testAurixel} disabled={aurixelBusy}>
                  {aurixelBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "测试连接"}
                </button>
              </div>
              <Result res={aurixelRes} />
              <button
                onClick={() => api.openUrl("https://www.bifrostapi.net")}
                className="mt-3 inline-flex items-center gap-1 text-xs text-wb-pink hover:underline"
              >
                <ExternalLink className="h-3 w-3" /> 去 bifrostapi.net 充值
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="py-2">
              <div className="flex items-center gap-2 text-base font-medium text-slate-900 dark:text-white">
                <Store className="h-4 w-4 text-wb-pink" /> 连接 Wildberries 店铺
              </div>
              <p className="mb-4 mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                从 WB 卖家后台生成 API Token 粘进来。<b>同一个 Token 需同时勾选「Контент(内容)」+「Маркетплейс(营销)」</b>，且不要勾「只读」。测试会分别核对两个权限。
              </p>
              <label className="label">环境</label>
              <div className="mb-3 flex gap-1 rounded-xl border border-slate-900/[0.08] bg-slate-900/[0.03] p-1 dark:border-white/[0.06] dark:bg-white/[0.03]">
                <button
                  onClick={() => setSandbox(true)}
                  className={clsx(
                    "flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition",
                    sandbox ? "bg-white text-slate-900 shadow-sm dark:bg-white/[0.12] dark:text-white" : "text-slate-500"
                  )}
                >
                  沙盒测试
                </button>
                <button
                  onClick={() => setSandbox(false)}
                  className={clsx(
                    "flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition",
                    !sandbox ? "bg-rose-500 text-white shadow-sm" : "text-slate-500"
                  )}
                >
                  正式店铺
                </button>
              </div>
              <label className="label">API Token</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  className="input"
                  placeholder="eyJhbGci…"
                  value={wbToken}
                  onChange={(e) => setWbToken(e.target.value)}
                />
                <button className="btn-ghost shrink-0" onClick={testWb} disabled={wbBusy}>
                  {wbBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "测试连接"}
                </button>
              </div>
              <WbResult res={wbRes} />
            </div>
          )}

          {step === 3 && (
            <div className="py-2">
              <div className="flex items-center gap-2 text-base font-medium text-slate-900 dark:text-white">
                <Warehouse className="h-4 w-4 text-wb-pink" /> 默认设置
                <span className="text-xs font-normal text-slate-400">· 以后随时可改</span>
              </div>
              <p className="mb-4 mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                设一次,以后每张卡片自动套用,不用反复填。
              </p>
              <label className="label">默认发货仓库</label>
              <select
                className="input mb-4"
                value={warehouseId}
                onChange={(e) => setWarehouseId(Number(e.target.value))}
              >
                {warehouses.length === 0 && <option value={0}>（无可用仓库,可稍后在设置里选）</option>}
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name || `仓库 ${w.id}`}
                  </option>
                ))}
              </select>
              <label className="label">常用包裹尺寸 / 重量</label>
              <div className="grid grid-cols-4 gap-2">
                {([
                  ["长 cm", length, setLength],
                  ["宽 cm", width, setWidth],
                  ["高 cm", height, setHeight],
                  ["重量 kg", weight, setWeight],
                ] as const).map(([lab, val, set]) => (
                  <div key={lab}>
                    <input
                      type="number"
                      className="input px-2 py-2 text-sm"
                      value={val}
                      onChange={(e) => set(Number(e.target.value))}
                    />
                    <div className="mt-1 text-center text-[10px] text-slate-400">{lab}</div>
                  </div>
                ))}
              </div>
              {error && <p className="mt-3 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex items-center justify-between border-t border-slate-900/[0.06] px-7 py-5 dark:border-white/[0.06]">
          <button
            className={clsx("btn-ghost", step === 0 && "invisible")}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            <ArrowLeft className="h-4 w-4" /> 上一步
          </button>
          <span className="text-[11px] text-slate-400">
            {step === 1 || step === 2 ? "测试通过才能继续" : ""}
          </span>
          {step < 3 ? (
            <button className="btn-primary" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
              {step === 0 ? "开始设置" : "下一步"} <ArrowRight className="h-4 w-4" />
            </button>
          ) : (
            <button className="btn-primary" disabled={saving} onClick={finish}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <PartyPopper className="h-4 w-4" />}
              完成,进入工作台
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
