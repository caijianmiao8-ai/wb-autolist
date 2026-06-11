#![allow(dead_code)]
//! App configuration (ported from src/lib/config.ts).
//! Precedence: saved file > env > defaults. Secrets never leave the backend;
//! the frontend only ever sees `redact_config`.

use crate::paths::{atomic_write, quarantine_corrupt, Paths};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub wb_content_token: String,
    pub wb_prices_token: String,
    pub wb_sandbox: bool,
    pub image_provider: String, // "pollinations" | "aurixel" | "openai"
    pub openai_api_key: String,
    pub aurixel_api_key: String,
    pub aurixel_chat_model: String,
    pub pollinations_token: String,
    pub public_base_url: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            wb_content_token: String::new(),
            wb_prices_token: String::new(),
            wb_sandbox: false,
            image_provider: "pollinations".into(),
            openai_api_key: String::new(),
            aurixel_api_key: String::new(),
            aurixel_chat_model: "gpt-5.5".into(),
            pollinations_token: String::new(),
            public_base_url: String::new(),
        }
    }
}

fn set_if(field: &mut String, v: Option<String>) {
    if let Some(s) = v {
        if !s.is_empty() {
            *field = s;
        }
    }
}

fn apply_env(cfg: &mut AppConfig) {
    use std::env::var;
    set_if(&mut cfg.wb_content_token, var("WB_CONTENT_TOKEN").ok());
    set_if(&mut cfg.wb_prices_token, var("WB_PRICES_TOKEN").ok());
    if var("WB_SANDBOX").ok().as_deref() == Some("true") {
        cfg.wb_sandbox = true;
    }
    set_if(&mut cfg.image_provider, var("IMAGE_PROVIDER").ok());
    set_if(&mut cfg.openai_api_key, var("OPENAI_API_KEY").ok());
    set_if(&mut cfg.aurixel_api_key, var("AURIXEL_API_KEY").ok());
    set_if(&mut cfg.aurixel_chat_model, var("AURIXEL_CHAT_MODEL").ok());
    set_if(&mut cfg.pollinations_token, var("POLLINATIONS_TOKEN").ok());
    set_if(&mut cfg.public_base_url, var("PUBLIC_BASE_URL").ok());
}

fn apply_file(cfg: &mut AppConfig, file: &Path) {
    let txt = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(_) => return,
    };
    let v: Value = match serde_json::from_str(&txt) {
        Ok(v) => v,
        Err(_) => {
            quarantine_corrupt(file);
            return;
        }
    };
    let obj = match v.as_object() {
        Some(o) => o,
        None => return,
    };
    let s = |k: &str| obj.get(k).and_then(|x| x.as_str()).map(|s| s.to_string());
    set_if(&mut cfg.wb_content_token, s("wbContentToken"));
    set_if(&mut cfg.wb_prices_token, s("wbPricesToken"));
    if let Some(b) = obj.get("wbSandbox").and_then(|x| x.as_bool()) {
        cfg.wb_sandbox = b;
    }
    set_if(&mut cfg.image_provider, s("imageProvider"));
    set_if(&mut cfg.openai_api_key, s("openaiApiKey"));
    set_if(&mut cfg.aurixel_api_key, s("aurixelApiKey"));
    set_if(&mut cfg.aurixel_chat_model, s("aurixelChatModel"));
    set_if(&mut cfg.pollinations_token, s("pollinationsToken"));
    set_if(&mut cfg.public_base_url, s("publicBaseUrl"));
}

pub fn get_config(paths: &Paths) -> AppConfig {
    let mut cfg = AppConfig::default();
    apply_env(&mut cfg);
    apply_file(&mut cfg, &paths.config());
    // Defensive: tokens often arrive with trailing whitespace/newline from a
    // paste, which corrupts the Authorization header. Strip it.
    cfg.wb_content_token = cfg.wb_content_token.trim().to_string();
    cfg.wb_prices_token = cfg.wb_prices_token.trim().to_string();
    cfg.aurixel_api_key = cfg.aurixel_api_key.trim().to_string();
    cfg.openai_api_key = cfg.openai_api_key.trim().to_string();
    cfg
}

pub fn save_config(paths: &Paths, patch: &Value) -> AppConfig {
    let file = paths.config();
    let mut obj = std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    if let Some(p) = patch.as_object() {
        for (k, v) in p {
            obj.insert(k.clone(), v.clone());
        }
    }
    let bytes = serde_json::to_vec_pretty(&Value::Object(obj)).unwrap_or_default();
    let _ = atomic_write(&file, &bytes);
    get_config(paths)
}

pub fn prices_token(cfg: &AppConfig) -> String {
    if !cfg.wb_prices_token.is_empty() {
        cfg.wb_prices_token.clone()
    } else {
        cfg.wb_content_token.clone()
    }
}

/// Never leak secrets to the client — booleans + non-secret fields only.
pub fn redact_config(cfg: &AppConfig) -> Value {
    let dry =
        std::env::var("WB_DRY_RUN").ok().as_deref() == Some("true") || cfg.wb_content_token.is_empty();
    json!({
        "authEnabled": false,
        "dryRun": dry,
        "wbContentTokenSet": !cfg.wb_content_token.is_empty(),
        "wbPricesTokenSet": !cfg.wb_prices_token.is_empty(),
        "wbSandbox": cfg.wb_sandbox,
        "imageProvider": cfg.image_provider,
        "openaiKeySet": !cfg.openai_api_key.is_empty(),
        "aurixelKeySet": !cfg.aurixel_api_key.is_empty(),
        "aurixelChatModel": cfg.aurixel_chat_model,
        "pollinationsTokenSet": !cfg.pollinations_token.is_empty(),
        "publicBaseUrl": cfg.public_base_url,
    })
}
