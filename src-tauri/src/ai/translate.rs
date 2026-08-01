#![allow(dead_code)]
//! GPT-5.5 calibration of WB characteristic NAMES (labels) ru→zh. WB's own
//! `locale=zh` is machine-translated and mangles common attributes (корпус→
//! "房屋", Питание→"食物", Описание→"说明书", Баркод→"产品最小的出库单位"…).
//! We ask gpt-5.5 once for the correct concise Chinese, then the caller caches it
//! locally — so a name is translated at most ONCE, ever, and new categories only
//! pay for their genuinely-new names.

use crate::config::AppConfig;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

const AURIXEL_CHAT: &str = "https://conduit-api.bifrostapi.net/v1/chat/completions";

/// Translate characteristic names. `items` = (ru_name, wb_machine_zh_hint).
/// Returns ru_name(EXACT, as given) → concise zh, for the ones it produced.
/// Empty on no key / network failure / parse failure (caller degrades gracefully).
pub async fn calibrate_charc_names(
    http: &reqwest::Client,
    cfg: &AppConfig,
    items: &[(String, String)],
) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    if cfg.aurixel_api_key.is_empty() || items.is_empty() {
        return out;
    }

    let mut lines = String::new();
    for (ru, wb) in items {
        lines.push_str(&format!(
            "- \"{}\"（WB机翻参考：{}）\n",
            ru,
            if wb.trim().is_empty() { "无" } else { wb.trim() }
        ));
    }
    let user = format!(
        "把下列 Wildberries 商品「属性名（特征名标签）」从俄语翻译成简洁、地道的中文标签。\n\
         WB 自带的中文是机器翻译、常出错（如 Материал корпуса→\"房屋材料\"应为\"外壳材料\"；\
         Питание→\"食物\"应为\"供电方式\"；Описание→\"说明书\"应为\"商品描述\"；Баркод→应为\"条形码\"），\
         仅作参考，一切以准确为准。\n\
         要求：① 只翻译\"名称\"本身，不要翻译取值；② 每个尽量短（是标签，不是句子）；\
         ③ 计量单位/已是缩写或代码的（如 ИКПУ、NTIN、OZON、ТН ВЭД）保持原样或用通用译名；\
         ④ 严格只返回一个 JSON 对象：键 = 俄语原名（与下方完全一致，原样照抄），值 = 中文。\n\n\
         属性名：\n{}",
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
            {"role":"system","content":"你是把 Wildberries 商品属性名从俄语翻译成简洁中文标签的专家。只输出一个有效的 JSON 对象，键为俄语原名、值为中文，别的什么都不要输出。"},
            {"role":"user","content": user}
        ],
        "response_format": {"type":"json_object"}
    });

    let resp = http
        .post(AURIXEL_CHAT)
        .header("Authorization", format!("Bearer {}", cfg.aurixel_api_key))
        .json(&body)
        .timeout(Duration::from_secs(60))
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
    if let Some(obj) = parsed.as_object() {
        for (k, v) in obj {
            if let Some(s) = v.as_str() {
                let s = s.trim();
                // guard against the model echoing the Russian or returning junk
                if !s.is_empty() && s.chars().count() <= 40 {
                    out.insert(k.clone(), s.to_string());
                }
            }
        }
    }
    out
}
