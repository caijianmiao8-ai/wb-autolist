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

const AURIXEL_CHAT: &str = "https://conduit-api.bifrostapi.net/v1/chat/completions";

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
        "Товар: {}\nКатегория: {}\nКлючевые слова: {}\nЗаголовок: {}\n\nЗаполни КАК МОЖНО БОЛЬШЕ характеристик карточки Wildberries — цель максимально полная карточка (хорошие карточки в этой категории заполнены на 20+ характеристик, это поднимает товар в поиске). Верни ТОЛЬКО JSON-объект: ключ — id (строкой), значение — НА РУССКОМ.\n\nПРАВИЛА:\n- Заполняй ВСЕ текстовые (type=text) характеристики, типичные для этой категории: материал, тип, назначение, особенности, управление, комплектация, страна производства, форма, покрытие, стиль, для кого, уход и т.п. Используй стандартные, общеупотребимые значения, типичные для такого товара (так значение точно совпадёт со справочником Wildberries).\n- type=number: заполняй, только если значение СТАНДАРТНО/ТИПИЧНО для категории (например мощность типового прибора, количество секций/режимов). НЕ заполняй точный вес, габариты и размеры конкретной модели — их WB берёт из размеров упаковки. Если число неизвестно и не типовое — пропусти.\n- Для ОТКРЫТЫХ текстовых полей, где допустим произвольный текст (назначение, особенности, комплектация, материал, тип, для кого, уход и т.п.), можешь вернуть МАССИВ значений: сначала стандартное значение, затем 2-4 РЕЛЕВАНТНЫХ синонима/поисковых ключевых слова — это поднимает товар в поиске WB (как у топовых карточек). Только реально релевантное, без спама и повторов.\n- Для полей со СТРОГИМ справочником (цвет, да/нет, размеры, страна производства, бренд) верни РОВНО ОДНО стандартное значение — туда НЕ добавляй ключевые слова, иначе WB отклонит значение.\n- Пропускай только то, что реально неприменимо к этому товару.\n- Не выдумывай уникальные/выдуманные числа и коды.\n\nХарактеристики:\n{}",
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
            {"role":"system","content":"Ты — эксперт по заполнению карточек Wildberries. Качественная карточка заполнена максимально полно: чем больше релевантных характеристик заполнено стандартными значениями, тем выше карточка в поиске. Отвечай только валидным JSON-объектом."},
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
            // text characteristic → array of strings. The model sometimes packs
            // several values into one "a; b; c" string — split those so each maps
            // to its own dictionary value (a joined string is one invalid value).
            let mut xs: Vec<String> = match v {
                Value::String(s) => s
                    .split(|ch| ch == ';' || ch == '；' || ch == '\n')
                    .map(|p| p.trim().to_string())
                    .filter(|p| !p.is_empty())
                    .collect(),
                Value::Array(a) => a
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect(),
                Value::Number(n) => vec![n.to_string()],
                _ => continue,
            };
            if xs.is_empty() {
                continue;
            }
            // respect WB's per-field value limit (maxCount); too many values →
            // "имеет слишком много значений" rejection.
            if c.max_count > 0 && xs.len() > c.max_count as usize {
                xs.truncate(c.max_count as usize);
            }
            json!(xs)
        };
        out.insert(id, value);
    }
    out
}
