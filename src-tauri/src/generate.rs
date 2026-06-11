#![allow(dead_code)]
//! Full generation step (ported from src/lib/generate.ts): marketing copy +
//! main/gallery product images + a composed promo banner → a draft Listing.

use crate::ai::assets::save_image;
use crate::ai::banner::{make_placeholder, normalize_main, to_png_square};
use crate::ai::copy::generate_copy;
use crate::ai::image::{edit_image, generate_image};
use crate::config::AppConfig;
use crate::state::AppState;
use crate::types::{GeneratedImage, Listing, ListingInput, ListingStage, ProductCopy};
use crate::util::{make_vendor_code, new_id, now_iso};
use crate::wb::pipeline::Progress;
use anyhow::Result;
use base64::Engine;

const QUALITY_SUFFIX: &str = ", professional studio product photography, clean white seamless background, soft diffused lighting, sharp focus, ultra detailed, high resolution, commercial e-commerce hero shot, centered composition";

/// Strip an optional `data:...;base64,` prefix and decode.
fn decode_image_input(s: &str) -> Option<Vec<u8>> {
    let b64 = s.rsplit(',').next().unwrap_or(s).trim();
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

/// Image types to produce, in rotation order (index 0 is always the WB main).
fn image_plan(n: usize) -> Vec<&'static str> {
    const CYCLE: [&str; 8] = [
        "main", "info", "scene", "angle", "info", "scene", "angle", "info",
    ];
    let n = n.clamp(1, 8);
    CYCLE.iter().take(n).copied().collect()
}

fn wb_slot(kind: &str) -> &'static str {
    match kind {
        "main" => "main",
        "info" => "promo",
        _ => "gallery",
    }
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "main" => "主图",
        "info" => "信息图",
        "scene" => "场景图",
        _ => "细节图",
    }
}

/// Build the per-image prompt. `is_edit` = we have a real product photo to keep.
fn build_image_prompt(
    kind: &str,
    is_edit: bool,
    title_ru: &str,
    name: &str,
    callouts: &str,
    custom: &str,
) -> String {
    let head = if is_edit {
        "Keep this exact product unchanged.".to_string()
    } else {
        format!("Professional studio image of {}.", name)
    };
    let body = match kind {
        "main" => {
            "Clean white studio e-commerce product photo, centered, soft shadow, premium, no text."
                .to_string()
        }
        "info" => format!(
            "Clean Wildberries product infographic, white background. Bold Russian title at top: \"{}\". Feature callouts with small icons: {}. Modern professional retail card, accurate legible Russian text, no price.",
            title_ru, callouts
        ),
        "scene" => {
            "Place it in an attractive, relevant real-life lifestyle scene with premium photography and natural lighting, no text."
                .to_string()
        }
        _ => {
            "Close-up detail shot highlighting texture and quality, clean background, no text."
                .to_string()
        }
    };
    let tail = if custom.trim().is_empty() {
        String::new()
    } else {
        format!(" {}", custom.trim())
    };
    format!("{} {}{}", head, body, tail)
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
    let count = raw.image_count.unwrap_or(3).clamp(1, 8) as usize;
    let callouts = copy
        .bullets
        .iter()
        .filter(|b| !b.trim().is_empty())
        .take(4)
        .map(|b| b.chars().take(24).collect::<String>())
        .collect::<Vec<_>>()
        .join(", ");
    let custom = raw.custom_prompt.clone().unwrap_or_default();
    let plan = image_plan(count);

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
    for (i, kind) in plan.iter().enumerate() {
        on(
            "generate",
            true,
            &format!("生成第 {}/{} 张（{}）…", i + 1, count, kind_label(kind)),
        );
        let prompt = build_image_prompt(kind, is_edit, &copy.title, &raw.product_name, &callouts, &custom);
        let raw_bytes: Result<Vec<u8>> = if is_edit {
            match to_png_square(&bases[i % bases.len()], 1024) {
                Ok(png) => edit_image(&state.http, cfg, &png, &prompt, "1024x1536").await,
                Err(e) => Err(e),
            }
        } else {
            generate_image(&state.http, cfg, &prompt, 1024, 1536, Some(1000 + i as u64)).await
        };
        let buf = match raw_bytes {
            Ok(b) => normalize_main(&b, 1200, 1600).unwrap_or(b),
            Err(_) => make_placeholder(&raw.product_name, &raw.keywords, 1200, 1600, i as u32)?,
        };
        images.push(save_image(
            &state.paths,
            &buf,
            wb_slot(kind),
            &prompt,
            1200,
            1600,
            "jpg",
        ));
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
