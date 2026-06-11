#![allow(dead_code)]
//! AI-fill of category characteristics. WB rarely marks anything `required`, but
//! a quality card fills the popular/relevant characteristics (color, material,
//! model, compatibility…). We ask the model for values given the product +
//! the category's characteristic list, typed per charcType (4 = number).

use crate::config::AppConfig;
use crate::wb::types::WbCharacteristic;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

const AURIXEL_CHAT: &str = "https://conduit-api.aurixel.ai/v1/chat/completions";

/// Returns charcID → typed value (number for charcType 4, else array-of-string).
pub async fn fill_characteristics(
    http: &reqwest::Client,
    cfg: &AppConfig,
    product_name: &str,
    keywords: &[String],
    title: &str,
    category: &str,
    charcs: &[WbCharacteristic],
) -> HashMap<i64, Value> {
    let mut out: HashMap<i64, Value> = HashMap::new();
    if cfg.aurixel_api_key.is_empty() || charcs.is_empty() {
        return out;
    }

    let mut lines = String::new();
    for c in charcs {
        let kind = if c.charc_type == 4 { "number" } else { "text" };
        let unit = if c.unit_name.is_empty() {
            String::new()
        } else {
            format!(" unit={}", c.unit_name)
        };
        lines.push_str(&format!("- id={} \"{}\" type={}{}\n", c.charc_id, c.name, kind, unit));
    }
    let user = format!(
        "Товар: {}\nКатегория: {}\nКлючевые слова: {}\nЗаголовок: {}\n\nЗаполни значения характеристик карточки Wildberries. Верни ТОЛЬКО JSON-объект: ключ — id (строкой), значение — подходящее значение НА РУССКОМ. Для type=number верни число. Для type=text — короткую строку или массив строк. ПРОПУСТИ (не включай в ответ) характеристики, которые неприменимы или требуют точных данных, которых ты не знаешь (точный вес, размеры, мощность — пропусти, если не уверен). Не выдумывай числа.\n\nХарактеристики:\n{}",
        product_name,
        category,
        keywords.join(", "),
        title,
        lines
    );
    let model = if cfg.aurixel_chat_model.is_empty() {
        "gpt-5.5"
    } else {
        &cfg.aurixel_chat_model
    };
    let body = json!({
        "model": model,
        "messages": [
            {"role":"system","content":"Ты заполняешь характеристики карточек товаров Wildberries. Отвечай только валидным JSON-объектом."},
            {"role":"user","content": user}
        ],
        "response_format": {"type":"json_object"}
    });

    let resp = http
        .post(AURIXEL_CHAT)
        .header("Authorization", format!("Bearer {}", cfg.aurixel_api_key))
        .json(&body)
        .timeout(Duration::from_secs(90))
        .send()
        .await;
    let content = match resp {
        Ok(r) if r.status().is_success() => {
            let j: Value = r.json().await.unwrap_or(json!({}));
            j.pointer("/choices/0/message/content")
                .and_then(|v| v.as_str())
                .unwrap_or("{}")
                .to_string()
        }
        _ => return out,
    };

    let slice = match (content.find('{'), content.rfind('}')) {
        (Some(a), Some(b)) if b > a => &content[a..=b],
        _ => return out,
    };
    let parsed: Value = match serde_json::from_str(slice) {
        Ok(v) => v,
        Err(_) => return out,
    };
    let obj = match parsed.as_object() {
        Some(o) => o,
        None => return out,
    };

    let by_id: HashMap<i64, &WbCharacteristic> = charcs.iter().map(|c| (c.charc_id, c)).collect();
    for (k, v) in obj {
        let id: i64 = match k.parse() {
            Ok(i) => i,
            Err(_) => continue,
        };
        let c = match by_id.get(&id) {
            Some(c) => *c,
            None => continue,
        };
        if v.is_null() {
            continue;
        }
        let value = if c.charc_type == 4 {
            // numeric characteristic → a bare number
            match v {
                Value::Number(n) => Value::Number(n.clone()),
                Value::String(s) => match s.trim().parse::<f64>() {
                    Ok(f) => json!(f),
                    Err(_) => continue,
                },
                Value::Array(a) => match a.first() {
                    Some(Value::Number(n)) => Value::Number(n.clone()),
                    Some(Value::String(s)) => match s.trim().parse::<f64>() {
                        Ok(f) => json!(f),
                        Err(_) => continue,
                    },
                    _ => continue,
                },
                _ => continue,
            }
        } else {
            // text characteristic → array of strings
            match v {
                Value::String(s) => {
                    let s = s.trim();
                    if s.is_empty() {
                        continue;
                    }
                    json!([s])
                }
                Value::Array(a) => {
                    let mut xs: Vec<String> = a
                        .iter()
                        .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                        .filter(|s| !s.is_empty())
                        .collect();
                    if xs.is_empty() {
                        continue;
                    }
                    // respect WB's per-field value limit (maxCount); too many
                    // values → "имеет слишком много значений" rejection.
                    if c.max_count > 0 && xs.len() > c.max_count as usize {
                        xs.truncate(c.max_count as usize);
                    }
                    json!(xs)
                }
                Value::Number(n) => json!([n.to_string()]),
                _ => continue,
            }
        };
        out.insert(id, value);
    }
    out
}
