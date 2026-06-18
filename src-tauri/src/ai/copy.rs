#![allow(dead_code)]
//! Russian listing copy via Aurixel chat (ported from src/lib/ai/copy.ts).
//! Strict json_schema guarantees every field; a deterministic template is the
//! no-key fallback so the pipeline always works.

use crate::config::AppConfig;
use crate::types::ProductCopy;
use crate::util::clamp_len;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::time::Duration;

const AURIXEL_CHAT: &str = "https://conduit-api.aurixel.ai/v1/chat/completions";

/// Returns (copy, ai_used). ai_used=false means the AI call failed and we fell
/// back to a deterministic template — the caller should surface that so the user
/// isn't misled into thinking boilerplate is AI-written SEO copy.
pub async fn generate_copy(
    http: &reqwest::Client,
    cfg: &AppConfig,
    product_name: &str,
    keywords: &[String],
    brand: Option<&str>,
) -> (ProductCopy, bool) {
    if !cfg.aurixel_api_key.is_empty() {
        let model = if cfg.aurixel_chat_model.is_empty() {
            "gpt-5.5"
        } else {
            &cfg.aurixel_chat_model
        };
        if let Ok(mut c) =
            generate_with_aurixel(http, &cfg.aurixel_api_key, model, product_name, keywords, brand)
                .await
        {
            // Guard the two most visible fields against untranslated Chinese — the
            // headline is the worst place to leak CJK onto a live WB card.
            if has_cjk(&c.title) {
                c.title = template_copy(product_name, keywords, brand).title;
            }
            if has_cjk(&c.description) {
                let cleaned: String = c
                    .description
                    .lines()
                    .filter(|l| !has_cjk(l))
                    .collect::<Vec<_>>()
                    .join("\n");
                c.description = if cleaned.trim().is_empty() {
                    template_copy(product_name, keywords, brand).description
                } else {
                    cleaned
                };
            }
            return (c, true);
        }
    }
    (template_copy(product_name, keywords, brand), false)
}

fn copy_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "title": { "type": "string", "description": "Продающий заголовок товара для карточки WB, до 60 символов" },
            "description": { "type": "string", "description": "SEO-описание товара на русском, 600-1500 символов, с ключевыми словами" },
            "bullets": { "type": "array", "items": { "type": "string" }, "description": "4-6 ключевых преимуществ товара (буллеты) на русском" },
            "brand": { "type": "string", "description": "Короткое название бренда (латиница)" },
            "keywords": { "type": "array", "items": { "type": "string" }, "description": "8-15 поисковых ключевых слов на русском" },
            "categoryHint": { "type": "string", "description": "Точное название категории/предмета WB на русском (например: 'Платья', 'Наушники')" },
            "imagePrompt": { "type": "string", "description": "MUST be in ENGLISH. A rich, detailed prompt for a professional studio e-commerce product photo of THIS specific product. 1-3 sentences, never empty." }
        },
        "required": ["title","description","bullets","brand","keywords","categoryHint","imagePrompt"]
    })
}

fn prompt(product_name: &str, keywords: &[String], brand: Option<&str>) -> String {
    let mut p = String::new();
    p.push_str("Ты — эксперт по карточкам товаров на маркетплейсе Wildberries. ");
    p.push_str("Создай продающий контент и верни СТРОГО валидный JSON с полями: ");
    p.push_str("title (заголовок ≤60 символов), description (SEO-описание на русском 600-1500 символов), ");
    p.push_str("bullets (массив 4-6 преимуществ), brand (латиница), keywords (массив 8-15 ключевых слов на русском), ");
    p.push_str("categoryHint (точное название категории/предмета Wildberries на русском, напр. \"Наушники\", \"Платья\"), ");
    p.push_str("imagePrompt (detailed ENGLISH prompt for a professional studio product photo).\n");
    p.push_str("ВАЖНО: title, description, bullets, keywords, categoryHint — СТРОГО на русском языке. Переведи на русский ЛЮБЫЕ иностранные слова (в т.ч. китайские); НЕ оставляй китайские иероглифы.\n\n");
    p.push_str(&format!("Товар (может быть на любом языке): {}\n", product_name));
    p.push_str(&format!("Ключевые слова: {}\n", keywords.join(", ")));
    if let Some(b) = brand {
        if !b.is_empty() {
            p.push_str(&format!("Бренд: {}\n", b));
        }
    }
    p
}

async fn generate_with_aurixel(
    http: &reqwest::Client,
    api_key: &str,
    model: &str,
    product_name: &str,
    keywords: &[String],
    brand: Option<&str>,
) -> Result<ProductCopy> {
    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": "You write Wildberries marketplace product listings in Russian. Respond with valid JSON only." },
            { "role": "user", "content": prompt(product_name, keywords, brand) }
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": "wb_listing", "strict": true, "schema": copy_schema() }
        }
    });
    let content = chat(http, api_key, &body, 90).await?;
    let parsed: Value = serde_json::from_str(&extract_json(&content)).unwrap_or(json!({}));
    let mut result = normalize(&parsed, brand);

    // The combined call sometimes returns an empty imagePrompt — backfill with a
    // focused single-field call.
    if result
        .image_prompt
        .as_ref()
        .map(|p| p.trim().chars().count() < 25)
        .unwrap_or(true)
    {
        if let Ok(p) =
            aurixel_image_prompt(http, api_key, model, product_name, keywords, &result).await
        {
            result.image_prompt = Some(p);
        }
    }
    Ok(result)
}

