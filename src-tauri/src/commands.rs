#![allow(dead_code)]
//! Tauri command layer — the former Next.js /api/* routes, now invoked from the
//! static frontend via `@tauri-apps/api`. Image urls are hydrated to data URLs
//! on the way out (the webview can't hit a server).

use crate::ai::assets::to_data_url;
use crate::ai::excel::parse_excel;
use crate::ai::organize::organize_rows;
use crate::config::{get_config, prices_token, redact_config, save_config};
use crate::generate::generate_listing;
use crate::paths::Paths;
use crate::queue::{self, BatchJob};
use crate::state::AppState;
use crate::store;
use crate::types::{Listing, ListingInput, ListingStage};
use crate::util::original_price;
use crate::wb::cards::{delete_cards, list_card_errors};
use crate::wb::client::{wb_fetch, WbCtx, WbReq};
use crate::wb::marketplace::{
    list_warehouses as mp_list_warehouses, read_stocks, set_stocks, Warehouse,
};
use crate::wb::pipeline::publish_listing;
use crate::wb::prices::{read_all_prices, upload_price_task};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// Inline each image's on-disk bytes as a data URL for the webview.
fn hydrate(paths: &Paths, mut l: Listing) -> Listing {
    for img in l.images.iter_mut() {
        if let Some(d) = to_data_url(paths, &img.url) {
            img.url = d;
        }
    }
    l
}

#[tauri::command]
pub fn ping() -> String {
    "pong".into()
}

/// Open an external URL in the system browser (Tauri webviews don't follow
/// `<a target=_blank>` by themselves).
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("仅支持 http(s) 链接".into());
    }
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn();
    #[cfg(target_os = "linux")]
    let spawned = std::process::Command::new("xdg-open").arg(&url).spawn();
    spawned.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_settings(state: State<Arc<AppState>>) -> Value {
    redact_config(&get_config(&state.paths))
}

#[tauri::command]
pub fn save_settings(state: State<Arc<AppState>>, patch: Value) -> Value {
    let cfg = save_config(&state.paths, &patch);
    redact_config(&cfg)
}

#[tauri::command]
pub async fn generate(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    input: ListingInput,
) -> Result<Listing, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    let app2 = app.clone();
    // live progress so the (slow ~90s) generation feels responsive
    let on = move |stage: &str, ok: bool, msg: &str| {
        let _ = app2.emit("generate:progress", json!({ "stage": stage, "ok": ok, "message": msg }));
    };
    let listing = generate_listing(&st, &cfg, &input, &on)
        .await
        .map_err(|e| e.to_string())?;
    store::save_listing(&st.paths, listing.clone());
    let hydrated = hydrate(&st.paths, listing);
    // also emit so a tab that was navigated away during generation can reconnect
    let _ = app.emit("generate:done", &hydrated);
    Ok(hydrated)
}

/// Re-apply the price/discount for an already-created card. Useful when the
/// initial price task timed out (a brand-new nmID isn't immediately known to
/// WB's discounts-prices system).
#[tauri::command]
pub async fn retry_pricing(state: State<'_, Arc<AppState>>, id: String) -> Result<Listing, String> {
    let st = state.inner().clone();
    let l = store::get_listing(&st.paths, &id).ok_or("未找到该商品")?;
    let nm = l.nm_id.ok_or("该商品还没有 nmID，无法定价")?;
    if l.dry_run {
        return Err("演示模式不支持定价".into());
    }
    let cfg = get_config(&st.paths);
    let ctx = WbCtx {
        token: prices_token(&cfg),
        sandbox: l.sandbox,
    };
    let discount = l.discount.clamp(0.0, 99.0).round();
    let base = original_price(l.price, discount) as i64;
    // Submit once, no polling (the prices API is ≈1 req/min — polling 429s).
    upload_price_task(
        &st,
        &ctx,
        vec![json!({ "nmID": nm, "price": base, "discount": discount as i64 })],
    )
    .await
    .map_err(|e| e.to_string())?;
    let updated = store::update_listing(&st.paths, &id, |x| {
        x.stage = ListingStage::Live;
        x.error = None;
    })
    .unwrap_or(l);
    Ok(hydrate(&st.paths, updated))
}

