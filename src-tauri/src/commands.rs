#![allow(dead_code)]
//! Tauri command layer — the former Next.js /api/* routes, now invoked from the
//! static frontend via `@tauri-apps/api`. Image urls are hydrated to data URLs
//! on the way out (the webview can't hit a server).

use crate::ai::assets::to_data_url;
use crate::ai::excel::parse_excel;
use crate::ai::organize::organize_rows;
use crate::config::{active_templates, get_config, prices_token, redact_config, save_config, AppConfig};
use crate::db;
use crate::generate::{build_ctx, decode_image_input, generate_listing, render_one};
use crate::paths::Paths;
use crate::queue::{self, BatchJob};
use crate::state::AppState;
use crate::store;
use crate::types::{GeneratedImage, Listing, ListingInput, ListingStage};
use crate::util::original_price;
use crate::wb::cards::{delete_cards, list_card_errors};
use crate::wb::client::{wb_fetch, WbCtx, WbReq};
use crate::wb::marketplace::{
    list_warehouses as mp_list_warehouses, read_stocks, set_stocks, Warehouse,
};
use crate::wb::categories::{get_characteristics, get_colors, get_tnved};
use crate::wb::pipeline::publish_listing;
use crate::wb::prices::{read_all_prices, upload_price_task};
use crate::wb::types::{WbCharacteristic, WbColor, WbSubject};
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
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

/// The built-in image-prompt templates (for the editor's "reset to default").
#[tauri::command]
pub fn default_templates() -> crate::templates::ImageTemplates {
    crate::templates::built_in_defaults()
}

#[tauri::command]
pub async fn generate(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    input: ListingInput,
    main_only: bool,
) -> Result<Listing, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    let app2 = app.clone();
    // live progress so the (slow ~90s) generation feels responsive
    let on = move |stage: &str, ok: bool, msg: &str| {
        let _ = app2.emit("generate:progress", json!({ "stage": stage, "ok": ok, "message": msg }));
    };
    let listing = generate_listing(&st, &cfg, &input, &on, main_only)
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
    // The card lives in the env it was created in; refuse if the current token is
    // for the other env (avoids a confusing 401 / wrong-store write).
    if l.sandbox != cfg.wb_sandbox {
        return Err(format!(
            "此商品在{}创建，当前是{}环境，请在设置切回后再重试定价。",
            if l.sandbox { "沙盒" } else { "线上" },
            if cfg.wb_sandbox { "沙盒" } else { "线上" }
        ));
    }
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

    // In-flight guard: refuse a second concurrent publish of the same listing
    // (double-click, or the batch worker racing a manual publish). Combined with
    // the pipeline's nmID idempotency, this stops duplicate cards.
    {
        let mut inflight = st.publishing.lock().unwrap_or_else(|e| e.into_inner());
        if !inflight.insert(id.clone()) {
            return Err("该商品正在上架中，请稍候…".into());
        }
    }

    let app2 = app.clone();
    let id2 = id.clone();
    let on = move |stage: &str, ok: bool, msg: &str| {
        let _ = app2.emit(
            "publish:progress",
            json!({ "id": id2, "stage": stage, "ok": ok, "message": msg }),
        );
    };
    let result = publish_listing(&st, &listing, &cfg, &on).await;
    // release the in-flight guard regardless of outcome (no `?` above)
    {
        let mut inflight = st.publishing.lock().unwrap_or_else(|e| e.into_inner());
        inflight.remove(&id);
    }

    let updated = store::update_listing(&st.paths, &id, |l| {
        l.stage = result.stage;
        // Never let a None erase a known nmID/imtID — a card created in a prior
        // partial attempt must stay visible & fixable, not orphaned.
        l.nm_id = result.nm_id.or(l.nm_id);
        l.imt_id = result.imt_id.or(l.imt_id);
        l.subject_id = result.subject_id.or(l.subject_id);
        if result.subject_name.is_some() {
            l.subject_name = result.subject_name.clone();
        }
        // persist the ACTUAL vendorCode/sku used (brand-retry may have changed them)
        if let Some(vc) = &result.vendor_code {
            l.vendor_code = vc.clone();
        }
        if let Some(sk) = &result.sku {
            l.sku = sk.clone();
        }
        l.dry_run = result.dry_run;
        l.sandbox = result.sandbox;
        l.logs = result.logs.clone();
        l.error = result.error.clone();
    })
    .unwrap_or(listing);
    Ok(hydrate(&st.paths, updated))
}

/// Edit the AI-generated copy of a draft before publishing. Lets the seller fix
/// the title/description/bullets instead of shipping whatever the model wrote
/// (WB caps title at 60 and description at 2000 chars — enforced here).
#[tauri::command]
pub async fn update_copy(
    state: State<'_, Arc<AppState>>,
    id: String,
    title: String,
    description: String,
    bullets: Vec<String>,
) -> Result<Listing, String> {
    let st = state.inner().clone();
    let updated = store::update_listing(&st.paths, &id, |l| {
        if let Some(c) = l.copy.as_mut() {
            c.title = title.trim().chars().take(60).collect();
            c.description = description.trim().chars().take(2000).collect();
            c.bullets = bullets
                .into_iter()
                .map(|b| b.trim().to_string())
                .filter(|b| !b.is_empty())
                .collect();
        }
    })
    .ok_or("未找到该商品")?;
    Ok(hydrate(&st.paths, updated))
}

