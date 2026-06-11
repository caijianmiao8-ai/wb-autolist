#![allow(dead_code)]
//! Tauri command layer — the former Next.js /api/* routes, now invoked from the
//! static frontend via `@tauri-apps/api`. Image urls are hydrated to data URLs
//! on the way out (the webview can't hit a server).

use crate::ai::assets::to_data_url;
use crate::ai::excel::parse_excel;
use crate::ai::organize::organize_rows;
use crate::config::{get_config, redact_config, save_config};
use crate::generate::generate_listing;
use crate::paths::Paths;
use crate::queue::{self, BatchJob};
use crate::state::AppState;
use crate::store;
use crate::types::{Listing, ListingInput};
use crate::wb::cards::delete_cards;
use crate::wb::client::WbCtx;
use crate::wb::pipeline::publish_listing;
use serde_json::{json, Value};
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
