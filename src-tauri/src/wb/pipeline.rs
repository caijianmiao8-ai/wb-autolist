#![allow(dead_code)]
//! Full listing pipeline (ported from src/lib/wb/pipeline.ts).
//! Without a content token it runs DRY-RUN: validation + banner files are real,
//! but no WB HTTP happens and a fake nmID is assigned.

use crate::ai::charcs::fill_characteristics;
use crate::config::{prices_token, AppConfig};
use crate::state::AppState;
use crate::types::{GeneratedImage, Listing, ListingStage, ProductCopy, StageLog};
use crate::util::{now_iso, original_price};
use crate::wb::barcode::generate_ean13;
use crate::wb::cards::{find_card_by_vendor_code, upload_cards, wait_for_card};
use crate::wb::categories::{get_characteristics, get_colors, get_tnved, resolve_subject};
use crate::wb::client::WbCtx;
use crate::wb::marketplace::set_stocks;
use crate::wb::media::{upload_media_bytes, upload_video_bytes};
use crate::wb::prices::upload_price_task;
use crate::wb::types::{WbCharacteristic, WbColor};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::HashSet;
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
    /// The vendorCode/sku actually used to create the card (may differ from the
    /// listing's if a brand-retry minted a -Rn code). Caller persists them so a
    /// later resume/stock targets the real card. None = unchanged.
    pub vendor_code: Option<String>,
    pub sku: Option<String>,
    pub dry_run: bool,
    pub sandbox: bool,
    pub logs: Vec<StageLog>,
    pub error: Option<String>,
}

fn env_name(sandbox: bool) -> &'static str {
    if sandbox {
        "沙盒"
    } else {
        "线上"
    }
}