/// Attach (or clear) the Russian-dubbed video path on a draft, so publish uploads
/// it as the card's video. Called by the single-flow after dubbing completes.
#[tauri::command]
pub fn set_listing_video(
    state: State<Arc<AppState>>,
    id: String,
    path: String,
) -> Result<Listing, String> {
    let p = path.trim().to_string();
    let updated = store::update_listing(&state.paths, &id, |l| {
        l.video_ru = if p.is_empty() { None } else { Some(p.clone()) };
    })
    .ok_or("未找到该商品")?;
    Ok(hydrate(&state.paths, updated))
}

/// Save user-edited 全部商品参数 onto a draft: category override + confirmed
/// characteristics ([{id,value}]) + TNVED. publish uses these (用户值优先).
#[tauri::command]
pub fn update_params(
    state: State<Arc<AppState>>,
    id: String,
    subject_id: Option<i64>,
    subject_name: Option<String>,
    characteristics: Vec<Value>,
    tnved: Option<String>,
) -> Result<Listing, String> {
    let updated = store::update_listing(&state.paths, &id, |l| {
        if let Some(sid) = subject_id {
            l.subject_id = Some(sid);
        }
        if let Some(sn) = &subject_name {
            l.subject_name = Some(sn.clone());
        }
        l.characteristics = characteristics.clone();
        if let Some(t) = &tnved {
            l.tnved = t.trim().to_string();
        }
    })
    .ok_or("未找到该商品")?;
    Ok(hydrate(&state.paths, updated))
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

/// Batch review grid: the generated (hydrated) Listing for every job that has
/// produced one — so the frontend renders bilingual cards without N round-trips.
#[tauri::command]
pub async fn list_job_listings(state: State<'_, Arc<AppState>>) -> Result<Vec<Listing>, String> {
    let st = state.inner().clone();
    let jobs = queue::list_jobs(&st).await;
    let mut out = Vec::new();
    for j in jobs {
        if let Some(id) = j.listing_id {
            if let Some(l) = store::get_listing(&st.paths, &id) {
                out.push(hydrate(&st.paths, l));
            }
        }
    }
    Ok(out)
}

/// One media file found in a "关联素材文件夹" — classified image/video by ext.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    pub name: String,  // file name without directory
    pub stem: String,  // name without extension (for 商品名/货号 matching)
    pub path: String,  // absolute path
    pub ext: String,   // lowercase, no dot
    pub kind: String,  // "image" | "video"
}

const IMG_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp"];
const VID_EXTS: &[&str] = &["mp4", "mov", "mkv", "webm", "avi", "m4v"];

