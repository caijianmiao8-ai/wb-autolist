#![allow(dead_code)]
//! Price/discount task submit + poll (ported from src/lib/wb/prices.ts).

use crate::state::AppState;
use crate::wb::client::{wb_fetch, Host, WbCtx, WbReq};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

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
