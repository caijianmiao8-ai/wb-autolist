#![allow(dead_code)]
//! Card create + poll (ported from src/lib/wb/cards.ts).

use crate::state::AppState;
use crate::wb::client::{wb_fetch, WbCtx, WbReq};
use crate::wb::types::WbCardListItem;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// Submit new cards. Body must be a top-level ARRAY. A 200 only means "queued";
/// the nmID is assigned asynchronously.
pub async fn upload_cards(state: &AppState, ctx: &WbCtx, items: Vec<Value>) -> Result<()> {
    wb_fetch(
        state,
        ctx,
        WbReq::post("/content/v2/cards/upload")
            .body(Value::Array(items))
            .timeout(40_000),
    )
    .await?;
    Ok(())
}

/// Look up a card by the seller's vendorCode (textSearch).
pub async fn find_card_by_vendor_code(
    state: &AppState,
    ctx: &WbCtx,
    vendor_code: &str,
) -> Result<Option<WbCardListItem>> {
    let v = wb_fetch(
        state,
        ctx,
        WbReq::post("/content/v2/get/cards/list").body(json!({
            "settings": {
                "sort": { "ascending": false },
                "filter": { "withPhoto": -1, "textSearch": vendor_code },
                "cursor": { "limit": 100 }
            }
        })),
    )
    .await?;
    let cards: Vec<WbCardListItem> = v
        .get("cards")
        .and_then(|c| serde_json::from_value(c.clone()).ok())
        .unwrap_or_default();
    Ok(cards.into_iter().find(|c| c.vendor_code == vendor_code))
}

/// Poll get/cards/list until the card (with nmID) appears, or timeout.
pub async fn wait_for_card<F: Fn(u64)>(
    state: &AppState,
    ctx: &WbCtx,
    vendor_code: &str,
    on_tick: F,
) -> Result<WbCardListItem> {
    let timeout = Duration::from_secs(6 * 60);
    let interval = Duration::from_secs(12);
    let start = Instant::now();
    let mut tick = 0u64;

    while start.elapsed() < timeout {
        tick += 1;
        on_tick(tick);
        if let Some(card) = find_card_by_vendor_code(state, ctx, vendor_code).await? {
            if card.nm_id > 0 {
                return Ok(card);
            }
        }
        // check error list every other tick (fail fast if WB rejected the card)
        if tick % 2 == 0 {
            if let Some(errs) = find_card_error(state, ctx, vendor_code).await {
                if !errs.is_empty() {
                    return Err(anyhow!("WB 拒绝了卡片 {}: {}", vendor_code, errs.join("; ")));
                }
            }
        }
        tokio::time::sleep(interval).await;
    }
    if let Some(errs) = find_card_error(state, ctx, vendor_code).await {
        if !errs.is_empty() {
            return Err(anyhow!("WB 拒绝了卡片 {}: {}", vendor_code, errs.join("; ")));
        }
    }
    Err(anyhow!(
        "等待 nmID 超时（6 分钟）。WB 同步可能延迟，可稍后在历史中重试挂图/定价。"
    ))
}

/// Returns (vendorCode, [error messages]) pairs from cards/error/list.
pub async fn list_card_errors(state: &AppState, ctx: &WbCtx) -> Result<Vec<(String, Vec<String>)>> {
    let v = wb_fetch(
        state,
        ctx,
        WbReq::post("/content/v2/cards/error/list")
            .q("locale", "ru")
            .body(json!({})),
    )
    .await?;
    let mut out = vec![];
    if let Some(items) = v.pointer("/data/items").and_then(|x| x.as_array()) {
        for item in items {
            if let Some(errs) = item.get("errors").and_then(|e| e.as_object()) {
                for (vc, msgs) in errs {
                    let list: Vec<String> = msgs
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|m| m.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default();
                    out.push((vc.clone(), list));
                }
            }
        }
    }
    Ok(out)
}

async fn find_card_error(state: &AppState, ctx: &WbCtx, vc: &str) -> Option<Vec<String>> {
    match list_card_errors(state, ctx).await {
        Ok(list) => list.into_iter().find(|(v, _)| v == vc).map(|(_, e)| e),
        Err(_) => None,
    }
}