/// List the image/video files in a folder (non-recursive). No new deps/permissions —
/// plain std::fs; the user picks the folder via `pick_folder`.
#[tauri::command]
pub fn list_media_files(dir: String) -> Result<Vec<MediaFile>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("读取文件夹失败: {e}"))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.starts_with('.') {
            continue; // skip hidden / .DS_Store
        }
        let ext = path
            .extension()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let kind = if IMG_EXTS.contains(&ext.as_str()) {
            "image"
        } else if VID_EXTS.contains(&ext.as_str()) {
            "video"
        } else {
            continue;
        };
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        out.push(MediaFile {
            name,
            stem,
            path: path.to_string_lossy().to_string(),
            ext,
            kind: kind.to_string(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Read a local image file into a data URL (the webview can't read disk bytes).
/// Used to feed a matched product photo into ListingInput.base_photos. Capped to
/// keep the IPC payload sane.
#[tauri::command]
pub fn read_file_b64(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取失败: {e}"))?;
    if meta.len() > 20 * 1024 * 1024 {
        return Err("图片过大(>20MB),请压缩后再用".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
    let ext = std::path::Path::new(&path)
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "image/jpeg",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// WB 类目 / 特征字典 —— 供工作台「全部商品参数」编辑(发布全参数)。读侧,content 域。
// ─────────────────────────────────────────────────────────────────────────────

fn content_ctx(cfg: &AppConfig) -> WbCtx {
    WbCtx {
        token: cfg.wb_content_token.clone(),
        sandbox: cfg.wb_sandbox,
    }
}

/// Search WB subjects (categories) by free text — lets the user override the
/// AI-picked category before publish.
#[tauri::command]
pub async fn search_subjects(
    state: State<'_, Arc<AppState>>,
    name: String,
) -> Result<Vec<WbSubject>, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    let ctx = content_ctx(&cfg);
    crate::wb::categories::search_subjects(&st, &ctx, &name, 30)
        .await
        .map_err(|e| e.to_string())
}

/// Full characteristics dictionary for a subject (id/name/required/charcType/…),
/// with Chinese display names (`nameZh`) merged in from WB's `locale=zh` so the
/// editor can show 中文 · Русский. The zh fetch is best-effort.
#[tauri::command]
pub async fn subject_characteristics(
    state: State<'_, Arc<AppState>>,
    subject_id: i64,
) -> Result<Vec<WbCharacteristic>, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    let ctx = content_ctx(&cfg);
    // Fetch ru + zh concurrently (separate cache keys, no conflict) so the editor
    // opens faster than two sequential WB round-trips.
    let (ru_res, zh_res) = tokio::join!(
        get_characteristics(&st, &ctx, subject_id),
        crate::wb::categories::get_characteristics_locale(&st, &ctx, subject_id, "zh"),
    );
    let mut ru = ru_res.map_err(|e| e.to_string())?;
    // Best-effort Chinese names; on any failure the editor just shows Russian.
    let zh_map: std::collections::HashMap<i64, String> = match zh_res {
        Ok(zh) => zh.into_iter().map(|c| (c.charc_id, c.name)).collect(),
        Err(_) => std::collections::HashMap::new(),
    };
    for c in &mut ru {
        if let Some(z) = zh_map.get(&c.charc_id) {
            if !z.trim().is_empty() {
                c.name_zh = z.clone();
            }
        }
        // Human correction wins over WB's machine zh: WB's locale=zh mistranslates
        // a number of common attributes (корпус→"房屋", Питание→"食物",
        // Описание→"说明书", Баркод→"产品最小的出库单位"…). Override by the canonical
        // Russian name so the seller sees the right 中文. Display-only — publish uses
        // the Russian name + charc_id, so this never changes what's listed.
        if let Some(fix) = corrected_charc_zh(&c.name) {
            c.name_zh = fix.to_string();
        }
    }
    Ok(ru)
}

/// Correct the worst WB machine-translated Chinese characteristic names. Keyed by
/// the canonical Russian name (unit suffix like "(кг)"/"(см)"/"(Вт)" stripped, then
/// lowercased) so one entry covers every subject/category that uses the attribute.
fn corrected_charc_zh(ru_name: &str) -> Option<&'static str> {
    let base = ru_name.split('(').next().unwrap_or(ru_name).trim().to_lowercase();
    match base.as_str() {
        // — clear mistranslations —
        "материал корпуса" => Some("外壳/机身材料"),
        "питание" => Some("供电方式"),
        "описание" => Some("商品描述"),
        "баркод" => Some("条形码"),
        // — imprecise → clearer —
        "модель" => Some("型号"),
        "форма выпечки" => Some("烘焙形状"),
        "комплектация" => Some("包装清单/随附配件"),
        "вес с упаковкой" => Some("含包装重量（毛重）"),
        "вес без упаковки" => Some("不含包装重量（净重）"),
        _ => None,
    }
}

/// Update a draft's package dimensions (cm) + gross weight (kg) — editable at the
/// 复核 step. WB bills logistics/storage on these and re-measures at intake.
#[tauri::command]
pub fn update_dimensions(
    state: State<Arc<AppState>>,
    id: String,
    length: i64,
    width: i64,
    height: i64,
    weight: f64,
) -> Result<Listing, String> {
    let updated = store::update_listing(&state.paths, &id, |l| {
        l.length = length.max(0);
        l.width = width.max(0);
        l.height = height.max(0);
        l.weight = weight.max(0.0);
    })
    .ok_or("未找到该商品")?;
    Ok(hydrate(&state.paths, updated))
}

/// Predict the AI-filled characteristics for a draft (same logic the publish
/// pipeline runs), so the「全部商品参数」editor can pre-populate ~20 standard
/// values for the seller to review/tweak instead of showing an empty form.
/// Returns [{id, value}]; user-confirmed values on the listing take priority.
#[tauri::command]
pub async fn predict_characteristics(
    state: State<'_, Arc<AppState>>,
    id: String,
    subject_id: i64,
) -> Result<Vec<Value>, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    let ctx = content_ctx(&cfg);
    let listing = store::get_listing(&st.paths, &id).ok_or("未找到该商品")?;
    // Fall back to a minimal copy if the draft has no generated copy yet.
    let copy = listing.copy.clone().unwrap_or_else(|| crate::types::ProductCopy {
        title: listing.product_name.clone(),
        description: String::new(),
        bullets: vec![],
        brand: listing.brand.clone(),
        keywords: listing.keywords.clone(),
        category_hint: listing.subject_name.clone().unwrap_or_default(),
        image_prompt: None,
        title_zh: String::new(),
        description_zh: String::new(),
        bullets_zh: vec![],
    });
    let category = listing
        .subject_name
        .clone()
        .unwrap_or_else(|| copy.category_hint.clone());
    let charcs = get_characteristics(&st, &ctx, subject_id)
        .await
        .map_err(|e| e.to_string())?;
    let colors = get_colors(&st, &ctx).await.unwrap_or_default();
    let tnved = if !listing.tnved.is_empty() {
        Some(listing.tnved.clone())
    } else {
        get_tnved(&st, &ctx, subject_id, None).await.unwrap_or(None)
    };
    Ok(crate::wb::pipeline::build_characteristics(
        &st, &cfg, &listing, &copy, &category, &charcs, &colors, &tnved,
    )
    .await)
}

/// WB color directory (for the «цвет» characteristic dropdown).
#[tauri::command]
pub async fn wb_colors(state: State<'_, Arc<AppState>>) -> Result<Vec<WbColor>, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    let ctx = content_ctx(&cfg);
    get_colors(&st, &ctx).await.map_err(|e| e.to_string())
}

/// Resolve a TNVED (customs) code for a subject; optional search refines it.
#[tauri::command]
pub async fn wb_tnved(
    state: State<'_, Arc<AppState>>,
    subject_id: i64,
    search: Option<String>,
) -> Result<Option<String>, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    let ctx = content_ctx(&cfg);
    get_tnved(&st, &ctx, subject_id, search.as_deref())
        .await
        .map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// 商品管理面板：实时读取 WB 上的卡片 + 价格 + 库存，并允许设库存/改价/删卡。
// 读接口都是「一次性拉取」，绝不轮询（价格写接口才是硬限流的那个）。
// ─────────────────────────────────────────────────────────────────────────────

/// Per-data-type freshness + the live prices-domain cooldown, for the UI.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    products: db::MetaRow,
    prices: db::MetaRow,
    stocks: db::MetaRow,
    warehouses: db::MetaRow,
    /// Seconds until the prices domain can be synced again (0 = ready).
    prices_cooldown_remaining: i64,
    now_epoch: i64,
}

/// Everything the panel needs, read entirely from the local DB (instant).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManageView {
    cards: Vec<db::ManagedCard>,
    warehouses: Vec<Warehouse>,
    sync: SyncStatus,
    warehouse_id: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    ok: bool,
    count: usize,
    message: String,
    prices_cooldown_remaining: i64,
}

fn now_epoch() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Lock the cache DB, recovering from poison. The cache is disposable, so a
/// panic while a guard is held must NOT permanently brick the panel.
fn lock_db(st: &AppState) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
    st.db.lock().unwrap_or_else(|e| e.into_inner())
}