async fn aurixel_image_prompt(
    http: &reqwest::Client,
    api_key: &str,
    model: &str,
    product_name: &str,
    keywords: &[String],
    copy: &ProductCopy,
) -> Result<String> {
    let user = format!(
        "Write a rich, detailed ENGLISH prompt for a professional studio e-commerce product photo of THIS product. Describe the product, materials, color, key features, camera angle, lighting, and a clean white seamless background.\nProduct: {}\nKeywords: {}\nListing title (ru): {}\nCategory (ru): {}",
        product_name,
        keywords.join(", "),
        copy.title,
        copy.category_hint
    );
    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": "You write detailed English prompts for AI product photography. JSON only." },
            { "role": "user", "content": user }
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": "image_prompt", "strict": true, "schema": {
                "type": "object", "additionalProperties": false,
                "properties": { "imagePrompt": { "type": "string" } },
                "required": ["imagePrompt"]
            } }
        }
    });
    let content = chat(http, api_key, &body, 60).await?;
    let obj: Value = serde_json::from_str(&extract_json(&content)).unwrap_or(json!({}));
    let p = obj
        .get("imagePrompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if p.is_empty() {
        return Err(anyhow!("empty"));
    }
    Ok(p)
}

async fn chat(http: &reqwest::Client, api_key: &str, body: &Value, timeout_s: u64) -> Result<String> {
    let res = http
        .post(AURIXEL_CHAT)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(body)
        .timeout(Duration::from_secs(timeout_s))
        .send()
        .await?;
    if !res.status().is_success() {
        let s = res.status();
        let t = res.text().await.unwrap_or_default();
        return Err(anyhow!("Aurixel chat 失败: HTTP {} {}", s, t.chars().take(200).collect::<String>()));
    }
    let j: Value = res.json().await?;
    Ok(j.pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("{}")
        .to_string())
}

/// Pull the first {...} JSON object out of an LLM response.
fn extract_json(s: &str) -> String {
    let start = s.find('{');
    let end = s.rfind('}');
    match (start, end) {
        (Some(a), Some(b)) if b > a => s[a..=b].to_string(),
        _ => s.to_string(),
    }
}

fn str_field(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn arr_field(v: &Value, k: &str) -> Vec<String> {
    v.get(k)
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|i| i.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// True if the string contains CJK (Chinese) characters — used to drop any
/// keyword the model failed to translate to Russian.
fn has_cjk(s: &str) -> bool {
    s.chars()
        .any(|c| matches!(c, '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{f900}'..='\u{faff}'))
}

fn normalize(c: &Value, brand_in: Option<&str>) -> ProductCopy {
    let mut bullets: Vec<String> = arr_field(c, "bullets")
        .into_iter()
        .filter(|b| !has_cjk(b))
        .collect();
    bullets.truncate(6);
    let mut keywords: Vec<String> = arr_field(c, "keywords")
        .into_iter()
        .filter(|k| !has_cjk(k))
        .collect();
    keywords.truncate(20);
    let brand = brand_in
        .filter(|b| !b.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            let b = str_field(c, "brand");
            if b.is_empty() {
                "AUTO".to_string()
            } else {
                b
            }
        });
    let brand: String = brand.chars().take(50).collect();
    ProductCopy {
        title: clamp_len(&str_field(c, "title"), 60),
        description: clamp_len(&str_field(c, "description"), 2000),
        bullets,
        brand,
        keywords,
        category_hint: str_field(c, "categoryHint"),
        image_prompt: Some(str_field(c, "imagePrompt")),
    }
}

fn template_copy(product_name: &str, keywords: &[String], brand: Option<&str>) -> ProductCopy {
    let name = product_name.trim();
    let kw: Vec<String> = keywords.iter().filter(|k| !k.is_empty()).cloned().collect();
    let brand = brand
        .map(|b| b.trim())
        .filter(|b| !b.is_empty())
        .unwrap_or("AUTO")
        .to_string();
    let mut title_parts = vec![name.to_string()];
    title_parts.extend(kw.iter().take(2).cloned());
    let title = clamp_len(&title_parts.into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" "), 60);

    let mut bullets = vec![format!("Высокое качество — {}", name)];
    bullets.extend(kw.iter().take(4).map(|k| format!("Преимущество: {}", k)));
    bullets.push("Быстрая доставка Wildberries".to_string());
    bullets.truncate(6);

    let description = format!(
        "{} — отличный выбор для тех, кто ценит качество. {}Товар сочетает функциональность и привлекательный дизайн. Закажите {} на Wildberries с быстрой доставкой.",
        name,
        if kw.is_empty() { String::new() } else { format!("Ключевые особенности: {}. ", kw.join(", ")) },
        name
    );
    let image_prompt = format!(
        "professional studio e-commerce product photo of {}{}, white background, soft lighting, high detail, centered",
        name,
        if kw.is_empty() { String::new() } else { format!(", {}", kw.join(", ")) }
    );
    ProductCopy {
        title,
        description: clamp_len(&description, 2000),
        bullets,
        brand: brand.chars().take(50).collect(),
        keywords: if kw.is_empty() { vec![name.to_string()] } else { kw },
        category_hint: name.to_string(),
        image_prompt: Some(image_prompt),
    }
}
