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
use crate::wb::client::WbCtx;
use crate::wb::pipeline::publish_listing;
use std::time::Instant;

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

    // clean up: move the test card to trash (also validates delete_cards)
    if let (Some(nm), true) = (result.nm_id, result.sandbox) {
        let ctx = WbCtx {
            token: cfg.wb_content_token.clone(),
            sandbox: true,
        };
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
