#![allow(dead_code)]
//! Full generation step (ported from src/lib/generate.ts): marketing copy +
//! main/gallery product images + a composed promo banner → a draft Listing.

use crate::ai::assets::save_image;
use crate::ai::banner::{compose_promo, derive_detail, make_placeholder, normalize_main, PromoSpec};
use crate::ai::copy::generate_copy;
use crate::ai::image::generate_image;
use crate::config::AppConfig;
use crate::state::AppState;
use crate::types::{GeneratedImage, Listing, ListingInput, ListingStage, ProductCopy};
use crate::util::{make_vendor_code, new_id, now_iso, original_price};
use anyhow::Result;

const QUALITY_SUFFIX: &str = ", professional studio product photography, clean white seamless background, soft diffused lighting, sharp focus, ultra detailed, high resolution, commercial e-commerce hero shot, centered composition";

pub async fn generate_listing(
    state: &AppState,
    cfg: &AppConfig,
    raw: &ListingInput,
) -> Result<Listing> {
    // sanitize — batch/queue calls this directly, so a missing price must still
    // get a sensible default here.
    let price = if raw.price > 0.0 { raw.price.round() } else { 1990.0 };
    let discount = raw.discount.clamp(0.0, 99.0).round();
    let brand_in = raw.brand.clone();

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
    let base_prompt = format!("{}{}", core_prompt, QUALITY_SUFFIX);

    let mut images: Vec<GeneratedImage> = vec![];

    // Main product image (3:4). Fall back to a branded placeholder.
    let mut ai_ok = false;
    let main_buf: Vec<u8> = match generate_image(&state.http, cfg, &base_prompt, 1024, 1365, Some(1000))
        .await
    {
        Ok(bytes) => match normalize_main(&bytes, 1200, 1600) {
            Ok(b) => {
                ai_ok = true;
                b
            }
            Err(_) => make_placeholder(&raw.product_name, &raw.keywords, 1200, 1600, 0)?,
        },
        Err(_) => make_placeholder(&raw.product_name, &raw.keywords, 1200, 1600, 0)?,
    };
    images.push(save_image(
        &state.paths,
        &main_buf,
        "main",
        &base_prompt,
        1200,
        1600,
        "jpg",
    ));

    // Detail shot — derived from the main image (no extra network call).
    let detail = if ai_ok {
        derive_detail(&main_buf, 1200, 1600)
    } else {
        make_placeholder(&raw.product_name, &raw.keywords, 1200, 1600, 1)
    };
    if let Ok(d) = detail {
        images.push(save_image(
            &state.paths,
            &d,
            "gallery",
            &format!("{} (detail)", base_prompt),
            1200,
            1600,
            "jpg",
        ));
    }

    // Promo banner — oldPrice = pre-discount base, same as WB submission.
    let old_price = if discount > 0.0 {
        Some(original_price(price, discount))
    } else {
        None
    };
    let promo = compose_promo(
        &main_buf,
        &PromoSpec {
            title: copy.title.clone(),
            subtitle: copy.bullets.first().cloned(),
            price: Some(price),
            old_price,
            discount: if discount > 0.0 { Some(discount) } else { None },
            badge: Some("ХИТ".to_string()),
            width: Some(1080),
            height: Some(1440),
        },
    )?;
    images.push(save_image(
        &state.paths,
        &promo,
        "promo",
        "promo banner",
        1080,
        1440,
        "jpg",
    ));

    let now = now_iso();
    let brand = brand_in
        .as_ref()
        .filter(|b| !b.is_empty())
        .cloned()
        .unwrap_or_else(|| copy.brand.clone());

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
