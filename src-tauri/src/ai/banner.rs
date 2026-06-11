#![allow(dead_code)]
//! Promo banner + image normalization (ported from src/lib/ai/banner.ts).
//! sharp → `image` crate for raster ops + resvg to rasterize the SVG overlay.

use anyhow::{anyhow, Result};
use image::{DynamicImage, RgbaImage};
use std::sync::{Arc, OnceLock};

pub struct PromoSpec {
    pub title: String,
    pub subtitle: Option<String>,
    pub price: Option<f64>,
    pub old_price: Option<f64>,
    pub discount: Option<f64>,
    pub badge: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

// ── SVG rasterization ───────────────────────────────────────────────────────

static FONTDB: OnceLock<Arc<resvg::usvg::fontdb::Database>> = OnceLock::new();

fn shared_fontdb() -> Arc<resvg::usvg::fontdb::Database> {
    FONTDB
        .get_or_init(|| {
            let mut db = resvg::usvg::fontdb::Database::new();
            db.load_system_fonts();
            Arc::new(db)
        })
        .clone()
}

/// Rasterize an SVG to a premultiplied-RGBA image (tiny_skia pixmap layout).
fn render_svg(svg: &str, w: u32, h: u32) -> Result<RgbaImage> {
    let mut opt = resvg::usvg::Options::default();
    opt.fontdb = shared_fontdb();
    let tree = resvg::usvg::Tree::from_str(svg, &opt).map_err(|e| anyhow!("svg parse: {}", e))?;
    let mut pixmap =
        resvg::tiny_skia::Pixmap::new(w, h).ok_or_else(|| anyhow!("pixmap alloc {}x{}", w, h))?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::default(),
        &mut pixmap.as_mut(),
    );
    RgbaImage::from_raw(w, h, pixmap.take()).ok_or_else(|| anyhow!("rgba from pixmap"))
}

/// Composite a premultiplied-RGBA overlay over an opaque base (in place).
fn composite_over(base: &mut RgbaImage, overlay: &RgbaImage) {
    for (bp, op) in base.pixels_mut().zip(overlay.pixels()) {
        let a = op[3] as u32;
        if a == 0 {
            continue;
        }
        let inv = 255 - a;
        for i in 0..3 {
            // overlay is premultiplied → out = src + dst*(1-a)
            let v = op[i] as u32 + (bp[i] as u32 * inv) / 255;
            bp[i] = v.min(255) as u8;
        }
        bp[3] = 255;
    }
}

fn resize_cover(img: DynamicImage, w: u32, h: u32) -> DynamicImage {
    let (iw, ih) = (img.width(), img.height());
    if iw == 0 || ih == 0 {
        return img.resize_exact(w, h, image::imageops::FilterType::Lanczos3);
    }
    let scale = (w as f32 / iw as f32).max(h as f32 / ih as f32);
    let nw = ((iw as f32 * scale).round() as u32).max(w);
    let nh = ((ih as f32 * scale).round() as u32).max(h);
    let resized = img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3);
    let x = (nw - w) / 2;
    let y = (nh - h) / 2;
    resized.crop_imm(x, y, w, h)
}

fn flatten_white(img: &mut RgbaImage) {
    for p in img.pixels_mut() {
        let a = p[3] as u32;
        if a < 255 {
            let inv = 255 - a;
            for i in 0..3 {
                p[i] = ((p[i] as u32 * a + 255 * inv) / 255).min(255) as u8;
            }
            p[3] = 255;
        }
    }
}

fn to_jpeg(img: &RgbaImage, quality: u8) -> Result<Vec<u8>> {
    let rgb = DynamicImage::ImageRgba8(img.clone()).to_rgb8();
    let mut buf = Vec::new();
    {
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
        enc.encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )?;
    }
    Ok(buf)
}

// ── public ops ──────────────────────────────────────────────────────────────

/// Normalize any AI image to a clean WB-compliant main photo (3:4, JPEG).
pub fn normalize_main(base: &[u8], w: u32, h: u32) -> Result<Vec<u8>> {
    let img = image::load_from_memory(base)?;
    let covered = resize_cover(img, w, h);
    let mut rgba = covered.to_rgba8();
    flatten_white(&mut rgba);
    to_jpeg(&rgba, 92)
}

/// Derive a "detail" shot from a base image (center zoom ~1.4x) — no network.
pub fn derive_detail(base: &[u8], w: u32, h: u32) -> Result<Vec<u8>> {
    let img = image::load_from_memory(base)?;
    let (bw, bh) = (img.width(), img.height());
    let crop_w = ((bw as f32) / 1.4).round() as u32;
    let crop_h = ((bh as f32) / 1.4).round() as u32;
    let left = (bw.saturating_sub(crop_w)) / 2;
    let top = (bh.saturating_sub(crop_h)) / 3;
    let cropped = img.crop_imm(left, top, crop_w.max(1), crop_h.max(1));
    let covered = resize_cover(cropped, w, h);
    let mut rgba = covered.to_rgba8();
    for p in rgba.pixels_mut() {
        for i in 0..3 {
            p[i] = ((p[i] as f32 * 1.03).round() as u32).min(255) as u8;
        }
    }
    to_jpeg(&rgba, 92)
}

