"use client";

import { useEffect, useState } from "react";
import { Save, Check, Loader2, KeyRound, ImageIcon } from "lucide-react";
import { api } from "@/lib/api";

interface Redacted {
  authEnabled: boolean;
  wbContentTokenSet: boolean;
  wbPricesTokenSet: boolean;
  wbSandbox: boolean;
  imageProvider: string;
  openaiKeySet: boolean;
  aurixelKeySet: boolean;
  aurixelChatModel: string;
  pollinationsTokenSet: boolean;
  publicBaseUrl: string;
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

  useEffect(() => {
    api.getSettings().then((d) => {
      setRedacted(d);
      setImageProvider(d.imageProvider || "pollinations");
      setWbSandbox(!!d.wbSandbox);
      setAurixelChatModel(d.aurixelChatModel || "gpt-5.5");
    });
  }, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    const patch: Record<string, string | boolean> = {
      imageProvider,
      wbSandbox,
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
      <p className="mb-6 text-sm text-slate-400">
        所有配置（含密钥）仅保存在<b className="text-slate-300">本机</b>应用数据目录，不会上传任何服务器。
      </p>

      <div className="space-y-5">
        {/* WB */}
        <section className="card p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-200">
            <KeyRound className="h-4 w-4 text-wb-pink" /> Wildberries Token
          </div>
          <label className="label">
            内容(Контент) Token {redacted?.wbContentTokenSet && (
              <span className="ml-1 text-emerald-400">已配置</span>
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
            {redacted?.wbPricesTokenSet && <span className="ml-1 text-emerald-400">已配置</span>}
          </label>
          <input
            type="password"
            className="input"
            placeholder="若内容 Token 已含价格范围则无需填写"
            value={wbPricesToken}
            onChange={(e) => setWbPricesToken(e.target.value)}
          />
          <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-sm text-slate-200">
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
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-200">
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
                Aurixel API Key {redacted?.aurixelKeySet && <span className="ml-1 text-emerald-400">已配置</span>}
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
                OpenAI API Key {redacted?.openaiKeySet && <span className="ml-1 text-emerald-400">已配置</span>}
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
                {redacted?.pollinationsTokenSet && <span className="ml-1 text-emerald-400">已配置</span>}
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
