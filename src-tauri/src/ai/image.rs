#![allow(dead_code)]
//! Text-to-image (ported from src/lib/ai/image.ts). Aurixel (gpt-image-2) is
//! the default; OpenAI (gpt-image-1) and keyless Pollinations are fallbacks.

use crate::config::AppConfig;
use anyhow::{anyhow, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::time::Duration;

const AURIXEL_BASE: &str = "https://conduit-api.bifrostapi.net/v1";

/// Attempts per image. Images are generated several-at-a-time, so a burst can hit
/// the gateway's concurrency/rate limit (429); with too few, too-short retries the
/// image silently degrades to a synthetic placeholder. Retry longer instead — by
/// the later attempts the sibling jobs have finished and capacity is free again.
const RETRIES: u32 = 5;

/// A transport error (usually a 300s upload timeout on a slow uplink) is NOT a
/// rate limit — retrying it 5× would burn ~25 min per image. Cap those tightly.
const TRANSPORT_RETRIES: u32 = 2;

/// Hard ceiling on total time spent on ONE image, retries included. Without it a
/// pathological case (repeated 300s timeouts + backoff) could hang generation for
/// half an hour per image with no cancel button.
const DEADLINE: Duration = Duration::from_secs(600);

/// Escalating backoff: 15s, 30s, 45s, 60s — long enough to outlast a burst.
fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(15 * (attempt as u64 + 1))
}

/// True while there's still time for another attempt (incl. the backoff wait).
fn have_time(start: std::time::Instant, wait: Duration) -> bool {
    start.elapsed() + wait < DEADLINE
}

/// How many reference photos to send in ONE edit call. More angles = better
/// product fidelity, but each is a full upload — cap it so the request stays sane.
pub const MAX_REF_PHOTOS: usize = 4;

/// Image-to-image (edit): keep the input product, restyle per the prompt.
/// Aurixel gpt-image-2 `/images/edits` — multipart form. Slow (~80-150s).
/// Accepts MULTIPLE reference photos (verified: the gateway takes `image[]`),
/// so the model sees the real product from several angles instead of just one.
pub async fn edit_image(
    http: &reqwest::Client,
    cfg: &AppConfig,
    base_pngs: &[Vec<u8>],
    prompt: &str,
    size: &str,
) -> Result<Vec<u8>> {
    if cfg.aurixel_api_key.is_empty() {
        return Err(anyhow!("图生图需要 Aurixel Key"));
    }
    if base_pngs.is_empty() {
        return Err(anyhow!("图生图需要至少一张参考图"));
    }
    let refs: Vec<&Vec<u8>> = base_pngs.iter().take(MAX_REF_PHOTOS).collect();
    let url = format!("{}/images/edits", AURIXEL_BASE);
    let mut last_err = String::new();
    let started = std::time::Instant::now();
    for attempt in 0..RETRIES {
        let mut form = reqwest::multipart::Form::new()
            .text("model", "gpt-image-2")
            .text("prompt", prompt.to_string())
            .text("size", size.to_string())
            .text("n", "1");
        // Single photo → the classic `image` field (max compatibility);
        // several → repeated `image[]` parts (verified accepted by the gateway).
        let field = if refs.len() == 1 { "image" } else { "image[]" };
        for (n, png) in refs.iter().enumerate() {
            let part = reqwest::multipart::Part::bytes((*png).clone())
                .file_name(format!("ref{}.png", n + 1))
                .mime_str("image/png")?;
            form = form.part(field, part);
        }
        let res = http
            .post(&url)
            .header("Authorization", format!("Bearer {}", cfg.aurixel_api_key))
            .multipart(form)
            .timeout(Duration::from_secs(300))
            .send()
            .await;
        match res {
            Ok(r) => {
                let status = r.status().as_u16();
                if r.status().is_success() {
                    let j: Value = r.json().await.unwrap_or_default();
                    if let Some(b64) = j.pointer("/data/0/b64_json").and_then(|v| v.as_str()) {
                        return base64::engine::general_purpose::STANDARD
                            .decode(b64)
                            .map_err(|e| anyhow!("b64 decode: {}", e));
                    }
                    if let Some(u) = j.pointer("/data/0/url").and_then(|v| v.as_str()) {
                        let img = http.get(u).timeout(Duration::from_secs(60)).send().await?;
                        return Ok(img.bytes().await?.to_vec());
                    }
                    return Err(anyhow!("图生图未返回图片数据"));
                }
                let text = r.text().await.unwrap_or_default();
                last_err = format!("HTTP {} {}", status, text.chars().take(160).collect::<String>());
                if (status == 429 || status >= 500)
                    && attempt + 1 < RETRIES
                    && have_time(started, backoff(attempt))
                {
                    tokio::time::sleep(backoff(attempt)).await;
                    continue;
                }
                break;
            }
            Err(e) => {
                last_err = e.to_string();
                // Transport failure (usually an upload timeout): retry only briefly.
                if attempt + 1 < TRANSPORT_RETRIES && have_time(started, backoff(attempt)) {
                    tokio::time::sleep(backoff(attempt)).await;
                    continue;
                }
                break;
            }
        }
    }
    Err(anyhow!("图生图失败: {}", last_err))
}

