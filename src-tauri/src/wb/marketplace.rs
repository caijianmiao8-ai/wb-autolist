#![allow(dead_code)]
//! WB Marketplace (FBS) API: seller warehouses + stock read/set.
//!
//! Hosts on marketplace-api.wildberries.ru. Auth = the same raw WB token (the
//! token must include the «Маркетплейс» scope). The category limit is generous
//! (~300 req/min), and stock changes apply immediately — a positive amount on a
//! seller (FBS) warehouse is what makes a card buyable on the site.
//!
//! `sku` everywhere here is the product **barcode** (the EAN string stored in a
//! card's `sizes[].skus[]`), NOT the nmID or chrtID.

use crate::state::AppState;
use crate::wb::client::{wb_fetch, Host, WbCtx, WbReq};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

/// A seller's FBS warehouse. `id` is the `warehouseId` used in stock paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Warehouse {
    pub id: i64,
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "officeId")]
    pub office_id: i64,
    #[serde(default, rename = "cargoType")]
    pub cargo_type: i64,
    #[serde(default, rename = "deliveryType")]
    pub delivery_type: i64,
}

/// GET /api/v3/warehouses — the seller's own FBS warehouses.
pub async fn list_warehouses(state: &AppState, ctx: &WbCtx) -> Result<Vec<Warehouse>> {
    let v = wb_fetch(
        state,
        ctx,
        WbReq::get("/api/v3/warehouses")
            .on(Host::Marketplace)
            .timeout(20_000),
    )
    .await?;
    // Response is a top-level array.
    let list: Vec<Warehouse> = serde_json::from_value(v).unwrap_or_default();
    Ok(list)
}

/// POST /api/v3/stocks/{warehouseId} — read current FBS stock for the given
/// barcodes. Returns sku(barcode) → amount. Missing skus simply don't appear.
/// WB caps the request at 1000 skus, so we chunk.
pub async fn read_stocks(
    state: &AppState,
    ctx: &WbCtx,
    warehouse_id: i64,
    skus: &[String],
) -> Result<HashMap<String, i64>> {
    let mut out: HashMap<String, i64> = HashMap::new();
    for chunk in skus.chunks(1000) {
        if chunk.is_empty() {
            continue;
        }
        let v = wb_fetch(
            state,
            ctx,
            WbReq::post(&format!("/api/v3/stocks/{}", warehouse_id))
                .on(Host::Marketplace)
                .body(json!({ "skus": chunk }))
                .timeout(20_000),
        )
        .await?;
        if let Some(arr) = v.get("stocks").and_then(|s| s.as_array()) {
            for s in arr {
                if let (Some(sku), Some(amount)) = (
                    s.get("sku").and_then(|x| x.as_str()),
                    s.get("amount").and_then(|x| x.as_i64()),
                ) {
                    out.insert(sku.to_string(), amount);
                }
            }
        }
    }
    Ok(out)
}

/// PUT /api/v3/stocks/{warehouseId} — set absolute FBS stock for barcodes.
/// `amount = 0` removes the item from sale (effectively unlists / 下架).
/// Returns 204 on success.
pub async fn set_stocks(
    state: &AppState,
    ctx: &WbCtx,
    warehouse_id: i64,
    items: &[(String, i64)],
) -> Result<()> {
    if items.is_empty() {
        return Ok(());
    }
    let stocks: Vec<_> = items
        .iter()
        .map(|(sku, amount)| json!({ "sku": sku, "amount": amount.max(&0) }))
        .collect();
    for chunk in stocks.chunks(1000) {
        wb_fetch(
            state,
            ctx,
            WbReq::put(&format!("/api/v3/stocks/{}", warehouse_id))
                .on(Host::Marketplace)
                .body(json!({ "stocks": chunk }))
                .timeout(20_000),
        )
        .await?;
    }
    Ok(())
}
