"use client";

import { useEffect, useState } from "react";
import { Save, Check, Loader2, KeyRound, ImageIcon, Boxes, Ruler } from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import type { Warehouse } from "@/lib/types";

interface Redacted {
  authEnabled: boolean;
  wbContentTokenSet: boolean;
  wbPricesTokenSet: boolean;
  wbTokenExpiresInDays: number | null;
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

  // local editable fields (blank = keep existing for secrets)
  const [wbContentToken, setWbContentToken] = useState("");
  const [wbPricesToken, setWbPricesToken] = useState("");
  const [wbSandbox, setWbSandbox] = useState(false);
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
      setAurixelChatModel(d.aurixelChatModel || "gpt-5.5");
      setAutoStock(d.autoStock ?? false);
      setDefaultStock(d.defaultStock ?? 99);
      setDefaultWarehouseId(d.defaultWarehouseId ?? 0);
      setDefaultLength(d.defaultLength ?? 20);
      setDefaultWidth(d.defaultWidth ?? 15);
      setDefaultHeight(d.defaultHeight ?? 5);
      setDefaultWeight(d.defaultWeight ?? 0.3);
    });
    // FBS warehouses need the Маркетплейс scope — failure just leaves the picker empty.
    api.listWarehouses().then(setWarehouses).catch(() => setWarehouses([]));
  }, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    const patch: Record<string, string | boolean | number> = {
      imageProvider,
      wbSandbox,
      autoStock,
      defaultStock,
      defaultWarehouseId,
      defaultLength,
      defaultWidth,
      defaultHeight,
      defaultWeight,
    };
    // trim — pasted tokens often carry a trailing space/newline that would
    // corrupt the Authorization header.
    if (wbContentToken.trim()) patch.wbContentToken = wbContentToken.trim();
    if (wbPricesToken.trim()) patch.wbPricesToken = wbPricesToken.trim();
    if (openaiApiKey.trim()) patch.openaiApiKey = openaiApiKey.trim();
    if (aurixelApiKey.trim()) patch.aurixelApiKey = aurixelApiKey.trim();
    if (aurixelChatModel) patch.aurixelChatModel = aurixelChatModel;
    if (pollinationsToken.trim()) patch.pollinationsToken = pollinationsToken.trim();

    const d = await api.saveSettings(patch);
    setRedacted(d);
    setWbContentToken("");
    setWbPricesToken("");
    setOpenaiApiKey("");
    setAurixelApiKey("");
    setPollinationsToken("");
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div className="mx-auto max-w-2xl animate-fade-up">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">设置</h1>
      <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        密钥仅保存在<b className="text-slate-700 dark:text-slate-300">本机</b>应用数据目录，不随程序上传。
        生成图片/文案时，商品名、关键词等内容会发送到所选 AI 网关（如 Aurixel）进行处理。
      </p>

      <div className="space-y-5">
        {/* WB */}
        <section className="card p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
            <KeyRound className="h-4 w-4 text-wb-pink" /> Wildberries Token
          </div>
          <label className="label">
            内容(Контент) Token {redacted?.wbContentTokenSet && (
              <span className="ml-1 text-emerald-600 dark:text-emerald-400">已配置</span>
            )}
            {redacted?.wbContentTokenSet && redacted.wbTokenExpiresInDays != null && (
              <span
                className={clsx(
                  "ml-1",
                  redacted.wbTokenExpiresInDays < 0
                    ? "text-rose-600 dark:text-rose-400"
                    : redacted.wbTokenExpiresInDays <= 14
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-slate-400"
                )}
              >
                {redacted.wbTokenExpiresInDays < 0
                  ? "· 已过期，请到 WB 后台重新生成"
                  : redacted.wbTokenExpiresInDays === 0
                  ? "· 今天内到期"
                  : `· 有效期剩 ${redacted.wbTokenExpiresInDays} 天`}
              </span>
            )}
          </label>
          <input
            type="password"
            className="input mb-4"
            placeholder={redacted?.wbContentTokenSet ? "留空保持不变" : "粘贴 Content 范围 Token（JWT）"}
            value={wbContentToken}
            onChange={(e) => setWbContentToken(e.target.value)}
          />
          <label className="label">
            价格(Цены) Token（可选，留空复用上面的 Token）
            {redacted?.wbPricesTokenSet && <span className="ml-1 text-emerald-600 dark:text-emerald-400">已配置</span>}
          </label>
          <input
            type="password"
            className="input"
            placeholder="若内容 Token 已含价格范围则无需填写"
            value={wbPricesToken}
            onChange={(e) => setWbPricesToken(e.target.value)}
          />
          <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-sm text-slate-800 dark:text-slate-200">
            <input
              type="checkbox"
              className="h-4 w-4 accent-wb-purple"
              checked={wbSandbox}
              onChange={(e) => setWbSandbox(e.target.checked)}
            />
            使用沙盒环境（content-api-sandbox）—— 测试 Token 必须开启
          </label>
          <p className="mt-3 text-xs text-slate-500">
            在卖家后台「设置 → 访问 API」生成 Token，需勾选 <b>Контент</b> 与 <b>Цены и скидки</b> 两个范围，且非只读。未配置则运行演示模式。
          </p>
        </section>

        {/* Image */}
        <section className="card p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
            <ImageIcon className="h-4 w-4 text-wb-pink" /> 文生图
          </div>
          <label className="label">提供方</label>
          <select
            className="input mb-4"
            value={imageProvider}
            onChange={(e) => setImageProvider(e.target.value)}
          >
            <option value="aurixel">Aurixel gpt-image-2（推荐，需 Key）</option>
            <option value="pollinations">Pollinations（免 Key）</option>
            <option value="openai">OpenAI gpt-image-1（需 Key）</option>
          </select>
          {imageProvider === "aurixel" && (
            <>
              <label className="label">
                Aurixel API Key {redacted?.aurixelKeySet && <span className="ml-1 text-emerald-600 dark:text-emerald-400">已配置</span>}
              </label>
              <input
                type="password"
                className="input mb-4"
                placeholder="ck_..."
                value={aurixelApiKey}
                onChange={(e) => setAurixelApiKey(e.target.value)}
              />
              <label className="label">文案模型</label>
              <select
                className="input"
                value={aurixelChatModel}
                onChange={(e) => setAurixelChatModel(e.target.value)}
              >
                <option value="gpt-5.5">gpt-5.5</option>
                <option value="gpt-4o">gpt-4o</option>
                <option value="claude-opus-4-8">claude-opus-4-8</option>
                <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                <option value="gemini-3-pro-preview">gemini-3-pro-preview</option>
              </select>
              <p className="mt-3 text-xs text-slate-500">
                标题、描述、卖点、类目与文生图提示词都由所选模型生成。Aurixel 是 OpenAI 兼容网关（conduit-api.aurixel.ai），同一个 Key 既出图（gpt-image-2）也写文案。
              </p>
            </>
          )}
          {imageProvider === "openai" && (
            <>
              <label className="label">
                OpenAI API Key {redacted?.openaiKeySet && <span className="ml-1 text-emerald-600 dark:text-emerald-400">已配置</span>}
              </label>
              <input
                type="password"
                className="input"
                placeholder="sk-..."
                value={openaiApiKey}
                onChange={(e) => setOpenaiApiKey(e.target.value)}
              />
            </>
          )}
          {imageProvider === "pollinations" && (
            <>
              <label className="label">
                Pollinations Token（可选，解除限流/水印）
                {redacted?.pollinationsTokenSet && <span className="ml-1 text-emerald-600 dark:text-emerald-400">已配置</span>}
              </label>
              <input
                type="password"
                className="input"
                placeholder="在 auth.pollinations.ai 免费获取"
                value={pollinationsToken}
                onChange={(e) => setPollinationsToken(e.target.value)}
              />
              <p className="mt-3 text-xs text-slate-500">
                未配置 Token 时免费匿名层可能被限流(402)，此时会自动用品牌占位图兜底，整条流程仍可跑通。
              </p>
            </>
          )}
        </section>

        {/* Stock (FBS) */}
        <section className="card p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
            <Boxes className="h-4 w-4 text-wb-pink" /> 库存（FBS）
          </div>
          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-slate-800 dark:text-slate-200">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-wb-purple"
              checked={autoStock}
              onChange={(e) => setAutoStock(e.target.checked)}
            />
            <span>
              上架后<b>自动设库存</b>
              <span className="mt-0.5 block text-xs text-slate-500">
                建卡成功后，按下面的仓库与数量自动设库存——商品在审核+定价后才能真正可售。
              </span>
            </span>
          </label>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <label className="label">默认仓库</label>
              <select
                className="input"
                value={defaultWarehouseId || ""}
                onChange={(e) => setDefaultWarehouseId(Number(e.target.value) || 0)}
              >
                <option value="">（不自动设库存）</option>
                {warehouses?.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}（{w.id}）
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">默认库存数量</label>
              <input
                type="number"
                min={0}
                className="input"
                value={defaultStock}
                onChange={(e) => setDefaultStock(Math.max(0, Number(e.target.value) || 0))}
              />
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            {warehouses === null
              ? "正在读取仓库…"
              : warehouses.length === 0
              ? "未读取到仓库（Token 需含「Маркетплейс」范围）。可在「商品管理」里逐个设库存。"
              : "也可在「商品管理」里对单个商品补货 / 下架。"}
          </p>
        </section>

        {/* Default package dimensions / weight */}
        <section className="card p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
            <Ruler className="h-4 w-4 text-wb-pink" /> 默认包裹尺寸 / 重量
          </div>
          <p className="mb-3 text-xs text-slate-500">
            生成新商品时预填这组数值（可在工作台逐个改）。WB 按包裹体积/重量计物流与仓储费、入库时复测，请按真实填写。
          </p>
          <div className="grid grid-cols-4 gap-3">
            {(
              [
                ["长 (cm)", defaultLength, setDefaultLength, 1],
                ["宽 (cm)", defaultWidth, setDefaultWidth, 1],
                ["高 (cm)", defaultHeight, setDefaultHeight, 1],
                ["重 (kg)", defaultWeight, setDefaultWeight, 0.1],
              ] as const
            ).map(([lab, val, setter, step]) => (
              <div key={lab}>
                <label className="label">{lab}</label>
                <input
                  type="number"
                  min={0}
                  step={step}
                  className="input"
                  value={val}
                  onChange={(e) => setter(Math.max(0, Number(e.target.value) || 0))}
                />
              </div>
            ))}
          </div>
        </section>

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
  );
}