pub async fn generate_image(
    http: &reqwest::Client,
    cfg: &AppConfig,
    prompt: &str,
    width: u32,
    height: u32,
    seed: Option<u64>,
) -> Result<Vec<u8>> {
    if cfg.image_provider == "aurixel" && !cfg.aurixel_api_key.is_empty() {
        return openai_compatible_image(
            http,
            "https://conduit-api.bifrostapi.net/v1",
            &cfg.aurixel_api_key,
            "gpt-image-2",
            prompt,
            width,
            height,
        )
        .await;
    }
    if cfg.image_provider == "openai" && !cfg.openai_api_key.is_empty() {
        return openai_compatible_image(
            http,
            "https://api.openai.com/v1",
            &cfg.openai_api_key,
            "gpt-image-1",
            prompt,
            width,
            height,
        )
        .await;
    }
    pollinations_image(http, prompt, width, height, seed, &cfg.pollinations_token).await
}

/// OpenAI-compatible /images/generations (returns b64_json, sometimes url).
async fn openai_compatible_image(
    http: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    width: u32,
    height: u32,
) -> Result<Vec<u8>> {
    let size = if width == height {
        "1024x1024"
    } else if width > height {
        "1536x1024"
    } else {
        "1024x1536"
    };
    let url = format!("{}/images/generations", base_url.trim_end_matches('/'));
    let mut last_err = String::new();
    let started = std::time::Instant::now();
    for attempt in 0..RETRIES {
        let res = http
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&json!({ "model": model, "prompt": prompt, "size": size, "n": 1, "quality": "high" }))
            .timeout(Duration::from_secs(240))
            .send()
            .await;
        match res {
            Ok(r) => {
                let status = r.status().as_u16();
                if r.status().is_success() {
                    let j: serde_json::Value = r.json().await.unwrap_or_default();
                    if let Some(b64) = j.pointer("/data/0/b64_json").and_then(|v| v.as_str()) {
                        return base64::engine::general_purpose::STANDARD
                            .decode(b64)
                            .map_err(|e| anyhow!("b64 decode: {}", e));
                    }
                    if let Some(u) = j.pointer("/data/0/url").and_then(|v| v.as_str()) {
                        let img = http.get(u).timeout(Duration::from_secs(60)).send().await?;
                        return Ok(img.bytes().await?.to_vec());
                    }
                    return Err(anyhow!("{} 未返回图片数据", model));
                }
                let text = r.text().await.unwrap_or_default();
                last_err = format!("HTTP {} {}", status, text.chars().take(160).collect::<String>());
                if (status == 429 || status >= 500)
                    && attempt + 1 < RETRIES
                    && have_time(started, backoff(attempt))
                {
                    tokio::time::sleep(backoff(attempt)).await;
                    continue;
                }
                break;
            }
            Err(e) => {
                last_err = e.to_string();
                if attempt + 1 < TRANSPORT_RETRIES && have_time(started, backoff(attempt)) {
                    tokio::time::sleep(backoff(attempt)).await;
                    continue;
                }
                break;
            }
        }
    }
    Err(anyhow!("文生图失败({}): {}", model, last_err))
}

async fn pollinations_image(
    http: &reqwest::Client,
    prompt: &str,
    width: u32,
    height: u32,
    seed: Option<u64>,
    token: &str,
) -> Result<Vec<u8>> {
    let mut query: Vec<(String, String)> =
        vec![("width".into(), width.to_string()), ("height".into(), height.to_string())];
    if let Some(s) = seed {
        query.push(("seed".into(), s.to_string()));
    }
    if !token.is_empty() {
        query.push(("nologo".into(), "true".into()));
        query.push(("referrer".into(), "wb-autolist".into()));
    }
    let url = format!(
        "https://image.pollinations.ai/prompt/{}",
        urlencoding::encode(prompt)
    );
    let mut last_status = 0u16;
    for attempt in 0..2 {
        let mut rb = http.get(&url).query(&query).timeout(Duration::from_secs(90));
        if !token.is_empty() {
            rb = rb.header("Authorization", format!("Bearer {}", token));
        }
        let res = rb.send().await?;
        last_status = res.status().as_u16();
        if res.status().is_success() {
            let ct = res
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/jpeg")
                .to_string();
            let bytes = res.bytes().await?.to_vec();
            if !ct.starts_with("image/") || bytes.len() < 1024 {
                return Err(anyhow!("Pollinations 返回的不是有效图片"));
            }
            return Ok(bytes);
        }
        if last_status == 402 && attempt == 0 {
            tokio::time::sleep(Duration::from_secs(6)).await;
            continue;
        }
        break;
    }
    Err(anyhow!(
        "Pollinations 文生图失败: HTTP {}（可在设置改用 Aurixel）",
        last_status
    ))
}
