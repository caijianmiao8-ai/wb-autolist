#![allow(dead_code)]
//! Full listing pipeline (ported from src/lib/wb/pipeline.ts).
//! Without a content token it runs DRY-RUN: validation + banner files are real,
//! but no WB HTTP happens and a fake nmID is assigned.

use crate::config::{prices_token, AppConfig};
use crate::state::AppState;
use crate::types::{GeneratedImage, Listing, ListingStage, StageLog};
use crate::util::{now_iso, original_price};
use crate::wb::barcode::generate_ean13;
use crate::wb::cards::{upload_cards, wait_for_card};
use crate::wb::categories::{get_characteristics, get_colors, get_tnved, resolve_subject};
use crate::wb::client::WbCtx;
use crate::wb::media::upload_media_bytes;
use crate::wb::prices::{upload_price_task, wait_for_price_task};
use crate::wb::types::{WbCharacteristic, WbColor};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::time::Duration;

/// Progress sink: (stage, ok, message). Send+Sync so the publish future stays
/// Send for tauri::async_runtime::spawn.
pub type Progress = dyn Fn(&str, bool, &str) + Send + Sync;

pub struct PublishResult {
    pub stage: ListingStage,
    pub nm_id: Option<i64>,
    pub imt_id: Option<i64>,
    pub subject_id: Option<i64>,
    pub subject_name: Option<String>,
    pub dry_run: bool,
    pub sandbox: bool,
    pub logs: Vec<StageLog>,
    pub error: Option<String>,
}

fn log(logs: &mut Vec<StageLog>, stage: &str, ok: bool, msg: &str, on: &Progress) {
    logs.push(StageLog {
        ts: now_iso(),
        stage: stage.to_string(),
        ok,
        message: msg.to_string(),
        data: None,
    });
    on(stage, ok, msg);
}

pub async fn publish_listing(
    state: &AppState,
    listing: &Listing,
    cfg: &AppConfig,
    on: &Progress,
) -> PublishResult {
    let mut logs: Vec<StageLog> = vec![];
    let dry = std::env::var("WB_DRY_RUN").ok().as_deref() == Some("true")
        || cfg.wb_content_token.is_empty();
    match run_pipeline(state, listing, cfg, dry, &mut logs, on).await {
        Ok(mut r) => {
            r.logs = logs;
            r
        }
        Err(e) => {
            let msg = e.to_string();
            log(&mut logs, "error", false, &msg, on);
            PublishResult {
                stage: ListingStage::Error,
                nm_id: None,
                imt_id: None,
                subject_id: listing.subject_id,
                subject_name: listing.subject_name.clone(),
                dry_run: dry,
                sandbox: !dry && cfg.wb_sandbox,
                logs,
                error: Some(msg),
            }
        }
    }
}

