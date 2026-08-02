// Thin typed wrapper over the Rust Tauri commands — replaces the former
// fetch('/api/*') calls. Tauri maps camelCase JS arg keys to snake_case params.
import { invoke } from "@tauri-apps/api/core";
import type {
  AurixelBalance,
  ConnTest,
  WbCheck,
  DubOptions,
  DubPreflight,
  EngineStatus,
  ImageTemplates,
  Listing,
  ListingInput,
  ManageView,
  MediaFile,
  WbCharacteristic,
  WbColor,
  WbSubject,
  SyncResult,
  Warehouse,
} from "./types";

export interface RedactedConfig {
  authEnabled: boolean;
  dryRun: boolean;
  wbContentTokenSet: boolean;
  wbPricesTokenSet: boolean;
  /** Days until the WB content token (JWT) expires; null if none/unparseable. */
  wbTokenExpiresInDays: number | null;
  /** Days until the price-write token expires (can differ from content token). */
  wbPricesTokenExpiresInDays: number | null;
  wbSandbox: boolean;
  imageProvider: string;
  openaiKeySet: boolean;
  aurixelKeySet: boolean;
  aurixelChatModel: string;
  pollinationsTokenSet: boolean;
  publicBaseUrl: string;
  /** Default FBS warehouse for auto-stock + management panel (0 = unset). */
  defaultWarehouseId: number;
  /** Quantity used for auto-stock on publish / quick refill. */
  defaultStock: number;
  /** Whether publish sets stock automatically once the card is created. */
  autoStock: boolean;
  /** Seller's typical package (cm / kg) — batch default + generate pre-fill. */
  defaultLength: number;
  defaultWidth: number;
  defaultHeight: number;
  defaultWeight: number;
  /** Editable image-prompt templates (active = user override or built-in defaults). */
  imageTemplates: ImageTemplates;
}

export interface Job {
  id: string;
  input: ListingInput;
  autoPublish: boolean;
  status: "pending" | "generating" | "publishing" | "done" | "error";
  nmID: number | null;
  /** id of the Listing this job generated (for the bilingual review grid). */
  listingId: string | null;
  sandbox: boolean;
  error: string | null;
}

export interface GenerateInput {
  productName: string;
  keywords: string[];
  price: number;
  discount: number;
  brand?: string;
  /** Free-text styling injected into the image prompt. */
  customPrompt?: string;
  /** Number of images to generate (1–12). */
  imageCount?: number;
  /** Real product photos (data URLs) → img2img base; empty = text-to-image. */
  basePhotos?: string[];
  /** Publish `basePhotos` AS the product images — no AI image generation at all
   *  (no image spend, no waiting). Copy/characteristics still run normally. */
  useOwnMedia?: boolean;
  /** Package dimensions (cm) + gross weight (kg). 0/unset → seller defaults. */
  length?: number;
  width?: number;
  height?: number;
  weight?: number;
}

