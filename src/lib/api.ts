// Thin typed wrapper over the Rust Tauri commands — replaces the former
// fetch('/api/*') calls. Tauri maps camelCase JS arg keys to snake_case params.
import { invoke } from "@tauri-apps/api/core";
import type {
  Listing,
  ListingInput,
  ManageResponse,
  Warehouse,
} from "./types";

export interface RedactedConfig {
  authEnabled: boolean;
  dryRun: boolean;
  wbContentTokenSet: boolean;
  wbPricesTokenSet: boolean;
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
}

export interface Job {
  id: string;
  input: ListingInput;
  autoPublish: boolean;
  status: "pending" | "generating" | "publishing" | "done" | "error";
  nmID: number | null;
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
  /** Number of images to generate (1–8). */
  imageCount?: number;
  /** Real product photos (data URLs) → img2img base; empty = text-to-image. */
  basePhotos?: string[];
}

export const api = {
  getSettings: () => invoke<RedactedConfig>("get_settings"),
  saveSettings: (patch: Record<string, unknown>) =>
    invoke<RedactedConfig>("save_settings", { patch }),
  generate: (input: GenerateInput) => invoke<Listing>("generate", { input }),
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

  // ── Management panel (live WB) ──
  /** Seller's FBS warehouses (for the warehouse picker). */
  listWarehouses: () => invoke<Warehouse[]>("list_warehouses"),
  /** Aggregate cards + prices + (optional) stock. One-shot; call on refresh only. */
  manageCards: (warehouseId: number | null) =>
    invoke<ManageResponse>("manage_cards", { warehouseId }),
  /** Set absolute FBS stock for a card's barcodes (amount 0 = 下架). */
  setCardStock: (warehouseId: number, skus: string[], amount: number) =>
    invoke<void>("set_card_stock", { warehouseId, skus, amount }),
  /** Re-apply price/discount by nmID (submit-only, base price as shown). */
  setCardPrice: (nmId: number, price: number, discount: number) =>
    invoke<void>("set_card_price", { nmId, price, discount }),
  /** Move WB cards to trash by nmID (recoverable 30 days). */
  trashCards: (nmIds: number[]) => invoke<void>("trash_cards", { nmIds }),
};