async fn run_pipeline(
    state: &AppState,
    listing: &Listing,
    cfg: &AppConfig,
    dry: bool,
    logs: &mut Vec<StageLog>,
    on: &Progress,
) -> Result<PublishResult> {
    let copy = listing
        .copy
        .as_ref()
        .ok_or_else(|| anyhow!("缺少商品文案，请先生成内容。"))?;
    if listing.images.is_empty() {
        return Err(anyhow!("缺少商品图片，请先生成图片。"));
    }

    if dry {
        return Ok(dry_run_pipeline(listing, logs, on).await);
    }

    let ctx = WbCtx {
        token: cfg.wb_content_token.clone(),
        sandbox: cfg.wb_sandbox,
    };
    let price_ctx = WbCtx {
        token: prices_token(cfg),
        sandbox: cfg.wb_sandbox,
    };

    let mut result = PublishResult {
        stage: ListingStage::Creating,
        nm_id: None,
        imt_id: None,
        subject_id: None,
        subject_name: None,
        dry_run: false,
        sandbox: cfg.wb_sandbox,
        logs: vec![],
        error: None,
    };

    // ── Step 1: resolve subject ──
    log(
        logs,
        "creating",
        true,
        if cfg.wb_sandbox {
            "解析商品类目（沙盒）…"
        } else {
            "解析商品类目…"
        },
        on,
    );
    let hint = if !copy.category_hint.is_empty() {
        copy.category_hint.clone()
    } else {
        listing.product_name.clone()
    };
    let subject = resolve_subject(state, &ctx, &hint)
        .await?
        .ok_or_else(|| anyhow!("未能匹配 WB 类目（hint: {}）", copy.category_hint))?;
    result.subject_id = Some(subject.subject_id);
    result.subject_name = Some(subject.subject_name.clone());
    log(
        logs,
        "creating",
        true,
        &format!(
            "类目: {} (subjectID={})",
            subject.subject_name, subject.subject_id
        ),
        on,
    );

    // ── Step 2: characteristics + colors + tnved ──
    let charcs = get_characteristics(state, &ctx, subject.subject_id).await?;
    let required: Vec<WbCharacteristic> = charcs
        .into_iter()
        .filter(|c| c.required && c.charc_type != 0)
        .collect();
    let colors = get_colors(state, &ctx).await.unwrap_or_default();
    let tnved = get_tnved(state, &ctx, subject.subject_id, None)
        .await
        .unwrap_or(None);
    let characteristics = build_characteristics(&required, listing, &colors, &tnved);
    log(
        logs,
        "creating",
        true,
        &format!(
            "填充 {} 项特征（必填 {} 项）{}",
            characteristics.len(),
            required.len(),
            tnved
                .as_ref()
                .map(|t| format!(", TNVED={}", t))
                .unwrap_or_default()
        ),
        on,
    );

    // ── Step 3+4: create card + poll nmID, with a brand fallback ──
    let discount = listing.discount.clamp(0.0, 99.0).round();
    let base = original_price(listing.price, discount) as i64;

    // Try the listing's brand first; if WB rejects it ("Бренд … не найден"),
    // retry once with the universally-accepted "Нет бренда" (fresh vendorCode).
    let mut brand_attempts: Vec<String> = vec![listing.brand.clone()];
    if listing.brand != "Нет бренда" {
        brand_attempts.push("Нет бренда".to_string());
    }

    let mut created: Option<crate::wb::types::WbCardListItem> = None;
    let mut last_err: Option<anyhow::Error> = None;
    for (i, brand) in brand_attempts.iter().enumerate() {
        let vendor_code = if i == 0 {
            listing.vendor_code.clone()
        } else {
            format!("{}-R{}", listing.vendor_code, i)
        };
        let sku = generate_ean13();
        let card = json!({
            "subjectID": subject.subject_id,
            "variants": [{
                "vendorCode": vendor_code,
                "title": copy.title,
                "description": copy.description,
                "brand": brand,
                "dimensions": { "length": 20, "width": 15, "height": 5, "weightBrutto": 0.3 },
                "characteristics": characteristics,
                "sizes": [{ "price": base, "skus": [sku] }]
            }]
        });
        upload_cards(state, &ctx, vec![card]).await?;
        if i == 0 {
            log(logs, "creating", true, "卡片已提交，等待 WB 分配 nmID…", on);
        } else {
            log(
                logs,
                "creating",
                true,
                &format!("品牌「{}」被 WB 拒绝，改用「Нет бренда」重试…", listing.brand),
                on,
            );
        }
        match wait_for_card(state, &ctx, &vendor_code, |n| {
            on("creating", true, &format!("轮询 nmID… (#{})", n))
        })
        .await
        {
            Ok(c) => {
                created = Some(c);
                break;
            }
            Err(e) => {
                let lower = e.to_string().to_lowercase();
                let brand_issue = lower.contains("бренд") || lower.contains("brand");
                if brand_issue && i + 1 < brand_attempts.len() {
                    last_err = Some(e);
                    continue;
                }
                return Err(e);
            }
        }
    }
    let created = created.ok_or_else(|| last_err.unwrap_or_else(|| anyhow!("建卡失败")))?;
    result.nm_id = Some(created.nm_id);
    result.imt_id = Some(created.imt_id);
    result.stage = ListingStage::Media;
    log(
        logs,
        "media",
        true,
        &format!("已创建 nmID={}, imtID={}", created.nm_id, created.imt_id),
        on,
    );

    // ── Step 5: media (byte upload, one per slot) ──
    let ordered = order_images(listing);
    let mut slot = 1i64;
    for img in ordered {
        let file = img.url.rsplit('/').next().unwrap_or(&img.url).to_string();
        let bytes = std::fs::read(state.paths.images().join(&file))
            .map_err(|e| anyhow!("读取图片失败 {}: {}", file, e))?;
        upload_media_bytes(state, &ctx, created.nm_id, slot, bytes, &file).await?;
        log(
            logs,
            "media",
            true,
            &format!("已上传第 {} 张图（{}）", slot, img.kind),
            on,
        );
        slot += 1;
    }

    // ── Step 6: price (best-effort, non-fatal) ──
    // Card + media already succeeded. Pricing goes through a SEPARATE WB
    // subsystem (discounts-prices) that often doesn't yet know a brand-new nmID,
    // so the task can time out — that's expected, not a listing failure. Mark
    // the card live; the user can re-apply pricing later (retry_pricing).
    log(logs, "pricing", true, "提交价格任务…", on);
    let pricing = async {
        let upload_id = upload_price_task(
            state,
            &price_ctx,
            vec![json!({ "nmID": created.nm_id, "price": base, "discount": discount as i64 })],
        )
        .await?;
        // short wait during publish — a brand-new nmID usually isn't priceable
        // yet; the user re-applies pricing later (retry_pricing, 3-min wait).
        wait_for_price_task(state, &price_ctx, upload_id, 25).await
    }
    .await;

    result.stage = ListingStage::Live;
    match pricing {
        Ok((status, success, total)) if status == 3 && success >= total => {
            log(
                logs,
                "pricing",
                true,
                &format!("价格任务 status={} ({}/{})", status, success, total),
                on,
            );
            log(logs, "live", true, "上架完成（WB 审核后生效）", on);
        }
        Ok((status, success, total)) => {
            log(
                logs,
                "pricing",
                false,
                &format!("折扣暂未生效 status={} ({}/{})", status, success, total),
                on,
            );
            log(
                logs,
                "live",
                true,
                &format!(
                    "卡片已创建 nmID={}（WB 审核后生效）。折扣暂未生效，可稍后在「上架记录」点「重试定价」。",
                    created.nm_id
                ),
                on,
            );
        }
        Err(e) => {
            log(logs, "pricing", false, &format!("折扣暂未生效（{}）", e), on);
            log(
                logs,
                "live",
                true,
                &format!(
                    "卡片已创建 nmID={}（WB 审核后生效）。新卡片通常要先通过 WB 审核才能定价，请稍后在「上架记录」点「重试定价」补上价格/折扣。",
                    created.nm_id
                ),
                on,
            );
        }
    }
    Ok(result)
}