fn prices_cooldown(st: &AppState) -> i64 {
    (st.prices_cooldown_until.load(Ordering::Relaxed) - now_epoch()).max(0)
}

/// Cache namespace = environment + supplier id (JWT `oid`/`sid`/`id` claim,
/// accepted as number OR string). When it changes (sandbox↔live, or a different
/// seller), the cache is wiped so we never show one account's data under another.
fn account_key(cfg: &AppConfig) -> String {
    let env = if cfg.wb_sandbox { "sandbox" } else { "live" };
    // No token (or keychain read failed → empty): an unauthenticated namespace
    // that ensure_account treats as a no-op — never wipes a known account.
    if cfg.wb_content_token.is_empty() {
        return format!("{}:none", env);
    }
    let claims = cfg
        .wb_content_token
        .split('.')
        .nth(1)
        .and_then(|b| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(b).ok())
        .and_then(|by| serde_json::from_slice::<Value>(&by).ok());
    let id = claims.as_ref().and_then(|v| {
        ["oid", "sid", "id"].iter().find_map(|k| {
            v.get(*k).and_then(|x| {
                x.as_i64().map(|n| n.to_string()).or_else(|| x.as_str().map(|s| s.to_string()))
            })
        })
    });
    match id {
        Some(id) => format!("{}:{}", env, id),
        // Can't extract a supplier id → key by a hash of the token so two
        // different unidentifiable tokens NEVER share one cache namespace.
        None => format!("{}:h{}", env, token_hash(&cfg.wb_content_token)),
    }
}

/// Non-cryptographic short hash, only for namespacing distinct tokens.
fn token_hash(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:x}", h.finish())
}

/// Pull ALL cards via cursor pagination. Returns `(cards, truncated)` where
/// `truncated` = we hit the page cap with a still-full page (more cards exist
/// than we fetched). The caller must NOT treat a truncated result as a complete
/// snapshot, or cards beyond the cap would be wrongly deleted from the cache.
async fn fetch_all_cards(st: &AppState, ctx: &WbCtx) -> Result<(Vec<Value>, bool), String> {
    let mut raw: Vec<Value> = vec![];
    let mut cursor = json!({ "limit": 100 });
    const MAX_PAGES: u32 = 50; // up to 5000 cards before truncation
    let mut truncated = false;
    for page in 0..MAX_PAGES {
        let v = wb_fetch(
            st,
            ctx,
            WbReq::post("/content/v2/get/cards/list").body(json!({
                "settings": { "sort": { "ascending": false }, "filter": { "withPhoto": -1 }, "cursor": cursor }
            })),
        )
        .await
        .map_err(|e| e.to_string())?;
        let cards = v.get("cards").and_then(|c| c.as_array()).cloned().unwrap_or_default();
        let n = cards.len();
        let upd = v.pointer("/cursor/updatedAt").cloned();
        let last_nm = v.pointer("/cursor/nmID").cloned();
        raw.extend(cards);
        if n < 100 {
            break; // natural exhaustion → complete snapshot
        }
        if page + 1 == MAX_PAGES {
            truncated = true; // full page AND out of page budget → more remain
            break;
        }
        cursor = json!({ "limit": 100, "updatedAt": upd, "nmID": last_nm });
    }
    Ok((raw, truncated))
}

