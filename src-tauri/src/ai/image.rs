#![allow(dead_code)]
//! Text-to-image (ported from src/lib/ai/image.ts). Aurixel (gpt-image-2) is
//! the default; OpenAI (gpt-image-1) and keyless Pollinations are fallbacks.

use crate::config::AppConfig;
use anyhow::{anyhow, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::time::Duration;

const AURIXEL_BASE: &str = "https://conduit-api.aurixel.ai/v1";

/// Image-to-image (edit): keep the input product, restyle per the prompt.
/// Aurixel gpt-image-2 `/images/edits` — multipart form. Slow (~80-150s).
pub async fn edit_image(
    http: &reqwest::Client,
    cfg: &AppConfig,
    base_png: &[u8],
    prompt: &str,
    size: &str,
) -> Result<Vec<u8>> {
    if cfg.aurixel_api_key.is_empty() {
        return Err(anyhow!("图生图需要 Aurixel Key"));
    }
    let url = format!("{}/images/edits", AURIXEL_BASE);
    let mut last_err = String::new();
    for attempt in 0..3 {
        let part = reqwest::multipart::Part::bytes(base_png.to_vec())
            .file_name("in.png")
            .mime_str("image/png")?;
        let form = reqwest::multipart::Form::new()
            .text("model", "gpt-image-2")
            .text("prompt", prompt.to_string())
            .text("size", size.to_string())
            .text("n", "1")
            .part("image", part);
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
                if (status == 429 || status >= 500) && attempt < 2 {
                    tokio::time::sleep(Duration::from_secs(10 * (attempt + 1))).await;
                    continue;
                }
                break;
            }
            Err(e) => {
                last_err = e.to_string();
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_secs(8)).await;
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
            "https://conduit-api.aurixel.ai/v1",
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
    for attempt in 0..3 {
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
                if (status == 429 || status >= 500) && attempt < 2 {
                    tokio::time::sleep(Duration::from_secs(10 * (attempt + 1))).await;
                    continue;
                }
                break;
            }
            Err(e) => {
                last_err = e.to_string();
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_secs(10 * (attempt + 1))).await;
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
