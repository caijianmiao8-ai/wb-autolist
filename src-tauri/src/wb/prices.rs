#![allow(dead_code)]
//! Price/discount task submit + poll (ported from src/lib/wb/prices.ts).

use crate::state::AppState;
use crate::wb::client::{wb_fetch, Host, WbCtx, WbReq};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Current price/discount for one nmID (from list/goods/filter). `price` is the
/// seller's pre-discount base; `discounted_price` is roughly what the buyer pays
/// before WB's own promos.
#[derive(Debug, Clone)]
pub struct PriceInfo {
    pub price: i64,
    pub discounted_price: i64,
    pub discount: i64,
    pub currency: String,
}

/// Read ALL current prices via GET /api/v2/list/goods/filter (limit=1000,
/// paginate by offset until an empty page). Maps nmID → PriceInfo.
///
/// The prices READ category is lenient (~10 req/6s), so a one-shot full load is
/// safe — but we still never poll it in a loop. A safety cap of 20 pages
/// (20k goods) bounds the worst case; we log nothing here, the caller decides.
pub async fn read_all_prices(state: &AppState, ctx: &WbCtx) -> Result<HashMap<i64, PriceInfo>> {
    let mut map: HashMap<i64, PriceInfo> = HashMap::new();
    let limit = 1000;
    for page in 0..20u64 {
        let offset = page * limit;
        let v = wb_fetch(
            state,
            ctx,
            WbReq::get("/api/v2/list/goods/filter")
                .on(Host::Prices)
                .q("limit", limit)
                .q("offset", offset)
                .timeout(30_000),
        )
        .await?;
        let goods = v
            .pointer("/data/listGoods")
            .and_then(|g| g.as_array())
            .cloned()
            .unwrap_or_default();
        if goods.is_empty() {
            break;
        }
        let n = goods.len();
        for g in &goods {
            if let Some((nm, info)) = parse_good(g) {
                map.insert(nm, info);
            }
        }
        if (n as u64) < limit {
            break;
        }
    }
    Ok(map)
}

fn parse_good(g: &Value) -> Option<(i64, PriceInfo)> {
    let nm = g.get("nmID").and_then(|x| x.as_i64())?;
    let currency = g
        .get("currencyIsoCode4217")
        .and_then(|x| x.as_str())
        .unwrap_or("RUB")
        .to_string();
    let discount = g.get("discount").and_then(|x| x.as_i64()).unwrap_or(0);
    // Take the first size with a non-zero price (single-size cards have one).
    let size = g
        .get("sizes")
        .and_then(|s| s.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|s| s.get("price").and_then(|p| p.as_i64()).unwrap_or(0) > 0)
                .or_else(|| arr.first())
        });
    let price = size
        .and_then(|s| s.get("price").and_then(|p| p.as_i64()))
        .unwrap_or(0);
    let discounted_price = size
        .and_then(|s| s.get("discountedPrice").and_then(|p| p.as_f64()))
        .map(|f| f.round() as i64)
        .unwrap_or(price);
    Some((
        nm,
        PriceInfo {
            price,
            discounted_price,
            discount,
            currency,
        },
    ))
}

/// Queue a price/discount task. Returns the uploadID for polling.
/// `items` are `{nmID, price, discount}` objects.
pub async fn upload_price_task(state: &AppState, ctx: &WbCtx, items: Vec<Value>) -> Result<i64> {
    let v = wb_fetch(
        state,
        ctx,
        WbReq::post("/api/v2/upload/task")
            .on(Host::Prices)
            .body(json!({ "data": items }))
            .timeout(30_000),
    )
    .await?;
    v.pointer("/data/id")
        .and_then(|x| x.as_i64())
        .or_else(|| v.pointer("/data/uploadID").and_then(|x| x.as_i64()))
        .ok_or_else(|| anyhow!("价格任务未返回 uploadID"))
}

/// Poll a price task. status 3 = done; 5 = partial. Returns (status, success, total).
/// `timeout_secs` is short during publish (a brand-new card usually can't be
/// priced yet) and long for an explicit retry.
pub async fn wait_for_price_task(
    state: &AppState,
    ctx: &WbCtx,
    upload_id: i64,
    timeout_secs: u64,
) -> Result<(i64, i64, i64)> {
    let timeout = Duration::from_secs(timeout_secs);
    let interval = Duration::from_secs(8);
    let start = Instant::now();

    while start.elapsed() < timeout {
        if let Some(d) = read_task(state, ctx, upload_id).await {
            let status = d.get("status").and_then(|x| x.as_i64()).unwrap_or(-1);
            if status == 3 || status == 5 {
                let success = d
                    .get("successGoodsNumber")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0);
                let total = d
                    .get("overAllGoodsNumber")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0);
                return Ok((status, success, total));
            }
        }
        tokio::time::sleep(interval).await;
    }
    Err(anyhow!("价格任务处理超时，请稍后在 WB 后台确认价格状态。"))
}

async fn read_task(state: &AppState, ctx: &WbCtx, upload_id: i64) -> Option<Value> {
    // buffer first (in-flight), then history (final)
    for path in ["/api/v2/buffer/tasks", "/api/v2/history/tasks"] {
        if let Ok(v) = wb_fetch(
            state,
            ctx,
            WbReq::get(path).on(Host::Prices).q("uploadID", upload_id),
        )
        .await
        {
            let d = match v.get("data") {
                Some(Value::Array(a)) => a.first().cloned(),
                Some(o) => Some(o.clone()),
                None => None,
            };
            if let Some(d) = d {
                if d.get("status").map(|s| !s.is_null()).unwrap_or(false) {
                    return Some(d);
                }
            }
        }
    }
    None
}