async fn fetch_rejected(st: &AppState, ctx: &WbCtx) -> Vec<String> {
    match list_card_errors(st, ctx).await {
        Ok(list) => list.into_iter().filter(|(_, e)| !e.is_empty()).map(|(vc, _)| vc).collect(),
        Err(_) => vec![],
    }
}

fn to_product_row(c: &Value) -> db::ProductRow {
    db::ProductRow {
        nm_id: c.get("nmID").and_then(|x| x.as_i64()).unwrap_or(0),
        vendor_code: s(c, "vendorCode"),
        title: s(c, "title"),
        brand: s(c, "brand"),
        subject_id: c.get("subjectID").and_then(|x| x.as_i64()).unwrap_or(0),
        subject_name: s(c, "subjectName"),
        photo: extract_photo(c),
        characteristics: c.get("characteristics").and_then(|x| x.as_array()).map(|a| a.len() as i64).unwrap_or(0),
        skus: extract_skus(c),
    }
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
        sandbox: cfg.wb_sandbox,
    };
    mp_list_warehouses(&st, &ctx).await.map_err(|e| e.to_string())
}

/// First-run wizard: result of a "测试连接" probe.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnTest {
    pub ok: bool,
    pub detail: String,
    #[serde(default)]
    pub warehouses: Vec<Warehouse>,
}

/// Validate an Aurixel key (GET /v1/models). Used by the first-run wizard.
#[tauri::command]
pub async fn test_aurixel(state: State<'_, Arc<AppState>>, key: String) -> Result<ConnTest, String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Ok(ConnTest { ok: false, detail: "请填写 Aurixel Key".into(), warehouses: vec![] });
    }
    let res = state
        .http
        .get("https://conduit-api.aurixel.ai/v1/models")
        .header("Authorization", format!("Bearer {}", key))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await;
    Ok(match res {
        Ok(r) if r.status().is_success() => {
            let n = r
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("data").and_then(|d| d.as_array()).map(|a| a.len()))
                .unwrap_or(0);
            ConnTest { ok: true, detail: format!("已连接 · 可用模型 {} 个", n), warehouses: vec![] }
        }
        Ok(r) => ConnTest { ok: false, detail: format!("Key 无效(HTTP {})", r.status().as_u16()), warehouses: vec![] },
        Err(e) => ConnTest { ok: false, detail: format!("连接失败:{}", e), warehouses: vec![] },
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AurixelBalance {
    pub usd: f64,
    pub rmb: f64,
}

/// Read the configured Aurixel key's balance (GET /v1/balance on the gateway).
#[tauri::command]
pub async fn aurixel_balance(state: State<'_, Arc<AppState>>) -> Result<AurixelBalance, String> {
    let cfg = get_config(&state.paths);
    let key = cfg.aurixel_api_key.trim().to_string();
    if key.is_empty() {
        return Err("未配置 Aurixel Key".into());
    }
    let r = state
        .http
        .get("https://conduit-api.aurixel.ai/v1/balance")
        .header("Authorization", format!("Bearer {}", key))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("连接失败:{}", e))?;
    if !r.status().is_success() {
        return Err(format!("余额查询失败 (HTTP {})", r.status().as_u16()));
    }
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    Ok(AurixelBalance {
        usd: v.get("cash_balance_usd").and_then(|x| x.as_f64()).unwrap_or(0.0),
        rmb: v.get("cash_balance_rmb").and_then(|x| x.as_f64()).unwrap_or(0.0),
    })
}

/// Validate a WB token + return the seller's FBS warehouses (feeds the wizard's
/// default-warehouse step). A working marketplace call implies a usable token.
#[tauri::command]
pub async fn test_wb(
    state: State<'_, Arc<AppState>>,
    token: String,
    sandbox: bool,
) -> Result<ConnTest, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Ok(ConnTest { ok: false, detail: "请填写 WB Token".into(), warehouses: vec![] });
    }
    let st = state.inner().clone();
    let ctx = WbCtx { token, sandbox };
    Ok(match mp_list_warehouses(&st, &ctx).await {
        Ok(whs) => ConnTest { ok: true, detail: format!("已连接 · {} 个仓库", whs.len()), warehouses: whs },
        Err(e) => {
            let msg = e.to_string();
            ConnTest {
                ok: false,
                detail: format!("Token 无效或权限不足:{}", msg.chars().take(80).collect::<String>()),
                warehouses: vec![],
            }
        }
    })
}

