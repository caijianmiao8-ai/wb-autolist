#![allow(dead_code)]
//! Full generation step (ported from src/lib/generate.ts): marketing copy +
//! main/gallery product images + a composed promo banner → a draft Listing.

use crate::ai::assets::save_image;
use crate::ai::banner::{compose_infographic, make_placeholder, normalize_main, to_png_square};
use crate::ai::copy::generate_copy;
use crate::ai::image::{edit_image, generate_image};
use crate::config::{active_templates, AppConfig};
use crate::state::AppState;
use crate::templates::fill;
use crate::types::{GeneratedImage, Listing, ListingInput, ListingStage, ProductCopy};
use crate::util::{make_vendor_code, new_id, now_iso};
use crate::wb::pipeline::Progress;
use anyhow::Result;
use base64::Engine;
use std::collections::HashMap;

const QUALITY_SUFFIX: &str = ", professional studio product photography, clean white seamless background, soft diffused lighting, sharp focus, ultra detailed, high resolution, commercial e-commerce hero shot, centered composition";

/// Strip an optional `data:...;base64,` prefix and decode.
fn decode_image_input(s: &str) -> Option<Vec<u8>> {
    let b64 = s.rsplit(',').next().unwrap_or(s).trim();
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

/// Pick a brand accent color from the product's category/keywords.
fn accent_for(category: &str, name: &str, keywords: &str) -> &'static str {
    let h = format!("{} {} {}", category, name, keywords).to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| h.contains(w));
    if has(&["наушник", "электрон", "гаджет", "tech", "phone", "телефон", "заряд", "usb", "bluetooth", "powerbank"]) {
        "blue"
    } else if has(&["космет", "beauty", "уход", "крем", "макияж", "ногт", "волос", "маск"]) {
        "pink"
    } else if has(&["спорт", "фитнес", "yoga", "йог", "gym", "тренаж"]) {
        "green"
    } else {
        "red"
    }
}

/// Build the `{PLACEHOLDER}` substitution context from the AI copy + a few knobs.
fn build_ctx(copy: &ProductCopy, name: &str, keywords: &[String], custom: &str) -> HashMap<String, String> {
    let callout_list: Vec<String> = copy
        .bullets
        .iter()
        .map(|b| b.trim())
        .filter(|b| !b.is_empty())
        .take(5)
        .map(|b| b.chars().take(22).collect::<String>())
        .collect();
    let n = callout_list.len().max(3).to_string();
    let callouts = callout_list.join("; ");
    let key_benefit = callout_list
        .first()
        .cloned()
        .or_else(|| keywords.first().cloned())
        .unwrap_or_else(|| copy.title.clone());
    let kw = keywords.join(" ");
    let accent = accent_for(&copy.category_hint, name, &kw).to_string();
    let category = if copy.category_hint.is_empty() {
        name.to_string()
    } else {
        copy.category_hint.clone()
    };
    let mut m = HashMap::new();
    m.insert("TITLE".into(), copy.title.clone());
    m.insert("CALLOUTS".into(), callouts);
    m.insert("N".into(), n);
    m.insert("ACCENT".into(), accent);
    m.insert("KEY_BENEFIT".into(), key_benefit);
    m.insert("SCENE".into(), "an attractive real-life scene where the product is used".into());
    m.insert("CATEGORY".into(), category);
    m.insert("NAME".into(), name.to_string());
    m.insert("CUSTOM".into(), custom.trim().to_string());
    m
}

/// WB rejects unregistered/non-Latin brands ("Бренд … не найден"). Use the
/// universally-accepted "no brand" value unless the user supplies one.
const NO_BRAND: &str = "Нет бренда";