export const api = {
  getSettings: () => invoke<RedactedConfig>("get_settings"),
  saveSettings: (patch: Record<string, unknown>) =>
    invoke<RedactedConfig>("save_settings", { patch }),
  /** The built-in image-prompt templates (for "reset to default"). */
  defaultTemplates: () => invoke<ImageTemplates>("default_templates"),
  generate: (input: GenerateInput, mainOnly = false) =>
    invoke<Listing>("generate", { input, mainOnly }),
  /** Re-render one image of a draft with the same template. */
  regenerateImage: (id: string, index: number, basePhotos: string[], customPrompt?: string) =>
    invoke<Listing>("regenerate_image", { id, index, basePhotos, customPrompt }),
  /** Generate the remaining images after the main-first preview is approved. */
  generateRest: (id: string, basePhotos: string[], customPrompt?: string) =>
    invoke<Listing>("generate_rest", { id, basePhotos, customPrompt }),
  /** Edit the draft's title/description/bullets before publishing. */
  updateCopy: (id: string, title: string, description: string, bullets: string[]) =>
    invoke<Listing>("update_copy", { id, title, description, bullets }),
  /** Translate a manually-written Chinese listing → Russian (title/desc/bullets).
   *  Pure translate (no DB write); the copy editor fills the RU fields with it. */
  translateCopy: (title: string, description: string, bullets: string[]) =>
    invoke<{ title: string; description: string; bullets: string[] }>("translate_copy", {
      title,
      description,
      bullets,
    }),
  /** Attach (or clear with "") the dubbed RU video path on a draft. */
  setListingVideo: (id: string, path: string) =>
    invoke<Listing>("set_listing_video", { id, path }),
  /** Save user-edited 全部商品参数 (category override + characteristics + TNVED). */
  updateParams: (
    id: string,
    params: {
      subjectId?: number;
      subjectName?: string;
      characteristics: { id: number; value: unknown }[];
      tnved?: string;
    }
  ) =>
    invoke<Listing>("update_params", {
      id,
      subjectId: params.subjectId,
      subjectName: params.subjectName,
      characteristics: params.characteristics,
      tnved: params.tnved,
    }),
  /** Update a draft's package dimensions (cm) + gross weight (kg) at 复核. */
  updateDimensions: (
    id: string,
    dims: { length: number; width: number; height: number; weight: number }
  ) => invoke<Listing>("update_dimensions", { id, ...dims }),
  publish: (id: string) => invoke<Listing>("publish", { id }),
  listListings: () => invoke<Listing[]>("list_listings"),
  getListing: (id: string) => invoke<Listing | null>("get_listing", { id }),
  deleteListing: (id: string) => invoke<boolean>("delete_listing", { id }),
  /** Move the WB card to trash (if published) + delete the local record. */
  trashCard: (id: string) => invoke<boolean>("trash_card", { id }),
  /** Re-apply price/discount for an already-created card (after WB activates it). */
  retryPricing: (id: string) => invoke<Listing>("retry_pricing", { id }),
  /** Open an external URL in the system browser. */
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  importExcel: (bytes: number[]) => invoke<ListingInput[]>("import_excel", { bytes }),
  listJobs: () => invoke<Job[]>("list_jobs"),
  enqueueJobs: (rows: ListingInput[], autoPublish: boolean) =>
    invoke<Job[]>("enqueue_jobs", { rows, autoPublish }),
  clearJobs: (which: "finished" | "all") => invoke<Job[]>("clear_jobs", { which }),
  /** Batch review grid: the generated listings for all jobs (hydrated). */
  listJobListings: () => invoke<Listing[]>("list_job_listings"),
  /** Native folder picker → absolute dir path (批量「关联素材文件夹」). */
  pickFolder: () => invoke<string | null>("pick_folder"),
  /** List image/video files in a folder (non-recursive). */
  listMediaFiles: (dir: string) => invoke<MediaFile[]>("list_media_files", { dir }),
  /** Read a local image into a data URL (for base_photos). */
  readFileB64: (path: string) => invoke<string>("read_file_b64", { path }),

  // ── WB 类目 / 特征字典(发布「全部商品参数」)──
  /** Search WB categories by free text (override the AI-picked one). */
  searchSubjects: (name: string) => invoke<WbSubject[]>("search_subjects", { name }),
  /** Full characteristics dictionary for a subject. */
  subjectCharacteristics: (subjectId: number) =>
    invoke<WbCharacteristic[]>("subject_characteristics", { subjectId }),
  /** Clear the learned ru→zh characteristic-name cache (next open re-calibrates). */
  recalibrateCharcNames: () => invoke<number>("recalibrate_charc_names"),
  /** AI-predicted characteristics [{id,value}] for a draft (editor pre-fill). */
  predictCharacteristics: (id: string, subjectId: number) =>
    invoke<{ id: number; value: unknown }[]>("predict_characteristics", { id, subjectId }),
  /** WB color directory (цвет dropdown). */
  wbColors: () => invoke<WbColor[]>("wb_colors"),
  /** Resolve a TNVED customs code for a subject. */
  wbTnved: (subjectId: number, search?: string) =>
    invoke<string | null>("wb_tnved", { subjectId, search }),

  // ── Management panel (local-first: read DB, sync on demand) ──
  /** Seller's FBS warehouses, live (used by Settings). */
  listWarehouses: () => invoke<Warehouse[]>("list_warehouses"),
  /** First-run wizard: validate an Aurixel key. */
  testAurixel: (key: string) => invoke<ConnTest>("test_aurixel", { key }),
  /** Read the configured Aurixel key's balance (¥ / $). */
  aurixelBalance: () => invoke<AurixelBalance>("aurixel_balance"),
  /** First-run wizard: validate a WB token (+ return its FBS warehouses). */
  testWb: (token: string, sandbox: boolean) =>
    invoke<WbCheck>("test_wb", { token, sandbox }),
  /** Read the whole panel from the local DB — instant, no network. */
  dbListCards: (warehouseId: number | null) =>
    invoke<ManageView>("db_list_cards", { warehouseId }),
  /** Sync cards (content, safe) → DB. */
  syncProducts: () => invoke<SyncResult>("sync_products"),
  /** Sync warehouses (marketplace, safe) → DB. */
  syncWarehouses: () => invoke<SyncResult>("sync_warehouses"),
  /** Sync stock for a warehouse (marketplace, safe) → DB. */
  syncStocks: (warehouseId: number) =>
    invoke<SyncResult>("sync_stocks", { warehouseId }),
  /** Sync prices (GUARDED — blocked while the prices domain is cooling down). */
  syncPrices: () => invoke<SyncResult>("sync_prices"),
  /** Set absolute FBS stock for a card's barcodes (amount 0 = 下架). */
  setCardStock: (warehouseId: number, skus: string[], amount: number) =>
    invoke<void>("set_card_stock", { warehouseId, skus, amount }),
  /** Re-apply price/discount by nmID (submit-only, base price as shown). */
  setCardPrice: (nmId: number, price: number, discount: number) =>
    invoke<void>("set_card_price", { nmId, price, discount }),
  /** Move WB cards to trash by nmID (recoverable 30 days). */
  trashCards: (nmIds: number[]) => invoke<void>("trash_cards", { nmIds }),

  // ── EN→RU 视频配音 ──
  /** Check node/ffmpeg/uvx + Aurixel key — drives the preflight 自检条. */
  dubPreflight: () => invoke<DubPreflight>("dub_preflight"),
  /** Native open-file dialog → absolute video path (null if cancelled). */
  dubPickVideo: () => invoke<string | null>("dub_pick_video"),
  /** Start a dub job. Resolves with the output mp4 path; also streams
   * `dub:progress` events + a final `dub:done`. */
  dubStart: (options: DubOptions) => invoke<string>("dub_start", { options }),
  /** Cancel the running dub job — or the engine download (true if one was running). */
  dubCancel: () => invoke<boolean>("dub_cancel"),
  /** Pre-download/warm the dub engine (Demucs + voice-select). Streams `dub:engine`. */
  dubPrepareEngine: () => invoke<void>("dub_prepare_engine"),
  /** REAL functional test: runs one actual Demucs separation through the dub path.
   *  Rejects with the true reason if it can't separate. Streams `dub:engine`. */
  dubSelftest: () => invoke<void>("dub_selftest"),
  /** Engine state (downloading / ready / last progress) — for Settings + re-hydrate. */
  dubEngineStatus: () => invoke<EngineStatus>("dub_engine_status"),
  /** Open a local file with the OS default app. */
  /** Save a generated image (data: URL) to disk via a native dialog. The webview
   *  ignores <a download>, so the 下载 button uses this. Returns the saved path
   *  (absolute) or null if the user cancelled. */
  saveImageFile: (dataUrl: string, suggestedName: string) =>
    invoke<string | null>("save_image_file", { dataUrl, suggestedName }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  /** Reveal a local file in the OS file manager. */
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
};