/// Move a listing's WB card to trash (if it was really published) and delete the
/// local record.
#[tauri::command]
pub async fn trash_card(state: State<'_, Arc<AppState>>, id: String) -> Result<bool, String> {
    let st = state.inner().clone();
    if let Some(l) = store::get_listing(&st.paths, &id) {
        if let Some(nm) = l.nm_id {
            if !l.dry_run {
                let cfg = get_config(&st.paths);
                if !cfg.wb_content_token.is_empty() {
                    let ctx = WbCtx {
                        token: cfg.wb_content_token.clone(),
                        sandbox: l.sandbox,
                    };
                    delete_cards(&st, &ctx, vec![nm])
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(store::delete_listing(&st.paths, &id))
}

#[tauri::command]
pub async fn publish(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<Listing, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    let listing = store::get_listing(&st.paths, &id).ok_or("未找到该商品")?;

    let app2 = app.clone();
    let id2 = id.clone();
    let on = move |stage: &str, ok: bool, msg: &str| {
        let _ = app2.emit(
            "publish:progress",
            json!({ "id": id2, "stage": stage, "ok": ok, "message": msg }),
        );
    };
    let result = publish_listing(&st, &listing, &cfg, &on).await;

    let updated = store::update_listing(&st.paths, &id, |l| {
        l.stage = result.stage;
        l.nm_id = result.nm_id;
        l.imt_id = result.imt_id;
        l.subject_id = result.subject_id;
        l.subject_name = result.subject_name.clone();
        l.dry_run = result.dry_run;
        l.sandbox = result.sandbox;
        l.logs = result.logs.clone();
        l.error = result.error.clone();
    })
    .unwrap_or(listing);
    Ok(hydrate(&st.paths, updated))
}

#[tauri::command]
pub fn list_listings(state: State<Arc<AppState>>) -> Vec<Listing> {
    store::list_listings(&state.paths)
        .into_iter()
        .map(|l| hydrate(&state.paths, l))
        .collect()
}

#[tauri::command]
pub fn get_listing(state: State<Arc<AppState>>, id: String) -> Option<Listing> {
    store::get_listing(&state.paths, &id).map(|l| hydrate(&state.paths, l))
}

#[tauri::command]
pub fn delete_listing(state: State<Arc<AppState>>, id: String) -> bool {
    store::delete_listing(&state.paths, &id)
}

#[tauri::command]
pub async fn import_excel(
    state: State<'_, Arc<AppState>>,
    bytes: Vec<u8>,
) -> Result<Vec<ListingInput>, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    let rows = parse_excel(&bytes).map_err(|e| e.to_string())?;
    Ok(organize_rows(&st.http, &cfg, rows).await)
}

#[tauri::command]
pub async fn list_jobs(state: State<'_, Arc<AppState>>) -> Result<Vec<BatchJob>, String> {
    let st = state.inner().clone();
    Ok(queue::list_jobs(&st).await)
}

#[tauri::command]
pub async fn enqueue_jobs(
    state: State<'_, Arc<AppState>>,
    rows: Vec<ListingInput>,
    auto_publish: bool,
) -> Result<Vec<BatchJob>, String> {
    let st = state.inner().clone();
    Ok(queue::enqueue(st, rows, auto_publish).await)
}

#[tauri::command]
pub async fn clear_jobs(
    state: State<'_, Arc<AppState>>,
    which: String,
) -> Result<Vec<BatchJob>, String> {
    let st = state.inner().clone();
    Ok(queue::clear_jobs(&st, &which).await)
}

// ─────────────────────────────────────────────────────────────────────────────
// 商品管理面板：实时读取 WB 上的卡片 + 价格 + 库存，并允许设库存/改价/删卡。
// 读接口都是「一次性拉取」，绝不轮询（价格写接口才是硬限流的那个）。
// ─────────────────────────────────────────────────────────────────────────────

/// One row in the management panel: live WB state for a single card.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCard {
    #[serde(rename = "nmID")]
    pub nm_id: i64,
    pub vendor_code: String,
    pub subject_name: String,
    pub brand: String,
    pub title: String,
    /// First photo URL from WB CDN (defensive — may be absent on a brand-new card).
    pub photo: Option<String>,
    /// Barcodes (the FBS stock key).
    pub skus: Vec<String>,
    pub price: Option<i64>,
    pub discounted_price: Option<i64>,
    pub discount: Option<i64>,
    pub currency: Option<String>,
    /// Stock summed across the card's skus on the selected warehouse.
    /// None = no warehouse selected (or stock read failed).
    pub stock: Option<i64>,
    pub characteristics: i64,
    /// Derived: "live" | "no_price" | "no_stock" | "rejected" | "ok".
    pub status: String,
    pub status_note: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManageResponse {
    pub cards: Vec<ManagedCard>,
    pub total: usize,
    pub truncated: bool,
    pub warehouse_id: Option<i64>,
    /// Non-fatal issues (e.g. price/stock read failed) surfaced to the UI.
    pub warnings: Vec<String>,
}

fn extract_skus(c: &Value) -> Vec<String> {
    c.get("sizes")
        .and_then(|s| s.as_array())
        .map(|sizes| {
            sizes
                .iter()
                .filter_map(|s| s.get("skus").and_then(|x| x.as_array()))
                .flatten()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn extract_photo(c: &Value) -> Option<String> {
    let first = c.get("photos").and_then(|p| p.as_array()).and_then(|a| a.first())?;
    // photo entries are objects keyed by size; pick a small-but-clear one.
    if let Some(obj) = first.as_object() {
        for k in ["c246x328", "big", "square", "c516x688", "tm"] {
            if let Some(u) = obj.get(k).and_then(|v| v.as_str()) {
                if u.starts_with("http") {
                    return Some(u.to_string());
                }
            }
        }
        // fall back to the first http string value in the object
        return obj
            .values()
            .filter_map(|v| v.as_str())
            .find(|u| u.starts_with("http"))
            .map(|s| s.to_string());
    }
    // some responses give an array of plain URL strings
    first.as_str().filter(|u| u.starts_with("http")).map(|s| s.to_string())
}

fn s(c: &Value, k: &str) -> String {
    c.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// List the seller's FBS warehouses (for the warehouse picker).
#[tauri::command]
pub async fn list_warehouses(state: State<'_, Arc<AppState>>) -> Result<Vec<Warehouse>, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    if cfg.wb_content_token.is_empty() {
        return Err("未配置 WB Token，无法读取仓库。".into());
    }
    let ctx = WbCtx {
        token: cfg.wb_content_token.clone(),
        sandbox: false,
    };
    mp_list_warehouses(&st, &ctx).await.map_err(|e| e.to_string())
}

/// Aggregate WB cards + prices + (optionally) stock for the management panel.
/// One-shot load; the frontend re-calls this only on explicit refresh.
#[tauri::command]
pub async fn manage_cards(
    state: State<'_, Arc<AppState>>,
    warehouse_id: Option<i64>,
) -> Result<ManageResponse, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    if cfg.wb_content_token.is_empty() {
        return Err("未配置 WB Token（演示模式下没有真实商品可管理）。".into());
    }
    let ctx = WbCtx {
        token: cfg.wb_content_token.clone(),
        sandbox: cfg.wb_sandbox,
    };
    let mut warnings: Vec<String> = vec![];

    // 1) all cards via cursor pagination (capped at 1500 to bound worst case).
    let mut raw_cards: Vec<Value> = vec![];
    let mut cursor = json!({ "limit": 100 });
    let mut truncated = false;
    const MAX_PAGES: u32 = 15;
    for page in 0..MAX_PAGES {
        let v = wb_fetch(
            &st,
            &ctx,
            WbReq::post("/content/v2/get/cards/list").body(json!({
                "settings": {
                    "sort": { "ascending": false },
                    "filter": { "withPhoto": -1 },
                    "cursor": cursor
                }
            })),
        )
        .await
        .map_err(|e| e.to_string())?;
        let cards = v.get("cards").and_then(|c| c.as_array()).cloned().unwrap_or_default();
        let n = cards.len();
        let upd = v.pointer("/cursor/updatedAt").cloned();
        let last_nm = v.pointer("/cursor/nmID").cloned();
        raw_cards.extend(cards);
        if n < 100 {
            break;
        }
        if page + 1 == MAX_PAGES {
            truncated = true;
            break;
        }
        cursor = json!({ "limit": 100, "updatedAt": upd, "nmID": last_nm });
    }

    // 2) prices (one-shot; non-fatal on failure).
    let prices = match read_all_prices(
        &st,
        &WbCtx {
            token: prices_token(&cfg),
            sandbox: cfg.wb_sandbox,
        },
    )
    .await
    {
        Ok(m) => m,
        Err(e) => {
            warnings.push(format!("价格读取失败：{}", e));
            std::collections::HashMap::new()
        }
    };

    // 3) stock for the chosen warehouse (non-fatal). All skus in one batched read.
    let all_skus: Vec<String> = raw_cards.iter().flat_map(extract_skus).collect();
    let stocks = match warehouse_id {
        Some(wh) if !all_skus.is_empty() => {
            let mp_ctx = WbCtx {
                token: cfg.wb_content_token.clone(),
                sandbox: false,
            };
            match read_stocks(&st, &mp_ctx, wh, &all_skus).await {
                Ok(m) => Some(m),
                Err(e) => {
                    warnings.push(format!("库存读取失败：{}", e));
                    None
                }
            }
        }
        _ => None,
    };

    // 4) rejected vendorCodes (non-fatal).
    let rejected: HashSet<String> = match list_card_errors(&st, &ctx).await {
        Ok(list) => list
            .into_iter()
            .filter(|(_, e)| !e.is_empty())
            .map(|(vc, _)| vc)
            .collect(),
        Err(_) => HashSet::new(),
    };

    // 5) assemble
    let mut cards: Vec<ManagedCard> = vec![];
    for c in &raw_cards {
        let nm = c.get("nmID").and_then(|x| x.as_i64()).unwrap_or(0);
        let vendor_code = s(c, "vendorCode");
        let skus = extract_skus(c);
        let price = prices.get(&nm);
        let stock = stocks
            .as_ref()
            .map(|m| skus.iter().map(|sk| m.get(sk).copied().unwrap_or(0)).sum::<i64>());
        let characteristics = c
            .get("characteristics")
            .and_then(|x| x.as_array())
            .map(|a| a.len() as i64)
            .unwrap_or(0);

        let (status, note) = if rejected.contains(&vendor_code) {
            ("rejected", "被 WB 拒绝（见卡片错误/上架记录）".to_string())
        } else if price.is_none() {
            ("no_price", "未定价".to_string())
        } else if let Some(amt) = stock {
            if amt <= 0 {
                ("no_stock", "无库存（补货后可售）".to_string())
            } else {
                ("live", format!("可售 · 库存 {}", amt))
            }
        } else {
            ("ok", "已定价（选择仓库可查看库存）".to_string())
        };

        cards.push(ManagedCard {
            nm_id: nm,
            vendor_code,
            subject_name: s(c, "subjectName"),
            brand: s(c, "brand"),
            title: s(c, "title"),
            photo: extract_photo(c),
            skus,
            price: price.map(|p| p.price),
            discounted_price: price.map(|p| p.discounted_price),
            discount: price.map(|p| p.discount),
            currency: price.map(|p| p.currency.clone()),
            stock,
            characteristics,
            status: status.to_string(),
            status_note: note,
        });
    }

    let total = cards.len();
    Ok(ManageResponse {
        cards,
        total,
        truncated,
        warehouse_id,
        warnings,
    })
}

/// Set absolute FBS stock for a card's barcodes on a warehouse. amount=0 = 下架.
#[tauri::command]
pub async fn set_card_stock(
    state: State<'_, Arc<AppState>>,
    warehouse_id: i64,
    skus: Vec<String>,
    amount: i64,
) -> Result<(), String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    if cfg.wb_content_token.is_empty() {
        return Err("未配置 WB Token。".into());
    }
    if warehouse_id <= 0 {
        return Err("请先选择仓库。".into());
    }
    if skus.is_empty() {
        return Err("该商品没有条码(sku)，无法设库存。".into());
    }
    let ctx = WbCtx {
        token: cfg.wb_content_token.clone(),
        sandbox: false,
    };
    let items: Vec<(String, i64)> = skus.into_iter().map(|sk| (sk, amount.max(0))).collect();
    set_stocks(&st, &ctx, warehouse_id, &items)
        .await
        .map_err(|e| e.to_string())
}

/// Re-apply price/discount for a card by nmID (submit-only, no polling).
/// `price` is the WB base (pre-discount) price as shown in the panel.
#[tauri::command]
pub async fn set_card_price(
    state: State<'_, Arc<AppState>>,
    nm_id: i64,
    price: i64,
    discount: i64,
) -> Result<(), String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    if cfg.wb_content_token.is_empty() {
        return Err("未配置 WB Token。".into());
    }
    let ctx = WbCtx {
        token: prices_token(&cfg),
        sandbox: cfg.wb_sandbox,
    };
    let d = discount.clamp(0, 99);
    upload_price_task(
        &st,
        &ctx,
        vec![json!({ "nmID": nm_id, "price": price, "discount": d })],
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Move one or more WB cards to trash by nmID (recoverable 30 days).
#[tauri::command]
pub async fn trash_cards(
    state: State<'_, Arc<AppState>>,
    nm_ids: Vec<i64>,
) -> Result<(), String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    if cfg.wb_content_token.is_empty() {
        return Err("未配置 WB Token。".into());
    }
    if nm_ids.is_empty() {
        return Ok(());
    }
    let ctx = WbCtx {
        token: cfg.wb_content_token.clone(),
        sandbox: cfg.wb_sandbox,
    };
    delete_cards(&st, &ctx, nm_ids).await.map_err(|e| e.to_string())
}
