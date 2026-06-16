#![allow(dead_code)]
//! Turn a raw spreadsheet into structured product inputs (ported from
//! src/lib/ai/organize.ts). Aurixel chat with a heuristic fallback.

use crate::config::AppConfig;
use crate::types::ListingInput;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::time::Duration;

const AURIXEL_CHAT: &str = "https://conduit-api.aurixel.ai/v1/chat/completions";

pub async fn organize_rows(
    http: &reqwest::Client,
    cfg: &AppConfig,
    rows: Vec<Vec<String>>,
) -> Vec<ListingInput> {
    let trimmed: Vec<Vec<String>> = rows
        .into_iter()
        .filter(|r| r.iter().any(|c| !c.trim().is_empty()))
        .collect();
    if trimmed.is_empty() {
        return vec![];
    }
    if !cfg.aurixel_api_key.is_empty() {
        if let Ok(v) = organize_with_aurixel(http, cfg, &trimmed).await {
            return v;
        }
    }
    heuristic_organize(&trimmed)
}

fn organize_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "products": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "productName": { "type": "string", "description": "商品名（任意语言原样保留）" },
                        "keywords": { "type": "array", "items": { "type": "string" }, "description": "关键字/卖点，从属性列提取" },
                        "price": { "type": "number", "description": "价格(数字，卢布)；无则 0" },
                        "discount": { "type": "number", "description": "折扣百分比(0-99)；无则 0" },
                        "brand": { "type": "string", "description": "品牌；无则空字符串" }
                    },
                    "required": ["productName","keywords","price","discount","brand"]
                }
            }
        },
        "required": ["products"]
    })
}

async fn organize_with_aurixel(
    http: &reqwest::Client,
    cfg: &AppConfig,
    rows: &[Vec<String>],
) -> Result<Vec<ListingInput>> {
    let model = if cfg.aurixel_chat_model.is_empty() {
        "gpt-5.5"
    } else {
        &cfg.aurixel_chat_model
    };
    let table: String = serde_json::to_string(rows).unwrap_or_default();
    let table = table.chars().take(12000).collect::<String>();
    let user = format!(
        "下面是一个商品表格（可能含表头，列顺序/语言/标签不固定）。把每个商品行整理成结构化字段：productName(商品名), keywords(关键字数组), price(数字,无则0), discount(0-99,无则0), brand(无则空)。智能识别哪一列是名称/价格/折扣/品牌，其余有用文本归入 keywords。跳过表头行。\n\n表格(JSON):\n{}",
        table
    );
    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": "You normalize messy product spreadsheets into structured rows. JSON only." },
            { "role": "user", "content": user }
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": "products", "strict": true, "schema": organize_schema() }
        }
    });
    let res = http
        .post(AURIXEL_CHAT)
        .header("Authorization", format!("Bearer {}", cfg.aurixel_api_key))
        .json(&body)
        .timeout(Duration::from_secs(90))
        .send()
        .await?;
    if !res.status().is_success() {
        let s = res.status();
        let t = res.text().await.unwrap_or_default();
        return Err(anyhow!("HTTP {} {}", s, t.chars().take(200).collect::<String>()));
    }
    let j: Value = res.json().await?;
    let content = j
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("{}");
    let start = content.find('{');
    let end = content.rfind('}');
    let slice = match (start, end) {
        (Some(a), Some(b)) if b > a => &content[a..=b],
        _ => content,
    };
    let parsed: Value = serde_json::from_str(slice).unwrap_or(json!({}));
    let out: Vec<ListingInput> = parsed
        .get("products")
        .and_then(|p| p.as_array())
        .map(|a| a.iter().map(clean_value).collect())
        .unwrap_or_default();
    Ok(out.into_iter().filter(|p| !p.product_name.is_empty()).collect())
}

fn is_number(s: &str) -> bool {
    let mut chars = s.chars().peekable();
    let mut has_digit = false;
    let mut seen_sep = false;
    while let Some(&c) = chars.peek() {
        if c.is_ascii_digit() {
            has_digit = true;
            chars.next();
        } else if (c == '.' || c == ',') && !seen_sep && has_digit {
            seen_sep = true;
            chars.next();
            // require at least one digit after the separator
            if !chars.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                return false;
            }
        } else {
            return false;
        }
    }
    has_digit
}

fn parse_number(s: &str) -> f64 {
    s.replace(',', ".").parse::<f64>().unwrap_or(0.0)
}

fn heuristic_organize(rows: &[Vec<String>]) -> Vec<ListingInput> {
    let looks_header = rows.len() > 1
        && rows[0]
            .iter()
            .all(|c| !c.is_empty() && c.parse::<f64>().is_err() && c.chars().count() < 20);
    let body = if looks_header { &rows[1..] } else { rows };

    body.iter()
        .filter_map(|r| {
            let cells: Vec<String> = r.iter().map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect();
            if cells.is_empty() {
                return None;
            }
            let nums: Vec<f64> = cells.iter().filter(|c| is_number(c)).map(|c| parse_number(c)).collect();
            let texts: Vec<String> = cells.iter().filter(|c| !is_number(c)).cloned().collect();
            let product_name = texts.first().cloned().unwrap_or_else(|| cells[0].clone());
            let keywords: Vec<String> = texts.iter().skip(1).take(8).cloned().collect();
            let price = nums.iter().cloned().find(|n| *n >= 1.0).unwrap_or(0.0);
            let discount = nums
                .iter()
                .cloned()
                .find(|n| *n > 0.0 && *n <= 99.0 && *n != price)
                .unwrap_or(0.0);
            Some(clean_parts(product_name, keywords, price, discount, String::new()))
        })
        .filter(|p| !p.product_name.is_empty())
        .collect()
}

fn clean_value(v: &Value) -> ListingInput {
    let name = v.get("productName").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let keywords: Vec<String> = v
        .get("keywords")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|i| i.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    let price = v.get("price").and_then(|x| x.as_f64()).unwrap_or(0.0);
    let discount = v.get("discount").and_then(|x| x.as_f64()).unwrap_or(0.0);
    let brand = v.get("brand").and_then(|x| x.as_str()).unwrap_or("").to_string();
    clean_parts(name, keywords, price, discount, brand)
}

fn clean_parts(
    product_name: String,
    keywords: Vec<String>,
    price: f64,
    discount: f64,
    brand: String,
) -> ListingInput {
    let name: String = product_name.trim().chars().take(200).collect();
    let keywords: Vec<String> = keywords
        .into_iter()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .take(20)
        .collect();
    let price = if price > 0.0 { price.round() } else { 0.0 };
    let discount = discount.clamp(0.0, 99.0).round();
    let brand: String = brand.trim().chars().take(50).collect();
    ListingInput {
        product_name: name,
        keywords,
        price,
        discount,
        brand: if brand.is_empty() { None } else { Some(brand) },
        custom_prompt: None,
        image_count: None,
        base_photos: vec![],
        // batch/Excel rows carry no per-item dims → 0 makes generate_listing fall
        // back to the seller's configured default package.
        length: 0,
        width: 0,
        height: 0,
        weight: 0.0,
    }
}
