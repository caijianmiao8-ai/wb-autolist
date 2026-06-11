//! Real end-to-end smoke test of the Rust backend: generate (real Aurixel copy
//! + image + resvg banner) then publish to the WB sandbox. Driven by env vars
//! (loaded from .env.local in the run command). Not run by default `cargo test`
//! unless the secrets are present.
#![cfg(test)]

use crate::config::get_config;
use crate::generate::generate_listing;
use crate::state::AppState;
use crate::types::{ListingInput, ListingStage};
use crate::wb::cards::delete_cards;
use crate::wb::client::{wb_fetch, WbCtx, WbReq};
use crate::wb::pipeline::publish_listing;
use serde_json::json;
use std::time::Instant;

/// Standalone (no network): render the new infographic-style promo over a base
/// product photo and write it to /tmp for visual review.
#[test]
fn infographic_design() {
    let base = match std::fs::read("/tmp/imgcmp/ours_main.png") {
        Ok(b) => b,
        Err(_) => {
            eprintln!("⚠ 缺少底图 /tmp/imgcmp/ours_main.png — 跳过");
            return;
        }
    };
    let features = vec![
        "Для зала и улицы".to_string(),
        "Износостойкий".to_string(),
        "Размер 7".to_string(),
    ];
    let out = crate::ai::banner::compose_infographic(
        &base,
        "Баскетбольный мяч для улицы и зала",
        &features,
        Some("ХИТ"),
        1080,
        1440,
    )
    .expect("compose_infographic");
    std::fs::write("/tmp/imgcmp/infographic.jpg", &out).expect("write");
    eprintln!("wrote /tmp/imgcmp/infographic.jpg ({} KB)", out.len() / 1024);
}

/// Integrated img2img path (no WB writes): generate_listing with an uploaded
/// product photo + custom prompt + image_count → N images keeping the product.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn img2img_generate() {
    use base64::Engine;
    let dir = std::env::temp_dir().join("wb-img2img-test");
    let _ = std::fs::remove_dir_all(&dir);
    let state = AppState::new(dir.clone());
    let cfg = get_config(&state.paths);
    if cfg.aurixel_api_key.is_empty() {
        eprintln!("⚠ no AURIXEL_API_KEY — skip");
        return;
    }
    let photo = match std::fs::read("/tmp/imgcmp/ours_main.png") {
        Ok(b) => b,
        Err(_) => {
            eprintln!("⚠ 缺少底图 — skip");
            return;
        }
    };
    let b64 = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&photo)
    );
    let input = ListingInput {
        product_name: "Баскетбольный мяч".into(),
        keywords: vec!["размер 7".into(), "для зала".into()],
        price: 1990.0,
        discount: 0.0,
        brand: None,
        custom_prompt: Some("минималистичный дизайн, бирюзовые акценты".into()),
        image_count: Some(3),
        base_photos: vec![b64],
    };
    let on = |_s: &str, _o: bool, m: &str| eprintln!("  · {}", m);
    let listing = generate_listing(&state, &cfg, &input, &on)
        .await
        .expect("generate_listing");
    eprintln!("=== 生成 {} 张图 ===", listing.images.len());
    for img in &listing.images {
        let p = state.paths.images().join(&img.url);
        let sz = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        eprintln!("  {} {} ({} KB)", img.kind, img.url, sz / 1024);
        assert!(sz > 2000, "image too small");
    }
    assert_eq!(listing.images.len(), 3, "应生成 3 张");
    let _ = std::fs::remove_dir_all(&dir);
}

