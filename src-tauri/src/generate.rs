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
use crate::wb::barcode::generate_ean13;
use crate::wb::pipeline::Progress;
use anyhow::Result;
use base64::Engine;
use futures::stream::{self, StreamExt};
use std::collections::HashMap;

/// How many images to generate CONCURRENTLY. Each gpt-image call is ~1-2 min, so
/// serial gen of N images is painfully slow. The image client already retries on
/// 429/5xx, so a moderate fan-out is safe (a transient rate-limit self-heals).
pub(crate) const IMAGE_CONCURRENCY: usize = 4;

const QUALITY_SUFFIX: &str = ", professional studio product photography, clean white seamless background, soft diffused lighting, sharp focus, ultra detailed, high resolution, commercial e-commerce hero shot, centered composition";

/// Strip an optional `data:...;base64,` prefix and decode.
pub(crate) fn decode_image_input(s: &str) -> Option<Vec<u8>> {
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
pub(crate) fn build_ctx(copy: &ProductCopy, name: &str, keywords: &[String], custom: &str) -> HashMap<String, String> {
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

/// Render ONE image for a template (shared by generate + regenerate). `base` =
/// the seller's product photo for img2img (None → text-to-image). On failure it
/// derives from the real photo rather than shipping a synthetic placeholder.
pub(crate) async fn render_one(
    state: &AppState,
    cfg: &AppConfig,
    tmpl: &crate::templates::ImageTemplate,
    ctx: &HashMap<String, String>,
    base: Option<&[u8]>,
    title: &str,
    bullets: &[String],
    product_name: &str,
    keywords: &[String],
    idx: usize,
) -> Result<GeneratedImage> {
    let prompt = fill(&tmpl.body, ctx);
    let mut is_placeholder = false;
    let raw_bytes: Result<Vec<u8>> = match base {
        Some(b) => match to_png_square(b, 1024) {
            Ok(png) => edit_image(&state.http, cfg, &png, &prompt, "1024x1536").await,
            Err(e) => Err(e),
        },
        None => generate_image(&state.http, cfg, &prompt, 1024, 1536, Some(1000 + idx as u64)).await,
    };
    let buf = match raw_bytes {
        Ok(b) => {
            let norm = normalize_main(&b, 1200, 1600).unwrap_or(b);
            if tmpl.text_mode == "overlay" {
                // perfect Cyrillic: composite exact text (resvg) over the clean visual.
                let feats: Vec<String> = bullets
                    .iter()
                    .map(|x| x.trim().to_string())
                    .filter(|x| !x.is_empty())
                    .take(3)
                    .collect();
                compose_infographic(&norm, title, &feats, None, 1200, 1600).unwrap_or(norm)
            } else {
                norm
            }
        }
        Err(_) => {
            let fallback = base
                .and_then(|b| to_png_square(b, 1200).ok())
                .and_then(|p| normalize_main(&p, 1200, 1600).ok());
            match fallback {
                Some(b) => b, // derived from the real photo — safe to ship
                None => {
                    is_placeholder = true;
                    make_placeholder(product_name, keywords, 1200, 1600, idx as u32)?
                }
            }
        }
    };
    let mut img = save_image(&state.paths, &buf, &tmpl.slot, &prompt, 1200, 1600, "jpg")?;
    // Tag synthetic placeholders so the publish pipeline can refuse to ship one
    // as a live product photo (it carries instructional text, not the product).
    img.template_kind = if is_placeholder { "placeholder".to_string() } else { tmpl.kind.clone() };
    Ok(img)
}

/// WB rejects unregistered/non-Latin brands ("Бренд … не найден"). Use the
/// universally-accepted "no brand" value unless the user supplies one.
const NO_BRAND: &str = "Нет бренда";

pub async fn generate_listing(
    state: &AppState,
    cfg: &AppConfig,
    raw: &ListingInput,
    on: &Progress,
    main_only: bool,
) -> Result<Listing> {
    // sanitize — batch/queue calls this directly, so a missing price must still
    // get a sensible default here.
    let price = if raw.price > 0.0 { raw.price.round() } else { 1990.0 };
    let discount = raw.discount.clamp(0.0, 99.0).round();
    let brand_in = raw.brand.clone();

    on("generate", true, "生成俄文文案中…");
    let (copy, ai_ok) = generate_copy(
        &state.http,
        cfg,
        &raw.product_name,
        &raw.keywords,
        brand_in.as_deref(),
    )
    .await;
    if !ai_ok {
        on("generate", false, "AI 文案不可用，已用模板兜底（请检查 Aurixel Key/网络后重新生成）。");
    }

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
    // Surface partial decode failures — silently dropping a seller's product
    // photos and switching to text-to-image yields a hallucinated product.
    if !raw.base_photos.is_empty() && bases.len() < raw.base_photos.len() {
        on(
            "generate",
            false,
            &format!(
                "{} 张产品图无法读取，已忽略{}。",
                raw.base_photos.len() - bases.len(),
                if bases.is_empty() { "，将改用 AI 文生图（可能不像实物）" } else { "" }
            ),
        );
    }
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
    let full_count = plan.len().max(1);
    // main-first: render only the lead image now; the rest go through generate_rest.
    let now_count = if main_only && full_count > 1 { 1 } else { full_count };

    on(
        "generate",
        true,
        &format!(
            "文案完成，开始生成 {} 张图（{}，每张约 1-2 分钟）…",
            now_count,
            if is_edit { "用你的产品图 img2img" } else { "AI 文生图" }
        ),
    );

    // Generate the images CONCURRENTLY (bounded), preserving order (index 0 = main).
    // buffered() runs up to N at once but yields in order, so progress + the images
    // vec stay deterministic; the first render error aborts the whole gen (as before).
    let mut images: Vec<GeneratedImage> = Vec::with_capacity(now_count);
    {
        // Bind references so each `async move` future captures cheap Copy refs (not a
        // move of the shared ctx/copy/raw). Build the futures in a for loop (same
        // anonymous type each iter → a Vec works) to avoid the closure-HRTB error that
        // `iter().map(|x| async move {…})` hits under buffered().
        let (ctx_r, copy_r, raw_r, bases_r) = (&ctx, &copy, &raw, &bases);
        let mut futs = Vec::with_capacity(now_count);
        for (i, tmpl) in plan.iter().take(now_count).enumerate() {
            let base = if bases_r.is_empty() { None } else { Some(bases_r[i % bases_r.len()].as_slice()) };
            futs.push(async move {
                render_one(
                    state, cfg, tmpl, ctx_r, base, &copy_r.title, &copy_r.bullets,
                    &raw_r.product_name, &raw_r.keywords, i,
                )
                .await
            });
        }
        let mut s = stream::iter(futs).buffered(IMAGE_CONCURRENCY);
        let mut k = 0usize;
        while let Some(res) = s.next().await {
            k += 1;
            on("generate", true, &format!("已生成 {}/{} 张…", k, now_count));
            images.push(res?);
        }
    }

    on(
        "generate",
        true,
        if now_count < full_count {
            "主图已生成，确认后再出其余"
        } else {
            "全部生成完成"
        },
    );
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

    // Package dims: per-listing input if set, else the seller's configured
    // defaults (never zero — WB bills logistics/storage on these).
    let length = if raw.length > 0 { raw.length } else { cfg.default_length.max(1) };
    let width = if raw.width > 0 { raw.width } else { cfg.default_width.max(1) };
    let height = if raw.height > 0 { raw.height } else { cfg.default_height.max(1) };
    let weight = if raw.weight > 0.0 {
        raw.weight
    } else if cfg.default_weight > 0.0 {
        cfg.default_weight
    } else {
        0.3
    };

    Ok(Listing {
        id: new_id("lst_"),
        created_at: now.clone(),
        updated_at: now,
        product_name: raw.product_name.clone(),
        keywords: raw.keywords.clone(),
        price,
        discount,
        brand,
        length,
        width,
        height,
        weight,
        copy: Some(ProductCopy {
            title: copy.title.clone(),
            description: copy.description.clone(),
            bullets: copy.bullets.clone(),
            brand: copy.brand.clone(),
            keywords: copy.keywords.clone(),
            category_hint: copy.category_hint.clone(),
            image_prompt: Some(core_prompt),
            title_zh: copy.title_zh.clone(),
            description_zh: copy.description_zh.clone(),
            bullets_zh: copy.bullets_zh.clone(),
        }),
        images,
        subject_id: None,
        subject_name: None,
        vendor_code: make_vendor_code(&raw.product_name),
        // Mint the barcode ONCE here and reuse on every publish/resume so a retry
        // can't create a second card and a resumed card can set stock.
        sku: generate_ean13(),
        stage: ListingStage::Draft,
        nm_id: None,
        imt_id: None,
        dry_run: cfg.wb_content_token.is_empty(),
        sandbox: cfg.wb_sandbox,
        logs: vec![],
        error: None,
        partial: now_count < full_count,
        requested_images: full_count as u32,
        video_ru: None, // set later by the single-flow when a video is dubbed
        characteristics: vec![], // user-edited via「全部商品参数」; empty = AI auto-fill
        tnved: String::new(),
    })
}