/// Compose a promo banner: AI product image + gradient shade + title/price/badge.
pub fn compose_promo(base: &[u8], spec: &PromoSpec) -> Result<Vec<u8>> {
    let w = spec.width.unwrap_or(1080);
    let h = spec.height.unwrap_or(1440);
    let img = image::load_from_memory(base)?;
    let mut canvas = resize_cover(img, w, h).to_rgba8();
    let overlay = render_svg(&build_promo_svg(spec, w, h), w, h)?;
    composite_over(&mut canvas, &overlay);
    to_jpeg(&canvas, 90)
}

/// Zero-config fallback: a branded gradient placeholder with the product name.
pub fn make_placeholder(
    product_name: &str,
    keywords: &[String],
    w: u32,
    h: u32,
    variant: u32,
) -> Result<Vec<u8>> {
    let img = render_svg(&build_placeholder_svg(product_name, keywords, w, h, variant), w, h)?;
    to_jpeg(&img, 90)
}

// ── text helpers ────────────────────────────────────────────────────────────

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn wrap(text: &str, per_line: usize, max_lines: usize) -> Vec<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut lines: Vec<String> = vec![];
    let mut cur = String::new();
    for w in &words {
        let candidate = if cur.is_empty() {
            w.to_string()
        } else {
            format!("{} {}", cur, w)
        };
        if candidate.chars().count() > per_line {
            if !cur.is_empty() {
                lines.push(cur.clone());
            }
            cur = w.to_string();
        } else {
            cur = candidate;
        }
        if lines.len() >= max_lines {
            break;
        }
    }
    if !cur.is_empty() && lines.len() < max_lines {
        lines.push(cur.clone());
    }
    if lines.len() == max_lines {
        let all = words.join(" ");
        let shown = lines.join(" ");
        if all.chars().count() > shown.chars().count() {
            if let Some(last) = lines.last_mut() {
                let mut chars: Vec<char> = last.chars().collect();
                if let Some(c) = chars.last_mut() {
                    *c = '…';
                }
                *last = chars.into_iter().collect();
            }
        }
    }
    lines
}

fn format_rub(n: f64) -> String {
    let n = n.round() as i64;
    let s = n.abs().to_string();
    let len = s.len();
    let mut grouped = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (len - i) % 3 == 0 {
            grouped.push(' ');
        }
        grouped.push(ch);
    }
    if n < 0 {
        format!("-{} ₽", grouped)
    } else {
        format!("{} ₽", grouped)
    }
}

