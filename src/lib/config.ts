import fs from "node:fs";
import { CONFIG_PATH, atomicWrite, quarantineCorrupt } from "./paths";

export type ImageProviderName = "pollinations" | "aurixel" | "openai";

export interface AppConfig {
  /** Wildberries 内容(Контент) API Token */
  wbContentToken: string;
  /** Wildberries 价格(Цены) API Token；留空复用内容 Token */
  wbPricesToken: string;
  /** 使用沙盒环境(content-api-sandbox.wildberries.ru)；测试 Token 必须开启 */
  wbSandbox: boolean;
  /** 文生图提供方 */
  imageProvider: ImageProviderName;
  openaiApiKey: string;
  /** Aurixel API key（ck_...，OpenAI 兼容网关，gpt-image-2） */
  aurixelApiKey: string;
  /** Aurixel 文案模型（聊天），如 gpt-5.5 / gpt-4o / claude-opus-4-8。文案即用此模型 */
  aurixelChatModel: string;
  /** Pollinations token（免费注册可解除限流/水印） */
  pollinationsToken: string;
  /** 对外公网基础 URL（供 WB 拉取图片） */
  publicBaseUrl: string;
}

const DEFAULTS: AppConfig = {
  wbContentToken: "",
  wbPricesToken: "",
  wbSandbox: false,
  imageProvider: "pollinations",
  openaiApiKey: "",
  aurixelApiKey: "",
  aurixelChatModel: "gpt-5.5",
  pollinationsToken: "",
  publicBaseUrl: "",
};

function fromEnv(): Partial<AppConfig> {
  return {
    wbContentToken: process.env.WB_CONTENT_TOKEN || undefined,
    wbPricesToken: process.env.WB_PRICES_TOKEN || undefined,
    wbSandbox: process.env.WB_SANDBOX === "true" ? true : undefined,
    imageProvider: (process.env.IMAGE_PROVIDER as ImageProviderName) || undefined,
    openaiApiKey: process.env.OPENAI_API_KEY || undefined,
    aurixelApiKey: process.env.AURIXEL_API_KEY || undefined,
    aurixelChatModel: process.env.AURIXEL_CHAT_MODEL || undefined,
    pollinationsToken: process.env.POLLINATIONS_TOKEN || undefined,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || undefined,
  };
}

function fromFile(): Partial<AppConfig> {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    // corrupt config → quarantine instead of silently reverting to defaults
    quarantineCorrupt(CONFIG_PATH);
    return {};
  }
}

function clean<T extends object>(obj: Partial<T>): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== "")
  ) as Partial<T>;
}

/** Precedence: saved file > env > defaults. (File is what the Settings page edits.) */
export function getConfig(): AppConfig {
  return { ...DEFAULTS, ...clean(fromEnv()), ...clean(fromFile()) };
}

export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  const current = { ...fromFile() };
  const next = { ...current, ...patch };
  atomicWrite(CONFIG_PATH, JSON.stringify(next, null, 2));
  return getConfig();
}

export function pricesToken(cfg: AppConfig): string {
  return cfg.wbPricesToken || cfg.wbContentToken;
}

/** Never leak secrets to the client — return only booleans, never token chars. */
export function redactConfig(cfg: AppConfig) {
  return {
    // whether the app itself is access-protected (APP_PASSWORD set)
    authEnabled: !!process.env.APP_PASSWORD,
    // demo mode if no content token OR WB_DRY_RUN forced (matches pipeline.ts)
    dryRun: process.env.WB_DRY_RUN === "true" || !cfg.wbContentToken,
    wbContentTokenSet: !!cfg.wbContentToken,
    wbPricesTokenSet: !!cfg.wbPricesToken,
    wbSandbox: cfg.wbSandbox,
    imageProvider: cfg.imageProvider,
    openaiKeySet: !!cfg.openaiApiKey,
    aurixelKeySet: !!cfg.aurixelApiKey,
    aurixelChatModel: cfg.aurixelChatModel,
    pollinationsTokenSet: !!cfg.pollinationsToken,
    publicBaseUrl: cfg.publicBaseUrl,
  };
}