/// Is `id` a valid warehouse for the CURRENT account? Guards auto-stock from
/// pushing to a stale/foreign warehouse after an env/seller switch. If no
/// warehouses have been synced yet we can't validate → allow (no regression).
fn warehouse_ok(state: &AppState, id: i64) -> bool {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    crate::db::warehouse_allows(&conn, id).unwrap_or(true)
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
                vendor_code: None,
                sku: None,
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
    // The keychain couldn't be read this run — a previously-saved token may exist
    // but be momentarily unreadable. Refuse rather than silently fall to dry-run
    // and publish nothing while the user thinks it's live.
    if cfg.kc_error {
        return Err(anyhow!(
            "钥匙串暂时不可用，已暂停上架以免误判为演示模式。请重试或重启应用。"
        ));
    }

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

    // ── Live-publish guards (real store ahead) ──
    // (a) half-generated main-first draft must not go live as a 1-photo card.
    if listing.partial {
        return Err(anyhow!("该商品只生成了主图，请先「继续生成其余图片」再上架。"));
    }
    // (b) environment must match the one the card was DRAFTED in (skip demo drafts
    //     which have no real env affinity) — a sandbox draft must not become a
    //     real live card after the user flips the Settings toggle.
    if !listing.dry_run && listing.sandbox != cfg.wb_sandbox {
        return Err(anyhow!(
            "此商品在{}创建，当前是{}环境。请在设置切回{}环境后再上架，以免发到错误的店铺。",
            env_name(listing.sandbox),
            env_name(cfg.wb_sandbox),
            env_name(listing.sandbox)
        ));
    }
    // (c) refuse to ship ANY synthetic placeholder to the live storefront — not
    // just the main photo. A gallery placeholder is a purple card with the product
    // NAME printed on it; shipping one puts obvious junk on the seller's listing.
    let placeholders: Vec<usize> = order_images(listing)
        .iter()
        .enumerate()
        .filter(|(_, i)| i.template_kind == "placeholder")
        .map(|(n, _)| n + 1)
        .collect();
    if !placeholders.is_empty() {
        return Err(anyhow!(
            "第 {} 张是占位图（图像服务当时失败，不是真实产品图）。请先重新生成这些图片再上架。",
            placeholders
                .iter()
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join("、")
        ));
    }

    // IDEMPOTENCY: if this listing already has a WB card, NEVER create a second
    // one. A repeat publish (double-click, crash-resume, retry after a flaky
    // media upload) re-submits price/stock for the existing nmID instead of
    // spawning a duplicate card in the seller's live store.
    if let Some(nm) = listing.nm_id {
        return resume_existing(state, listing, cfg, nm, logs, on).await;
    }

    let ctx = WbCtx {
        token: cfg.wb_content_token.clone(),
        sandbox: cfg.wb_sandbox,
    };

    // RECONCILE: a prior attempt may have created the card but lost the nmID
    // (poll timeout / network drop). Only worth a lookup when this looks like a
    // retry (a previous error is recorded). If the card already exists, resume it
    // instead of creating a duplicate in the seller's store.
    if listing.error.is_some() {
        if let Ok(Some(existing)) =
            find_card_by_vendor_code(state, &ctx, &listing.vendor_code).await
        {
            if existing.nm_id > 0 {
                log(
                    logs,
                    "creating",
                    true,
                    &format!("发现已存在的卡片 nmID={}，转为补图+定价，不重复建卡。", existing.nm_id),
                    on,
                );
                return resume_existing(state, listing, cfg, existing.nm_id, logs, on).await;
            }
        }
    }
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
        vendor_code: None,
        sku: None,
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
    // User-confirmed category (from the「全部商品参数」editor) wins; else AI-resolve.
    let subject = if let Some(sid) = listing.subject_id {
        crate::wb::types::WbSubject {
            subject_id: sid,
            subject_name: listing.subject_name.clone().unwrap_or_default(),
            parent_id: 0,
            parent_name: String::new(),
        }
    } else {
        resolve_subject(state, &ctx, &hint)
            .await?
            .ok_or_else(|| anyhow!("未能匹配 WB 类目（hint: {}）", copy.category_hint))?
    };
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

    // ── Step 2: characteristics (AI-filled) + colors + tnved ──
    let charcs = get_characteristics(state, &ctx, subject.subject_id).await?;
    let colors = get_colors(state, &ctx).await.unwrap_or_default();
    let tnved = if !listing.tnved.is_empty() {
        Some(listing.tnved.clone())
    } else {
        get_tnved(state, &ctx, subject.subject_id, None)
            .await
            .unwrap_or(None)
    };
    let mut characteristics =
        build_characteristics(state, cfg, listing, copy, &subject.subject_name, &charcs, &colors, &tnved)
            .await;
    // 用户在「全部商品参数」里填的值优先覆盖,AI 兜底其余。空 = 不变(真实发布不受影响)。
    if !listing.characteristics.is_empty() {
        use std::collections::HashSet;
        let mut seen: HashSet<i64> = HashSet::new();
        let mut merged: Vec<Value> = Vec::new();
        for uc in &listing.characteristics {
            if let Some(id) = uc.get("id").and_then(|v| v.as_i64()) {
                seen.insert(id);
            }
            merged.push(uc.clone());
        }
        for c in characteristics.into_iter() {
            let keep = c
                .get("id")
                .and_then(|v| v.as_i64())
                .map_or(true, |id| !seen.contains(&id));
            if keep {
                merged.push(c);
            }
        }
        characteristics = merged;
    }
    log(
        logs,
        "creating",
        true,
        &format!(
            "填充 {} 项特征（类目共 {} 项可选）{}",
            characteristics.len(),
            charcs.len(),
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

    // Real package dims from the listing (set in generate_listing from the user's
    // input or the seller's configured default). Fall back only for OLD records
    // created before the field existed (≤ 0). WB bills logistics/storage on these.
    let dim_l = if listing.length > 0 { listing.length } else { 20 };
    let dim_w = if listing.width > 0 { listing.width } else { 15 };
    let dim_h = if listing.height > 0 { listing.height } else { 5 };
    let dim_kg = if listing.weight > 0.0 { listing.weight } else { 0.3 };

    // Try the listing's brand first; if WB rejects it ("Бренд … не найден"),
    // retry once with the universally-accepted "Нет бренда" (fresh vendorCode).
    let mut brand_attempts: Vec<String> = vec![listing.brand.clone()];
    if listing.brand != "Нет бренда" {
        brand_attempts.push("Нет бренда".to_string());
    }

    let mut created: Option<crate::wb::types::WbCardListItem> = None;
    let mut used_sku: Option<String> = None;
    let mut used_vc: Option<String> = None;
    let mut last_err: Option<anyhow::Error> = None;
    for (i, brand) in brand_attempts.iter().enumerate() {
        let vendor_code = if i == 0 {
            listing.vendor_code.clone()
        } else {
            format!("{}-R{}", listing.vendor_code, i)
        };
        // Reuse the barcode minted at draft time for the first attempt (so a
        // retry never mints a second card); brand-retry uses a fresh one.
        let sku = if i == 0 && !listing.sku.is_empty() {
            listing.sku.clone()
        } else {
            generate_ean13()
        };
        let card = json!({
            "subjectID": subject.subject_id,
            "variants": [{
                "vendorCode": vendor_code,
                "title": copy.title,
                "description": copy.description,
                "brand": brand,
                "dimensions": { "length": dim_l, "width": dim_w, "height": dim_h, "weightBrutto": dim_kg },
                "characteristics": characteristics,
                "sizes": [{ "price": base, "skus": [sku.clone()] }]
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
                used_sku = Some(sku);
                used_vc = Some(vendor_code);
                break;
            }
            Err(e) => {
                let lower = e.to_string().to_lowercase();
                let brand_issue = lower.contains("бренд") || lower.contains("brand");
                if brand_issue && i + 1 < brand_attempts.len() {
                    last_err = Some(e);
                    continue;
                }
                // The card may actually have been created (poll timeout / a
                // transient read error inside the poll). Do a final lookup before
                // giving up, so we learn the nmID rather than orphaning a live card.
                if let Ok(Some(c)) = find_card_by_vendor_code(state, &ctx, &vendor_code).await {
                    if c.nm_id > 0 {
                        log(logs, "creating", true, &format!("超时后找回卡片 nmID={}", c.nm_id), on);
                        created = Some(c);
                        used_sku = Some(sku);
                        used_vc = Some(vendor_code);
                        break;
                    }
                }
                return Err(e);
            }
        }
    }
    let created = created.ok_or_else(|| last_err.unwrap_or_else(|| anyhow!("建卡失败")))?;
    result.nm_id = Some(created.nm_id);
    result.imt_id = Some(created.imt_id);
    // Persist the ACTUAL vendorCode/sku used so a later resume/stock targets the
    // real card (matters when a brand-retry minted a -Rn code).
    result.vendor_code = used_vc;
    result.sku = used_sku.clone();
    result.stage = ListingStage::Media;
    log(
        logs,
        "media",
        true,
        &format!("已创建 nmID={}, imtID={}", created.nm_id, created.imt_id),
        on,
    );

    // ── Step 5: media (byte upload, one per slot) ──
    // NON-FATAL after creation: the card already exists on WB, so a media error
    // must NOT propagate as Err (that path drops result.nm_id, orphaning a live
    // card the app can no longer see/price/trash). Record failures, keep going,
    // and surface them as a warning while preserving the nmID.
    let ordered = order_images(listing);
    let mut media_failures = 0u32;
    let mut first_media_err: Option<String> = None;
    for (i, img) in ordered.into_iter().enumerate() {
        // Slot bound to POSITION (idx+1), not a running counter — a failed earlier
        // image must NOT promote the next one to photo #1 (the search cover).
        let slot = (i + 1) as i64;
        let file = img.url.rsplit('/').next().unwrap_or(&img.url).to_string();
        let res = match std::fs::read(state.paths.images().join(&file)) {
            Ok(bytes) => upload_media_bytes(state, &ctx, created.nm_id, slot, bytes, &file).await,
            Err(e) => Err(anyhow!("读取图片失败 {}: {}", file, e)),
        };
        match res {
            Ok(_) => log(logs, "media", true, &format!("已上传第 {} 张图（{}）", slot, img.kind), on),
            Err(e) => {
                media_failures += 1;
                if first_media_err.is_none() {
                    first_media_err = Some(e.to_string());
                }
                log(logs, "media", false, &format!("第 {} 张图上传失败：{}", slot, e), on);
            }
        }
    }

    // ── Step 5b: video (Russian dub) — non-fatal, independent WB video lane ──
    if let Some(vp) = listing.video_ru.as_ref().filter(|p| !p.trim().is_empty()) {
        match std::fs::read(vp) {
            Ok(bytes) => {
                let fname = std::path::Path::new(vp)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "video.mp4".into());
                match upload_video_bytes(state, &ctx, created.nm_id, bytes, &fname).await {
                    Ok(_) => log(logs, "media", true, "已上传俄语配音视频", on),
                    Err(e) => log(logs, "media", false, &format!("视频上传失败：{}", e), on),
                }
            }
            Err(e) => log(logs, "media", false, &format!("读取视频失败 {}: {}", vp, e), on),
        }
    }

    // ── Step 6: price (submit once, no polling) ──
    // WB's discounts-prices API is rate-limited HARD (≈1 req/min per seller).
    // So we ONLY submit the price/discount task and let WB process it async —
    // polling here would instantly trip 429. Non-fatal: the card is already up.
    log(logs, "pricing", true, "提交价格/折扣任务…", on);
    result.stage = ListingStage::Live;
    match upload_price_task(
        state,
        &price_ctx,
        vec![json!({ "nmID": created.nm_id, "price": base, "discount": discount as i64 })],
    )
    .await
    {
        Ok(_) => {
            log(logs, "pricing", true, "价格/折扣已提交（WB 异步处理，约 1 分钟生效）", on);
            log(logs, "live", true, "上架完成（WB 审核后生效）", on);
        }
        Err(e) => {
            log(logs, "pricing", false, &format!("价格暂未提交：{}", e), on);
            log(
                logs,
                "live",
                true,
                &format!(
                    "卡片已创建 nmID={}（WB 审核后生效）。价格接口限流较严（约每分钟 1 次），可稍后在「上架记录」点「重试定价」补价格/折扣。",
                    created.nm_id
                ),
                on,
            );
        }
    }

    // ── Step 7: stock (FBS) — a card needs stock > 0 to be buyable. If the user
    // picked a default warehouse + quantity, set it now. Non-fatal: missing
    // marketplace scope / no warehouse just leaves it for the management panel.
    if cfg.auto_stock && cfg.default_warehouse_id > 0 && cfg.default_stock > 0 && !cfg.wb_sandbox {
        if let Some(sku) = &used_sku {
            if warehouse_ok(state, cfg.default_warehouse_id) {
                let mp_ctx = WbCtx {
                    token: cfg.wb_content_token.clone(),
                    sandbox: cfg.wb_sandbox,
                };
                match set_stocks(
                    state,
                    &mp_ctx,
                    cfg.default_warehouse_id,
                    &[(sku.clone(), cfg.default_stock)],
                )
                .await
                {
                    Ok(_) => log(
                        logs,
                        "live",
                        true,
                        &format!(
                            "已设库存 {} 件（仓库 {}）——商品在审核+定价后即可售。",
                            cfg.default_stock, cfg.default_warehouse_id
                        ),
                        on,
                    ),
                    Err(e) => log(
                        logs,
                        "live",
                        false,
                        &format!("库存未自动设置（可在「商品管理」补货）：{}", e),
                        on,
                    ),
                }
            } else {
                log(logs, "live", false, "默认仓库在当前环境/账号不存在，已跳过自动设库存。", on);
            }
        }
    }

    // Card exists (nmID preserved) but some photos didn't upload — surface it as
    // a warning rather than losing the card to an Err.
    if media_failures > 0 {
        let note = format!(
            "卡片已创建 nmID={}，但有 {} 张图未上传成功（{}）。可在「上架记录」删除后重做，或在 WB 后台补图。",
            created.nm_id,
            media_failures,
            first_media_err.unwrap_or_default()
        );
        log(logs, "live", false, &note, on);
        result.error = Some(note);
    }
    Ok(result)
}

/// Resume an already-created card: re-submit price (+ FBS stock) for its nmID
/// WITHOUT creating a new card. Used when a publish is repeated (double-click,
/// crash-resume, or retry after a partial failure) so the seller's store never
/// gets a duplicate listing.
async fn resume_existing(
    state: &AppState,
    listing: &Listing,
    cfg: &AppConfig,
    nm: i64,
    logs: &mut Vec<StageLog>,
    on: &Progress,
) -> Result<PublishResult> {
    let price_ctx = WbCtx {
        token: prices_token(cfg),
        sandbox: cfg.wb_sandbox,
    };
    let discount = listing.discount.clamp(0.0, 99.0).round();
    let base = original_price(listing.price, discount) as i64;
    let result = PublishResult {
        stage: ListingStage::Live,
        nm_id: Some(nm),
        imt_id: listing.imt_id,
        subject_id: listing.subject_id,
        subject_name: listing.subject_name.clone(),
        vendor_code: None,
        sku: None,
        dry_run: false,
        sandbox: cfg.wb_sandbox,
        logs: vec![],
        error: None,
    };
    log(
        logs,
        "creating",
        true,
        &format!("商品已存在（nmID={}），重试补图 + 重提价格，不重复建卡。", nm),
        on,
    );

    // Re-upload images to the existing card — this retries a card whose media
    // failed mid-publish (overwriting a slot with the same bytes is harmless).
    let ctx = WbCtx {
        token: cfg.wb_content_token.clone(),
        sandbox: cfg.wb_sandbox,
    };
    let ordered = order_images(listing);
    for (i, img) in ordered.into_iter().enumerate() {
        let slot = (i + 1) as i64; // position-bound (see main loop)
        let file = img.url.rsplit('/').next().unwrap_or(&img.url).to_string();
        match std::fs::read(state.paths.images().join(&file)) {
            Ok(bytes) => match upload_media_bytes(state, &ctx, nm, slot, bytes, &file).await {
                Ok(_) => log(logs, "media", true, &format!("已上传第 {} 张图（{}）", slot, img.kind), on),
                Err(e) => log(logs, "media", false, &format!("第 {} 张图上传失败：{}", slot, e), on),
            },
            Err(e) => log(logs, "media", false, &format!("读取图片失败 {}: {}", file, e), on),
        }
    }
    // Re-upload the Russian dub video too, if any (non-fatal).
    if let Some(vp) = listing.video_ru.as_ref().filter(|p| !p.trim().is_empty()) {
        if let Ok(bytes) = std::fs::read(vp) {
            let fname = std::path::Path::new(vp)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "video.mp4".into());
            match upload_video_bytes(state, &ctx, nm, bytes, &fname).await {
                Ok(_) => log(logs, "media", true, "已上传俄语配音视频", on),
                Err(e) => log(logs, "media", false, &format!("视频上传失败：{}", e), on),
            }
        }
    }
    match upload_price_task(
        state,
        &price_ctx,
        vec![json!({ "nmID": nm, "price": base, "discount": discount as i64 })],
    )
    .await
    {
        Ok(_) => log(logs, "live", true, "价格/折扣已重新提交（WB 异步处理）。", on),
        Err(e) => log(
            logs,
            "live",
            false,
            &format!("价格暂未提交（接口限流）：{}。可稍后在「上架记录」重试定价。", e),
            on,
        ),
    }

    // FBS stock for the resumed card (same opt-in guard as the main path; uses the
    // persisted sku, validated against the current account's synced warehouses).
    if cfg.auto_stock
        && cfg.default_warehouse_id > 0
        && cfg.default_stock > 0
        && !cfg.wb_sandbox
        && !listing.sku.is_empty()
    {
        if warehouse_ok(state, cfg.default_warehouse_id) {
            let mp_ctx = WbCtx { token: cfg.wb_content_token.clone(), sandbox: cfg.wb_sandbox };
            match set_stocks(state, &mp_ctx, cfg.default_warehouse_id, &[(listing.sku.clone(), cfg.default_stock)]).await {
                Ok(_) => log(logs, "live", true, &format!("已设库存 {} 件（仓库 {}）。", cfg.default_stock, cfg.default_warehouse_id), on),
                Err(e) => log(logs, "live", false, &format!("库存未自动设置（可在「商品管理」补货）：{}", e), on),
            }
        } else {
            log(logs, "live", false, "默认仓库在当前环境/账号不存在，已跳过自动设库存。", on);
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
        vendor_code: None,
        sku: None,
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

/// Fill the card's characteristics. WB rarely marks anything `required`, so we
/// take the required + popular (then a few more) and let the AI produce values;
/// колор/ТНВЭД get a deterministic fallback if the model skips them.
pub async fn build_characteristics(
    state: &AppState,
    cfg: &AppConfig,
    listing: &Listing,
    copy: &ProductCopy,
    category: &str,
    charcs: &[WbCharacteristic],
    colors: &[WbColor],
    tnved: &Option<String>,
) -> Vec<Value> {
    let is_color = |n: &str| n.contains("цвет");
    let is_tnved = |n: &str| n.contains("тнвэд") || n.contains("тн вэд");

    // candidates: required → popular → rest, deduped, capped — but skip
    // top-level/system/regulatory fields that must never be AI-guessed:
    //  · бренд/наименование/описание are set as top-level card fields;
    //  · НДС / штрихкод / ИКПУ / NTIN / ТРУ / код упаковки / артикул OZON /
    //    код производителя are tax/regulatory identifiers — a wrong value gets
    //    the whole card rejected, so we leave them empty for the seller.
    // Цвет и ТН ВЭД остаются в кандидатах — их заполняем детерминированно ниже.
    let is_system = |n: &str| {
        const SYS: &[&str] = &[
            "наименование",
            "описание",
            "бренд",
            "ставка ндс",
            "штрихкод",
            "баркод",
            "икпу",
            "ntin",
            "код тру",
            "код упаковки",
            "артикул ozon",
            "код производителя",
            "количество штук в товаре",
        ];
        SYS.iter().any(|s| n.contains(s))
    };

    let mut seen: HashSet<i64> = HashSet::new();
    let mut candidates: Vec<WbCharacteristic> = vec![];
    let push = |c: &WbCharacteristic, candidates: &mut Vec<WbCharacteristic>, seen: &mut HashSet<i64>| {
        let n = c.name.to_lowercase();
        if is_system(&n) {
            return;
        }
        if seen.insert(c.charc_id) {
            candidates.push(c.clone());
        }
    };
    for c in charcs.iter().filter(|c| c.required) {
        push(c, &mut candidates, &mut seen);
    }
    for c in charcs.iter().filter(|c| c.popular) {
        push(c, &mut candidates, &mut seen);
    }
    for c in charcs.iter() {
        if candidates.len() >= 60 {
            break;
        }
        push(c, &mut candidates, &mut seen);
    }

    // AI fills everything except цвет / ТН ВЭД (those come from WB directories).
    let ai_targets: Vec<WbCharacteristic> = candidates
        .iter()
        .filter(|c| {
            let n = c.name.to_lowercase();
            !is_color(&n) && !is_tnved(&n)
        })
        .cloned()
        .collect();
    let filled = fill_characteristics(
        &state.http,
        cfg,
        &listing.product_name,
        &copy.keywords,
        &copy.title,
        category,
        &ai_targets,
    )
    .await;

    let kw = &copy.keywords;
    let mut out: Vec<Value> = vec![];
    for c in &candidates {
        let name_lc = c.name.to_lowercase();
        if is_tnved(&name_lc) {
            if let Some(t) = tnved {
                out.push(json!({ "id": c.charc_id, "value": t }));
            }
        } else if is_color(&name_lc) {
            let col = colors
                .iter()
                .find(|col| kw.iter().any(|k| col.name.to_lowercase() == k.to_lowercase()))
                .map(|c| c.name.clone())
                .or_else(|| colors.first().map(|c| c.name.clone()));
            if let Some(col) = col {
                out.push(json!({ "id": c.charc_id, "value": [col] }));
            }
        } else if let Some(v) = filled.get(&c.charc_id) {
            out.push(json!({ "id": c.charc_id, "value": v }));
        }
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