pub async fn generate_listing(
    state: &AppState,
    cfg: &AppConfig,
    raw: &ListingInput,
    on: &Progress,
) -> Result<Listing> {
    // sanitize — batch/queue calls this directly, so a missing price must still
    // get a sensible default here.
    let price = if raw.price > 0.0 { raw.price.round() } else { 1990.0 };
    let discount = raw.discount.clamp(0.0, 99.0).round();
    let brand_in = raw.brand.clone();

    on("generate", true, "生成俄文文案中…");
    let copy = generate_copy(
        &state.http,
        cfg,
        &raw.product_name,
        &raw.keywords,
        brand_in.as_deref(),
    )
    .await;

    let core_prompt = copy
        .image_prompt
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            format!(
                "professional studio e-commerce product photo of {}{}",
                raw.product_name,
                if raw.keywords.is_empty() {
                    String::new()
                } else {
                    format!(", {}", raw.keywords.join(", "))
                }
            )
        });
    // ── Images: N images by type rotation. img2img if the user uploaded a real
    // product photo (keeps the exact product), else text-to-image. ──
    let bases: Vec<Vec<u8>> = raw
        .base_photos
        .iter()
        .filter_map(|s| decode_image_input(s))
        .collect();
    let is_edit = !bases.is_empty();
    let requested = raw.image_count.unwrap_or(3).clamp(1, 12) as usize;
    let custom = raw.custom_prompt.clone().unwrap_or_default();

    // Editable templates drive everything: rotation, per-image prompt, WB slot.
    let templates = active_templates(cfg);
    let ctx = build_ctx(&copy, &raw.product_name, &raw.keywords, &custom);
    let mut plan = templates.plan(requested);
    if plan.is_empty() {
        // user disabled/emptied every template → never ship zero images.
        plan = crate::templates::built_in_defaults().plan(requested);
    }
    let count = plan.len().max(1);

    on(
        "generate",
        true,
        &format!(
            "文案完成，开始生成 {} 张图（{}，每张约 1-2 分钟）…",
            count,
            if is_edit { "用你的产品图 img2img" } else { "AI 文生图" }
        ),
    );

    let mut images: Vec<GeneratedImage> = vec![];
    for (i, tmpl) in plan.iter().enumerate() {
        on(
            "generate",
            true,
            &format!("生成第 {}/{} 张（{}）…", i + 1, count, tmpl.label),
        );
        let overlay = tmpl.text_mode == "overlay";
        let prompt = fill(&tmpl.body, &ctx);
        let raw_bytes: Result<Vec<u8>> = if is_edit {
            match to_png_square(&bases[i % bases.len()], 1024) {
                Ok(png) => edit_image(&state.http, cfg, &png, &prompt, "1024x1536").await,
                Err(e) => Err(e),
            }
        } else {
            generate_image(&state.http, cfg, &prompt, 1024, 1536, Some(1000 + i as u64)).await
        };
        let buf = match raw_bytes {
            Ok(b) => {
                let norm = normalize_main(&b, 1200, 1600).unwrap_or(b);
                if overlay {
                    // perfect Cyrillic: composite exact text deterministically
                    // (resvg) over the clean, text-free generated visual.
                    let feats: Vec<String> = copy
                        .bullets
                        .iter()
                        .map(|x| x.trim().to_string())
                        .filter(|x| !x.is_empty())
                        .take(3)
                        .collect();
                    compose_infographic(&norm, &copy.title, &feats, None, 1200, 1600).unwrap_or(norm)
                } else {
                    norm
                }
            }
            Err(_) => {
                // Never ship the synthetic placeholder when the seller gave a real
                // photo — fall back to a clean derivation of their own image.
                let fallback = bases
                    .get(i % bases.len().max(1))
                    .and_then(|b| to_png_square(b, 1200).ok())
                    .and_then(|p| normalize_main(&p, 1200, 1600).ok());
                match fallback {
                    Some(b) => b,
                    None => make_placeholder(&raw.product_name, &raw.keywords, 1200, 1600, i as u32)?,
                }
            }
        };
        images.push(save_image(&state.paths, &buf, &tmpl.slot, &prompt, 1200, 1600, "jpg"));
    }

    on("generate", true, "全部生成完成");
    let now = now_iso();
    // WB card brand: the user's brand if they typed one, else "Нет бренда".
    // (The AI-written brand stays in the copy for display, but isn't forced
    // onto the WB brand field — an unregistered brand gets rejected.)
    let brand = brand_in
        .as_ref()
        .map(|b| b.trim())
        .filter(|b| !b.is_empty())
        .map(|b| b.to_string())
        .unwrap_or_else(|| NO_BRAND.to_string());

    Ok(Listing {
        id: new_id("lst_"),
        created_at: now.clone(),
        updated_at: now,
        product_name: raw.product_name.clone(),
        keywords: raw.keywords.clone(),
        price,
        discount,
        brand,
        copy: Some(ProductCopy {
            title: copy.title.clone(),
            description: copy.description.clone(),
            bullets: copy.bullets.clone(),
            brand: copy.brand.clone(),
            keywords: copy.keywords.clone(),
            category_hint: copy.category_hint.clone(),
            image_prompt: Some(core_prompt),
        }),
        images,
        subject_id: None,
        subject_name: None,
        vendor_code: make_vendor_code(&raw.product_name),
        stage: ListingStage::Draft,
        nm_id: None,
        imt_id: None,
        dry_run: cfg.wb_content_token.is_empty(),
        sandbox: cfg.wb_sandbox,
        logs: vec![],
        error: None,
    })
}