/// AI-only (no WB writes): does the model produce sensible characteristic
/// values for a headphone category? Validates the "fill popular characteristics"
/// fix without touching the rate-limited / real account.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fill_charcs_headphones() {
    use crate::wb::types::WbCharacteristic;
    let dir = std::env::temp_dir().join("wb-charcs-test");
    let state = AppState::new(dir.clone());
    let cfg = get_config(&state.paths);
    if cfg.aurixel_api_key.is_empty() {
        eprintln!("⚠ no AURIXEL_API_KEY — skip");
        return;
    }
    let mk = |id: i64, name: &str, t: i64, unit: &str| WbCharacteristic {
        charc_id: id,
        subject_name: String::new(),
        subject_id: 593,
        name: name.into(),
        required: false,
        unit_name: unit.into(),
        max_count: 0,
        popular: true,
        charc_type: t,
    };
    let charcs = vec![
        mk(746, "Совместимость", 1, ""),
        mk(4370, "Материал корпуса", 1, ""),
        mk(5023, "Модель", 1, ""),
        mk(9514, "Вид наушников", 1, ""),
        mk(10466, "Беспроводные интерфейсы", 1, ""),
        mk(9623, "Гарантийный срок", 1, ""),
        mk(15883, "Тип подключения", 1, ""),
        mk(15886, "Тип акустического оформления", 1, ""),
        mk(16758, "Степень пылевлагозащиты", 1, ""),
        mk(63292, "Импеданс", 4, "Ом"),
    ];
    let kw = vec![
        "беспроводные".to_string(),
        "bluetooth".to_string(),
        "белые".to_string(),
    ];
    let filled = crate::ai::charcs::fill_characteristics(
        &state.http,
        &cfg,
        "Беспроводные наушники белые для iPhone",
        &kw,
        "Беспроводные наушники TWS белые",
        "Наушники",
        &charcs,
    )
    .await;
    eprintln!("\n=== AI 填充结果: {} / {} 项 ===", filled.len(), charcs.len());
    for c in &charcs {
        match filled.get(&c.charc_id) {
            Some(v) => eprintln!("  ✓ {} = {}", c.name, v),
            None => eprintln!("  · {} (跳过)", c.name),
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    assert!(filled.len() >= 3, "AI 应至少填出几项特征，实际 {}", filled.len());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_generate_and_publish() {
    let dir = std::env::temp_dir().join("wb-e2e-test");
    let _ = std::fs::remove_dir_all(&dir);
    let state = AppState::new(dir.clone());
    let cfg = get_config(&state.paths);

    eprintln!("──────── CONFIG ────────");
    eprintln!("  provider     = {}", cfg.image_provider);
    eprintln!("  aurixel key  = {}", if cfg.aurixel_api_key.is_empty() { "MISSING" } else { "set" });
    eprintln!("  wb token     = {}", if cfg.wb_content_token.is_empty() { "MISSING (will dry-run)" } else { "set" });
    eprintln!("  sandbox      = {}", cfg.wb_sandbox);

    if cfg.aurixel_api_key.is_empty() {
        eprintln!("⚠ no AURIXEL_API_KEY — skipping real test");
        return;
    }

    let input = ListingInput {
        product_name: "运动保温水壶".into(),
        keywords: vec!["保温".into(), "便携".into(), "运动".into(), "304不锈钢".into()],
        price: 1990.0,
        discount: 30.0,
        brand: None,
        custom_prompt: None,
        image_count: None,
        base_photos: vec![],
    };

    // ── generate ──
    eprintln!("\n──────── GENERATE (real Aurixel) ────────");
    let t0 = Instant::now();
    let gen_progress = |stage: &str, ok: bool, msg: &str| eprintln!("  · [{}] {} {}", stage, if ok { "✓" } else { "✗" }, msg);
    let listing = generate_listing(&state, &cfg, &input, &gen_progress)
        .await
        .expect("generate_listing failed");
    let copy = listing.copy.as_ref().expect("copy");
    eprintln!("  ✓ {:.1}s", t0.elapsed().as_secs_f32());
    eprintln!("  title       : {}", copy.title);
    eprintln!("  brand       : {}", listing.brand);
    eprintln!("  category    : {}", copy.category_hint);
    eprintln!("  bullets     : {}", copy.bullets.len());
    eprintln!("  keywords    : {}", copy.keywords.join(", "));
    eprintln!("  description : {} chars", copy.description.chars().count());
    eprintln!("  vendorCode  : {}", listing.vendor_code);
    for img in &listing.images {
        let p = state.paths.images().join(&img.url);
        let sz = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        eprintln!("  image {:7}: {} ({} KB)", img.kind, img.url, sz / 1024);
        assert!(sz > 2000, "image {} is too small ({})", img.kind, sz);
    }

    assert!(!copy.title.is_empty(), "empty title");
    assert!(copy.title.chars().count() <= 60, "title > 60 chars");
    assert!(!copy.description.is_empty(), "empty description");
    assert_eq!(listing.images.len(), 3, "expected 3 images");

    // ── publish (real sandbox if token present, else dry-run) ──
    eprintln!("\n──────── PUBLISH (sandbox={}) ────────", cfg.wb_sandbox);
    let t1 = Instant::now();
    let on = |stage: &str, ok: bool, msg: &str| {
        eprintln!("  [{:8}] {} {}", stage, if ok { "✓" } else { "✗" }, msg);
    };
    let result = publish_listing(&state, &listing, &cfg, &on).await;
    eprintln!("  ── done in {:.1}s ──", t1.elapsed().as_secs_f32());
    eprintln!("  stage   = {:?}", result.stage);
    eprintln!("  nmID    = {:?}", result.nm_id);
    eprintln!("  sandbox = {}", result.sandbox);
    eprintln!("  dry_run = {}", result.dry_run);
    eprintln!("  error   = {:?}", result.error);

    // read back the created card → confirm it has characteristics (the prod fix),
    // then move it to trash (works for sandbox AND production test cards).
    if let Some(nm) = result.nm_id {
        let ctx = WbCtx {
            token: cfg.wb_content_token.clone(),
            sandbox: cfg.wb_sandbox,
        };
        if let Ok(v) = wb_fetch(
            &state,
            &ctx,
            WbReq::post("/content/v2/get/cards/list").body(json!({
                "settings": {
                    "sort": {"ascending": false},
                    "filter": {"withPhoto": -1, "textSearch": listing.vendor_code},
                    "cursor": {"limit": 10}
                }
            })),
        )
        .await
        {
            let n = v
                .get("cards")
                .and_then(|c| c.as_array())
                .and_then(|cards| {
                    cards
                        .iter()
                        .find(|c| c.get("nmID").and_then(|x| x.as_i64()) == Some(nm))
                })
                .and_then(|c| c.get("characteristics"))
                .and_then(|x| x.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            eprintln!("  ✓ 读回卡片特征数 = {}（真实卡片通常 2~24）", n);
        }
        match delete_cards(&state, &ctx, vec![nm]).await {
            Ok(_) => eprintln!("  ✓ 测试卡片 {} 已移入回收站（清理）", nm),
            Err(e) => eprintln!("  ⚠ 删除测试卡片失败: {}", e),
        }
    }

    let _ = std::fs::remove_dir_all(&dir);

    // dry-run must reach Live; a real sandbox run should too (card created).
    assert_eq!(result.stage, ListingStage::Live, "publish did not reach Live: {:?}", result.error);
    assert!(result.nm_id.is_some(), "no nmID assigned");
}