/// Read the whole panel from the LOCAL DB — instant, offline, no rate-limit
/// risk. Never touches WB. The frontend calls the sync_* commands to refresh.
#[tauri::command]
pub fn db_list_cards(
    state: State<Arc<AppState>>,
    warehouse_id: Option<i64>,
) -> Result<ManageView, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    // No token (or a transient keychain read error → empty): serve an empty view
    // and DON'T touch the cache, so an unauthenticated read can never wipe or leak
    // a known account's data.
    if cfg.wb_content_token.is_empty() {
        return Ok(ManageView {
            cards: vec![],
            warehouses: vec![],
            sync: SyncStatus {
                products: db::MetaRow::default(),
                prices: db::MetaRow::default(),
                stocks: db::MetaRow::default(),
                warehouses: db::MetaRow::default(),
                prices_cooldown_remaining: prices_cooldown(&st),
                now_epoch: now_epoch(),
            },
            warehouse_id,
        });
    }
    let key = account_key(&cfg);
    let conn = lock_db(&st);
    db::ensure_account(&conn, &key).map_err(|e| e.to_string())?;
    let prices_meta = db::get_meta(&conn, "prices");
    let prices_synced = prices_meta.last_sync_at > 0;
    let cards = db::get_managed_cards(&conn, warehouse_id, prices_synced).map_err(|e| e.to_string())?;
    let warehouses = db::get_warehouses(&conn).map_err(|e| e.to_string())?;
    let sync = SyncStatus {
        products: db::get_meta(&conn, "products"),
        prices: prices_meta,
        stocks: db::get_meta(&conn, "stocks"),
        warehouses: db::get_meta(&conn, "warehouses"),
        prices_cooldown_remaining: prices_cooldown(&st),
        now_epoch: now_epoch(),
    };
    Ok(ManageView { cards, warehouses, sync, warehouse_id })
}

/// Sync the seller's FBS warehouses (marketplace, 300/min — safe) → DB.
#[tauri::command]
pub async fn sync_warehouses(state: State<'_, Arc<AppState>>) -> Result<SyncResult, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    if cfg.wb_content_token.is_empty() {
        return Err("未配置 WB Token。".into());
    }
    let key = account_key(&cfg);
    {
        let conn = lock_db(&st);
        db::ensure_account(&conn, &key).map_err(|e| e.to_string())?;
    }
    let ctx = WbCtx { token: cfg.wb_content_token.clone(), sandbox: cfg.wb_sandbox };
    let whs = mp_list_warehouses(&st, &ctx).await.map_err(|e| e.to_string())?;
    let now = now_epoch();
    let n = {
        let mut conn = lock_db(&st);
        let n = db::upsert_warehouses(&mut conn, &whs, now).map_err(|e| e.to_string())?;
        db::set_meta(&conn, "warehouses", now, "ok", &format!("{} 个仓库", n), 0)
            .map_err(|e| e.to_string())?;
        n
    };
    Ok(SyncResult { ok: true, count: n, message: format!("已同步 {} 个仓库", n), prices_cooldown_remaining: 0 })
}

/// Sync product cards + rejection state (content, 100/min — safe) → DB.
#[tauri::command]
pub async fn sync_products(state: State<'_, Arc<AppState>>) -> Result<SyncResult, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    if cfg.wb_content_token.is_empty() {
        return Err("未配置 WB Token。".into());
    }
    let key = account_key(&cfg);
    {
        let conn = lock_db(&st);
        db::ensure_account(&conn, &key).map_err(|e| e.to_string())?;
    }
    let ctx = WbCtx { token: cfg.wb_content_token.clone(), sandbox: cfg.wb_sandbox };
    let (cards, truncated) = fetch_all_cards(&st, &ctx).await?;
    let rejected = fetch_rejected(&st, &ctx).await;
    let rows: Vec<db::ProductRow> = cards.iter().map(to_product_row).collect();
    let now = now_epoch();
    let n = {
        let mut conn = lock_db(&st);
        // full_snapshot = !truncated → only prune stale cards when we got them all
        let n = db::upsert_products(&mut conn, &rows, now, !truncated).map_err(|e| e.to_string())?;
        db::apply_rejections(&conn, &rejected).map_err(|e| e.to_string())?;
        let detail = if truncated {
            format!("{} 个商品(超 5000 已截断) · {} 被拒", n, rejected.len())
        } else {
            format!("{} 个商品 · {} 被拒", n, rejected.len())
        };
        db::set_meta(&conn, "products", now, "ok", &detail, 0).map_err(|e| e.to_string())?;
        n
    };
    let message = if truncated {
        format!("已同步 {} 个商品（超过 5000，已截断）", n)
    } else {
        format!("已同步 {} 个商品", n)
    };
    Ok(SyncResult { ok: true, count: n, message, prices_cooldown_remaining: 0 })
}

