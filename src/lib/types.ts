// ── Shared domain types (safe to import from client & server) ──

export type Locale = "ru" | "zh" | "en";

/** AI-generated marketing copy for a product card. */
export interface ProductCopy {
  title: string; // ≤ 60 chars (WB limit)
  description: string; // ≤ 2000 chars
  bullets: string[]; // 卖点
  brand: string;
  keywords: string[]; // 搜索关键词
  /** suggested category name for subject resolution */
  categoryHint: string;
  /** English prompt actually used to generate the product image */
  imagePrompt?: string;
  /** Chinese reference translations (REFERENCE ONLY — never published to WB). */
  titleZh?: string;
  descriptionZh?: string;
  bulletsZh?: string[];
}

export interface GeneratedImage {
  id: string;
  kind: "main" | "promo" | "gallery";
  url: string; // public-servable path: /api/images/<file>
  prompt: string;
  width: number;
  height: number;
  /** template archetype that produced it (for single-image regenerate) */
  templateKind?: string;
}

export type ListingStage =
  | "draft" // generated, not published
  | "queued" // submitted to WB
  | "creating" // card created, waiting for nmID
  | "media" // attaching photos
  | "pricing" // setting price
  | "live" // success, card visible
  | "error";

export interface StageLog {
  ts: string;
  stage: ListingStage | "generate";
  ok: boolean;
  message: string;
  data?: unknown;
}

export interface Listing {
  id: string;
  createdAt: string;
  updatedAt: string;
  // input
  productName: string;
  keywords: string[];
  price: number; // RUB
  discount: number; // %
  brand: string;
  // package dims (cm) + gross weight (kg) — WB bills logistics/storage on these
  length?: number;
  width?: number;
  height?: number;
  weight?: number;
  // generated
  copy: ProductCopy | null;
  images: GeneratedImage[];
  // WB resolution
  subjectId: number | null;
  subjectName: string | null;
  vendorCode: string;
  // WB result
  stage: ListingStage;
  nmID: number | null;
  imtID: number | null;
  dryRun: boolean;
  /** true if this card was created in the WB sandbox (no public buyer page) */
  sandbox: boolean;
  logs: StageLog[];
  error: string | null;
  /** true = only the main image is generated; rest pending via generateRest */
  partial?: boolean;
  /** total images requested (for the "generate the rest" step) */
  requestedImages?: number;
  /** Absolute path to the Russian-dubbed video, attached as the card's video on publish. */
  videoRu?: string;
  /** User-confirmed WB characteristics [{id, value}] (用户值优先, AI 兜底). */
  characteristics?: { id: number; value: unknown }[];
  /** User-set TNVED customs code; empty = auto-resolved. */
  tnved?: string;
}

export interface ListingInput {
  productName: string;
  keywords: string[];
  price: number;
  discount: number;
  brand?: string;
  /** Matched real product photos (data URLs) → img2img base; empty = text-to-image. */
  basePhotos?: string[];
}

// ── Editable image-prompt templates ──

export interface ImageTemplate {
  kind: string;
  slot: string; // "main" | "promo" | "gallery"
  label: string;
  body: string; // parametric prompt with {PLACEHOLDER} tokens
  textMode: string; // "model" | "overlay"
  enabled: boolean;
}

export interface ImageTemplates {
  version: number;
  source?: string; // "builtin" | "user" — user-edited sets are never auto-overridden
  rotation: string[];
  templates: ImageTemplate[];
}

// ── Management panel (live WB state) ──

export interface Warehouse {
  id: number;
  name: string;
  officeId: number;
  cargoType: number;
  deliveryType: number;
}

export type ManagedStatus =
  | "live"
  | "no_price"
  | "price_unknown"
  | "no_stock"
  | "rejected"
  | "ok";

export interface ManagedCard {
  nmID: number;
  vendorCode: string;
  subjectName: string;
  brand: string;
  title: string;
  photo: string | null;
  skus: string[];
  price: number | null;
  discountedPrice: number | null;
  discount: number | null;
  currency: string | null;
  /** stock on the selected warehouse; null = no warehouse selected */
  stock: number | null;
  characteristics: number;
  status: ManagedStatus;
  statusNote: string;
}

/** Freshness of one synced data type. */
export interface MetaRow {
  lastSyncAt: number; // epoch seconds, 0 = never
  status: string; // "ok" | "error" | ""
  detail: string;
  cooldownUntil: number; // epoch seconds
}

export interface SyncStatus {
  products: MetaRow;
  prices: MetaRow;
  stocks: MetaRow;
  warehouses: MetaRow;
  /** seconds until prices can be synced again (0 = ready) */
  pricesCooldownRemaining: number;
  nowEpoch: number;
}

/** Everything the panel needs — read entirely from the local DB. */
export interface ManageView {
  cards: ManagedCard[];
  warehouses: Warehouse[];
  sync: SyncStatus;
  warehouseId: number | null;
}

export interface SyncResult {
  ok: boolean;
  count: number;
  message: string;
  pricesCooldownRemaining: number;
}

/** First-run wizard: result of a "测试连接" probe. */
export interface ConnTest {
  ok: boolean;
  detail: string;
  warehouses: Warehouse[];
}

// ── 批量「关联素材文件夹」──

/** One image/video file found in a linked media folder. */
export interface MediaFile {
  name: string; // file name with extension
  stem: string; // name without extension (for 商品名/货号 matching)
  path: string; // absolute path
  ext: string; // lowercase, no dot
  kind: "image" | "video";
}

// ── WB 类目 / 特征字典(发布「全部商品参数」)──

export interface WbSubject {
  subjectID: number;
  subjectName: string;
  parentID?: number;
  parentName?: string;
}

export interface WbCharacteristic {
  charcID: number;
  name: string;
  /** Chinese display name (WB locale=zh); empty if WB has no zh label. */
  nameZh?: string;
  required: boolean;
  unitName: string;
  maxCount: number;
  popular: boolean;
  /** 4 = number; otherwise text / dictionary. */
  charcType: number;
  subjectName?: string;
  subjectID?: number;
}

export interface WbColor {
  name: string;
  parentName?: string;
}

/** Aurixel gateway balance for the configured key. */
export interface AurixelBalance {
  usd: number;
  rmb: number;
}

// ── EN→RU 视频配音 ──

/** Runtime health check for the dubbing pipeline (drives the 自检条). */
export interface EngineStatus {
  /** a download/warm is currently running */
  preparing: boolean;
  /** engine prepared at least once (sentinel present) */
  ready: boolean;
  /** latest progress line */
  lastMsg: string;
}

export interface DubPreflight {
  node: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
  /** optional: Demucs background-separation + best-of-K voice select */
  uvx: boolean;
  aurixelKey: boolean;
  cliFound: boolean;
  /** all required pieces present → 开始配音 enabled */
  ready: boolean;
  nodePath: string;
  cliPath: string;
}

export interface DubOptions {
  inputPath: string;
  outPath?: string;
  brand?: string;
  keywords?: string;
  tone?: string;
  voiceMode?: "clone" | "preset";
  presetVoice?: string;
  quality?: "fast" | "standard" | "high";
  keepBackground?: boolean;
  gateSilence?: boolean;
  diarize?: boolean;
  /** burn Russian subtitles into the video (default true) */
  subtitles?: boolean;
  /** 0..1 — duck the original audio under the dub (0 = full replace) */
  keepOriginalAudio?: number;
}

/** One pipeline stage event streamed from the CLI via `dub:progress`. */
export interface DubProgress {
  stage: string;
  ok: boolean;
  ms: number;
  warn?: string;
  error?: string;
}