async fn dry_run_pipeline(
    listing: &Listing,
    logs: &mut Vec<StageLog>,
    on: &Progress,
) -> PublishResult {
    let mut result = PublishResult {
        stage: ListingStage::Queued,
        nm_id: None,
        imt_id: None,
        subject_id: None,
        subject_name: listing.copy.as_ref().map(|c| c.category_hint.clone()),
        dry_run: true,
        sandbox: false,
        logs: vec![],
        error: None,
    };
    log(logs, "creating", true, "【演示模式】校验卡片字段…", on);
    let problems = validate_listing(listing);
    if !problems.is_empty() {
        result.stage = ListingStage::Error;
        result.error = Some(problems.join("; "));
        log(logs, "error", false, result.error.as_ref().unwrap(), on);
        return result;
    }
    log(
        logs,
        "creating",
        true,
        &format!(
            "【演示】类目 hint: {}",
            listing
                .copy
                .as_ref()
                .map(|c| c.category_hint.clone())
                .unwrap_or_default()
        ),
        on,
    );
    tokio::time::sleep(Duration::from_millis(600)).await;
    let hex: String = listing.id.chars().filter(|c| c.is_ascii_hexdigit()).take(6).collect();
    let n = i64::from_str_radix(if hex.is_empty() { "0" } else { &hex }, 16).unwrap_or(0);
    let fake_nm = 200_000_000 + (n % 9_000_000);
    result.nm_id = Some(fake_nm);
    result.imt_id = Some(fake_nm + 1);
    log(logs, "media", true, &format!("【演示】已分配 nmID={}", fake_nm), on);
    tokio::time::sleep(Duration::from_millis(400)).await;
    for i in 0..listing.images.len() {
        log(logs, "media", true, &format!("【演示】上传第 {} 张图", i + 1), on);
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    log(
        logs,
        "pricing",
        true,
        &format!(
            "【演示】价格 {}₽ / 折扣 {}%",
            listing.price as i64, listing.discount as i64
        ),
        on,
    );
    result.stage = ListingStage::Live;
    log(logs, "live", true, "演示完成：流程已跑通，未真实上架。", on);
    result
}

fn validate_listing(listing: &Listing) -> Vec<String> {
    let mut p = vec![];
    let copy = listing.copy.as_ref();
    if copy.map(|c| c.title.is_empty()).unwrap_or(true) {
        p.push("缺少标题".to_string());
    }
    if copy.map(|c| c.title.chars().count() > 60).unwrap_or(false) {
        p.push("标题超过 60 字符".to_string());
    }
    if copy.map(|c| c.description.is_empty()).unwrap_or(true) {
        p.push("缺少描述".to_string());
    }
    if listing.images.is_empty() {
        p.push("缺少图片".to_string());
    }
    if listing.vendor_code.is_empty() {
        p.push("缺少 vendorCode".to_string());
    }
    if !(listing.price > 0.0) {
        p.push("价格必须 > 0".to_string());
    }
    p
}

/// Best-effort fill of required characteristics from copy + directories.
fn build_characteristics(
    required: &[WbCharacteristic],
    listing: &Listing,
    colors: &[WbColor],
    tnved: &Option<String>,
) -> Vec<Value> {
    let kw: Vec<String> = listing
        .copy
        .as_ref()
        .map(|c| c.keywords.clone())
        .unwrap_or_default();
    let mut out = vec![];
    for c in required {
        let name_lc = c.name.to_lowercase();
        if name_lc.contains("цвет") {
            let matched = colors
                .iter()
                .find(|col| kw.iter().any(|k| col.name.to_lowercase() == k.to_lowercase()))
                .map(|c| c.name.clone())
                .or_else(|| colors.first().map(|c| c.name.clone()))
                .unwrap_or_else(|| "разноцветный".to_string());
            out.push(json!({ "id": c.charc_id, "value": [matched] }));
            continue;
        }
        if name_lc.contains("тнвэд") || name_lc.contains("тн вэд") {
            if let Some(t) = tnved {
                out.push(json!({ "id": c.charc_id, "value": t }));
            }
            continue;
        }
        if c.charc_type == 4 {
            out.push(json!({ "id": c.charc_id, "value": [1] }));
            continue;
        }
        let val = kw
            .first()
            .cloned()
            .or_else(|| {
                listing
                    .copy
                    .as_ref()
                    .map(|c| c.brand.clone())
                    .filter(|b| !b.is_empty())
            })
            .unwrap_or_else(|| listing.product_name.clone());
        out.push(json!({ "id": c.charc_id, "value": [val] }));
    }
    out
}

fn order_images(listing: &Listing) -> Vec<&GeneratedImage> {
    let rank = |k: &str| match k {
        "main" => 0,
        "promo" => 1,
        _ => 2,
    };
    let mut v: Vec<&GeneratedImage> = listing.images.iter().collect();
    v.sort_by_key(|i| rank(&i.kind));
    v
}