/// Sync FBS stock for one warehouse (marketplace, 300/min — safe) → DB.
#[tauri::command]
pub async fn sync_stocks(state: State<'_, Arc<AppState>>, warehouse_id: i64) -> Result<SyncResult, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    if cfg.wb_content_token.is_empty() {
        return Err("未配置 WB Token。".into());
    }
    if warehouse_id <= 0 {
        return Err("请先选择仓库。".into());
    }
    // skus come from already-synced products in the DB.
    let skus: Vec<String> = {
        let conn = lock_db(&st);
        let mut stmt = conn.prepare("SELECT skus FROM products").map_err(|e| e.to_string())?;
        let it = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        let mut set: std::collections::HashSet<String> = std::collections::HashSet::new();
        for j in it.flatten() {
            if let Ok(v) = serde_json::from_str::<Vec<String>>(&j) {
                for sk in v {
                    set.insert(sk);
                }
            }
        }
        set.into_iter().collect()
    };
    if skus.is_empty() {
        return Err("本地还没有商品，请先「同步商品」。".into());
    }
    let ctx = WbCtx { token: cfg.wb_content_token.clone(), sandbox: cfg.wb_sandbox };
    let map = read_stocks(&st, &ctx, warehouse_id, &skus).await.map_err(|e| e.to_string())?;
    let rows: Vec<(String, i64)> = map.into_iter().collect();
    let now = now_epoch();
    let n = {
        let mut conn = lock_db(&st);
        let n = db::upsert_stocks(&mut conn, warehouse_id, &rows, now).map_err(|e| e.to_string())?;
        db::set_meta(&conn, "stocks", now, "ok", &format!("仓库 {} · {} 条有货", warehouse_id, n), 0)
            .map_err(|e| e.to_string())?;
        n
    };
    Ok(SyncResult { ok: true, count: n, message: format!("已同步仓库 {} 的库存", warehouse_id), prices_cooldown_remaining: 0 })
}

/// Sync prices — the GUARDED one. Blocked while the prices domain is cooling
/// down (set from a prior 429's X-Ratelimit-Retry). One call, no polling.
#[tauri::command]
pub async fn sync_prices(state: State<'_, Arc<AppState>>) -> Result<SyncResult, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    if cfg.wb_content_token.is_empty() {
        return Err("未配置 WB Token。".into());
    }
    let remaining = prices_cooldown(&st);
    if remaining > 0 {
        return Err(format!("价格接口冷却中，约 {} 秒后可再同步价格。", remaining));
    }
    let key = account_key(&cfg);
    {
        let conn = lock_db(&st);
        db::ensure_account(&conn, &key).map_err(|e| e.to_string())?;
    }
    let ctx = WbCtx { token: prices_token(&cfg), sandbox: cfg.wb_sandbox };
    let map = match read_all_prices(&st, &ctx).await {
        Ok(m) => m,
        Err(e) => {
            // wb_fetch already recorded the cooldown on a 429.
            let cd = st.prices_cooldown_until.load(Ordering::Relaxed);
            let conn = lock_db(&st);
            let last = db::get_meta(&conn, "prices").last_sync_at;
            let _ = db::set_meta(&conn, "prices", last, "error", &e.to_string(), cd);
            return Err(e.to_string());
        }
    };
    let rows: Vec<db::PriceRow> = map
        .into_iter()
        .map(|(nm, p)| db::PriceRow {
            nm_id: nm,
            price: p.price,
            discounted_price: p.discounted_price,
            discount: p.discount,
            currency: p.currency,
        })
        .collect();
    let now = now_epoch();
    let n = {
        let mut conn = lock_db(&st);
        let n = db::upsert_prices(&mut conn, &rows, now).map_err(|e| e.to_string())?;
        db::set_meta(&conn, "prices", now, "ok", &format!("{} 个有价", n), 0).map_err(|e| e.to_string())?;
        n
    };
    Ok(SyncResult { ok: true, count: n, message: format!("已同步 {} 个价格", n), prices_cooldown_remaining: 0 })
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
    // Guard against a stale/foreign warehouse id after an env/seller switch.
    {
        let conn = lock_db(&st);
        if !db::warehouse_allows(&conn, warehouse_id).unwrap_or(true) {
            return Err("该仓库不在当前账号的仓库列表中（可能切换了环境/账号），请重新选择仓库。".into());
        }
    }
    let ctx = WbCtx {
        token: cfg.wb_content_token.clone(),
        sandbox: cfg.wb_sandbox,
    };
    let items: Vec<(String, i64)> = skus.iter().map(|sk| (sk.clone(), amount.max(0))).collect();
    set_stocks(&st, &ctx, warehouse_id, &items)
        .await
        .map_err(|e| e.to_string())?;
    {
        let conn = lock_db(&st);
        let _ = db::ensure_account(&conn, &account_key(&cfg));
        let _ = db::local_set_stock(&conn, warehouse_id, &skus, amount.max(0), now_epoch());
    }
    Ok(())
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
    // Fat-finger guard: a stray extra zero pushes a wildly wrong price to the
    // LIVE store before WB's ~1-min async apply. Reject the clearly-invalid here;
    // the UI also confirms the exact value. (WB's own ceiling is well under this.)
    if price <= 0 {
        return Err("价格必须大于 0。".into());
    }
    if price > 99_999_999 {
        return Err("价格异常过大（可能多打了 0），请确认后再提交。".into());
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
    {
        let conn = lock_db(&st);
        let _ = db::ensure_account(&conn, &account_key(&cfg));
        let _ = db::local_set_price(&conn, nm_id, price, d, now_epoch());
    }
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
    delete_cards(&st, &ctx, nm_ids.clone()).await.map_err(|e| e.to_string())?;
    {
        let conn = lock_db(&st);
        let _ = db::ensure_account(&conn, &account_key(&cfg));
        let _ = db::local_delete(&conn, &nm_ids);
    }
    Ok(())
}

