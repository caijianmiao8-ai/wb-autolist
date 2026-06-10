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
}

export interface GeneratedImage {
  id: string;
  kind: "main" | "promo" | "gallery";
  url: string; // public-servable path: /api/images/<file>
  prompt: string;
  width: number;
  height: number;
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
}

export interface ListingInput {
  productName: string;
  keywords: string[];
  price: number;
  discount: number;
  brand?: string;
}