fn build_promo_svg(spec: &PromoSpec, w: u32, h: u32) -> String {
    let title_lines = wrap(&spec.title, 20, 2);
    let price_y = h as i32 - 56;
    let title_bottom_y = h as i32 - 132;
    let title_start_y = title_bottom_y - (title_lines.len() as i32 - 1) * 58;
    let subtitle_y = title_start_y - 52;

    let price_block = if spec.price.is_some() {
        let disc = match spec.discount {
            Some(d) => format!(
                r##"<g transform="translate(-150,-30)"><rect x="0" y="0" rx="14" ry="14" width="150" height="58" fill="#cb11ab"/><text x="75" y="40" font-size="34" font-weight="800" fill="#fff" text-anchor="middle" font-family="Arial, sans-serif">-{}%</text></g>"##,
                d as i64
            ),
            None => String::new(),
        };
        format!(
            r##"<g transform="translate({}, 70)">{}</g>"##,
            w as i32 - 60,
            disc
        )
    } else {
        String::new()
    };

    let price_tag = if let Some(price) = spec.price {
        let formatted = format_rub(price);
        let old = match spec.old_price {
            Some(op) if op > price => {
                let x = formatted.chars().count() as i32 * 34 + 24;
                format!(
                    r##"<text x="{}" y="-6" font-size="30" fill="#cbd5e1" text-decoration="line-through" font-family="Arial, sans-serif">{}</text>"##,
                    x,
                    esc(&format_rub(op))
                )
            }
            _ => String::new(),
        };
        format!(
            r##"<g transform="translate(60, {})"><text x="0" y="0" font-size="60" font-weight="900" fill="#fff" font-family="Arial, sans-serif">{}</text>{}</g>"##,
            price_y,
            esc(&formatted),
            old
        )
    } else {
        String::new()
    };

    let badge = match &spec.badge {
        Some(b) if !b.is_empty() => {
            let bl = b.chars().count() as i32;
            format!(
                r##"<g transform="translate(60, 60)"><rect x="0" y="0" rx="10" ry="10" width="{}" height="52" fill="#ffffff"/><text x="{}" y="36" font-size="30" font-weight="800" fill="#cb11ab" text-anchor="middle" font-family="Arial, sans-serif">{}</text></g>"##,
                28 + bl * 22,
                14 + (bl * 22) / 2,
                esc(b)
            )
        }
        _ => String::new(),
    };

    let subtitle = match &spec.subtitle {
        Some(s) if !s.is_empty() => {
            let trimmed: String = s.chars().take(34).collect();
            format!(
                r##"<text x="62" y="{}" font-size="30" font-weight="600" fill="#f3c6e8" font-family="Arial, sans-serif">{}</text>"##,
                subtitle_y,
                esc(&trimmed)
            )
        }
        _ => String::new(),
    };

    let titles: String = title_lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            format!(
                r##"<text x="60" y="{}" font-size="54" font-weight="800" fill="#ffffff" font-family="Arial, sans-serif">{}</text>"##,
                title_start_y + i as i32 * 58,
                esc(line)
            )
        })
        .collect();

    format!(
        r##"<svg width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(12,9,24,0.0)"/><stop offset="45%" stop-color="rgba(12,9,24,0.0)"/><stop offset="72%" stop-color="rgba(12,9,24,0.55)"/><stop offset="100%" stop-color="rgba(12,9,24,0.95)"/></linearGradient><linearGradient id="top" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(12,9,24,0.55)"/><stop offset="100%" stop-color="rgba(12,9,24,0.0)"/></linearGradient></defs><rect width="{w}" height="{h}" fill="url(#shade)"/><rect width="{w}" height="180" fill="url(#top)"/>{badge}{price_block}{subtitle}{titles}{price_tag}</svg>"##,
        w = w,
        h = h,
        badge = badge,
        price_block = price_block,
        subtitle = subtitle,
        titles = titles,
        price_tag = price_tag
    )
}

fn build_placeholder_svg(
    product_name: &str,
    keywords: &[String],
    w: u32,
    h: u32,
    variant: u32,
) -> String {
    let hue = ((variant * 47) % 360) as f64;
    let h1 = 300.0 + hue / 6.0;
    let h2 = 270.0 + hue / 6.0;
    let name_lines = wrap(product_name, 14, 3);
    let start_y = h as i32 / 2 - (name_lines.len() as i32 * 78) / 2;
    let cx = w / 2;
    let circle_cy = (h as f32 * 0.36) as i32;
    let star_y = (h as f32 * 0.37) as i32;
    let circle_r = (w as f32 * 0.16) as i32;

    let names: String = name_lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            format!(
                r##"<text x="{}" y="{}" font-size="64" font-weight="800" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif">{}</text>"##,
                cx,
                start_y + i as i32 * 78,
                esc(line)
            )
        })
        .collect();
    let kw_text = esc(&keywords.iter().take(4).cloned().collect::<Vec<_>>().join(" · "));
    let kw_y = start_y + name_lines.len() as i32 * 78 + 56;

    format!(
        r##"<svg width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="hsl({h1},70%,22%)"/><stop offset="100%" stop-color="hsl({h2},60%,12%)"/></linearGradient><radialGradient id="glow" cx="50%" cy="38%" r="60%"><stop offset="0%" stop-color="rgba(233,30,140,0.35)"/><stop offset="100%" stop-color="rgba(0,0,0,0)"/></radialGradient></defs><rect width="{w}" height="{h}" fill="url(#bg)"/><rect width="{w}" height="{h}" fill="url(#glow)"/><circle cx="{cx}" cy="{circle_cy}" r="{circle_r}" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="3"/><text x="{cx}" y="{star_y}" font-size="120" text-anchor="middle" fill="rgba(255,255,255,0.9)" font-family="Arial, sans-serif">★</text>{names}<text x="{cx}" y="{kw_y}" font-size="34" text-anchor="middle" fill="#e2c8ef" font-family="Arial, sans-serif">{kw_text}</text><text x="{cx}" y="{footer_y}" font-size="26" text-anchor="middle" fill="rgba(255,255,255,0.45)" font-family="Arial, sans-serif">AI 占位图 · 配置图像 API 后生成真实产品图</text></svg>"##,
        w = w,
        h = h,
        h1 = h1,
        h2 = h2,
        cx = cx,
        circle_cy = circle_cy,
        circle_r = circle_r,
        star_y = star_y,
        names = names,
        kw_y = kw_y,
        kw_text = kw_text,
        footer_y = h as i32 - 60
    )
}