// ── Image regeneration (per-image redo + main-first "generate the rest") ──

/// Re-render a SINGLE image of a draft listing with the same template, so a bad
/// roll doesn't force regenerating the whole set. `base_photos` come from the UI
/// (the seller's product photos) so img2img keeps the real product.
#[tauri::command]
pub async fn regenerate_image(
    state: State<'_, Arc<AppState>>,
    id: String,
    index: usize,
    base_photos: Vec<String>,
    custom_prompt: Option<String>,
) -> Result<Listing, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    let l = store::get_listing(&st.paths, &id).ok_or("未找到该商品")?;
    let copy = l.copy.clone().ok_or("缺少文案")?;
    let img = l.images.get(index).ok_or("无此图片")?;

    // Resolve the template: stored kind → same WB slot → any enabled → built-in.
    let templates = active_templates(&cfg);
    let tmpl = templates
        .get(&img.template_kind)
        .or_else(|| templates.templates.iter().find(|t| t.slot == img.kind && t.enabled))
        .or_else(|| templates.templates.iter().find(|t| t.enabled))
        .cloned()
        .unwrap_or_else(|| crate::templates::built_in_defaults().templates[0].clone());

    let ctx = build_ctx(&copy, &l.product_name, &l.keywords, custom_prompt.as_deref().unwrap_or(""));
    let bases: Vec<Vec<u8>> = base_photos.iter().filter_map(|s| decode_image_input(s)).collect();
    let base = if bases.is_empty() { None } else { Some(bases[index % bases.len()].as_slice()) };
    let new_img = render_one(
        &st, &cfg, &tmpl, &ctx, base, &copy.title, &copy.bullets, &l.product_name, &l.keywords, index,
    )
    .await
    .map_err(|e| e.to_string())?;

    let updated = store::update_listing(&st.paths, &id, |x| {
        if let Some(slot) = x.images.get_mut(index) {
            *slot = new_img.clone();
        }
        x.updated_at = crate::util::now_iso();
    })
    .unwrap_or(l);
    Ok(hydrate(&st.paths, updated))
}

/// Generate the REMAINING images after the main-first preview was approved.
#[tauri::command]
pub async fn generate_rest(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
    base_photos: Vec<String>,
    custom_prompt: Option<String>,
) -> Result<Listing, String> {
    let st = state.inner().clone();
    let cfg = get_config(&st.paths);
    let l = store::get_listing(&st.paths, &id).ok_or("未找到该商品")?;
    if !l.partial {
        return Ok(hydrate(&st.paths, l));
    }
    let copy = l.copy.clone().ok_or("缺少文案")?;
    let want = l.requested_images.max(1) as usize;
    let templates = active_templates(&cfg);
    let mut plan = templates.plan(want);
    if plan.is_empty() {
        plan = crate::templates::built_in_defaults().plan(want);
    }
    let ctx = build_ctx(&copy, &l.product_name, &l.keywords, custom_prompt.as_deref().unwrap_or(""));
    let bases: Vec<Vec<u8>> = base_photos.iter().filter_map(|s| decode_image_input(s)).collect();
    let start = l.images.len();

    let mut new_imgs: Vec<GeneratedImage> = vec![];
    for i in start..plan.len() {
        let tmpl = &plan[i];
        let _ = app.emit(
            "generate:progress",
            json!({ "stage": "generate", "ok": true, "message": format!("生成第 {}/{} 张（{}）…", i + 1, plan.len(), tmpl.label) }),
        );
        let base = if bases.is_empty() { None } else { Some(bases[i % bases.len()].as_slice()) };
        let img = render_one(
            &st, &cfg, tmpl, &ctx, base, &copy.title, &copy.bullets, &l.product_name, &l.keywords, i,
        )
        .await
        .map_err(|e| e.to_string())?;
        new_imgs.push(img);
    }

    let updated = store::update_listing(&st.paths, &id, |x| {
        x.images.extend(new_imgs.clone());
        x.partial = false;
        x.updated_at = crate::util::now_iso();
    })
    .unwrap_or(l);
    let hydrated = hydrate(&st.paths, updated);
    let _ = app.emit("generate:done", &hydrated);
    Ok(hydrated)
}
