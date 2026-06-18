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
    /// FBS warehouse used for auto-stock on publish + the management panel's
    /// default selection. 0 = not chosen yet.
    pub default_warehouse_id: i64,
    /// Quantity to set when auto-stocking a freshly-published card / quick refill.
    pub default_stock: i64,
    /// Whether publish should set stock automatically once the card is created.
    pub auto_stock: bool,
    /// Seller's typical package: dimensions (cm) + gross weight (kg). Used when a
    /// listing doesn't carry its own (batch/Excel) and to pre-fill the workbench.
    /// WB bills logistics/storage on these, so the defaults are a starting point
    /// the seller MUST adjust — never a substitute for real measurements.
    #[serde(default)]
    pub default_length: i64,
    #[serde(default)]
    pub default_width: i64,
    #[serde(default)]
    pub default_height: i64,
    #[serde(default)]
    pub default_weight: f64,
    /// Editable image-prompt templates. None = use the built-in defaults.
    #[serde(default)]
    pub image_templates: Option<crate::templates::ImageTemplates>,
    /// True when the keychain couldn't be read this load (NOT persisted). Lets the
    /// publish path refuse rather than silently degrade to dry-run with an empty
    /// token that the user believes is configured.
    #[serde(skip)]
    pub kc_error: bool,
}

/// The templates actually in effect (user override, else built-in defaults).
pub fn active_templates(cfg: &AppConfig) -> crate::templates::ImageTemplates {
    cfg.image_templates
        .clone()
        .unwrap_or_else(crate::templates::built_in_defaults)
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
            default_warehouse_id: 0,
            default_stock: 99,
            // Safe default OFF: auto-stocking silently puts real FBS units on a
            // brand-new card; make it an explicit opt-in in Settings.
            auto_stock: false,
            default_length: 20,
            default_width: 15,
            default_height: 5,
            default_weight: 0.3,
            image_templates: None,
            kc_error: false,
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
    if let Some(n) = obj.get("defaultWarehouseId").and_then(|x| x.as_i64()) {
        cfg.default_warehouse_id = n;
    }
    if let Some(n) = obj.get("defaultStock").and_then(|x| x.as_i64()) {
        cfg.default_stock = n;
    }
    if let Some(b) = obj.get("autoStock").and_then(|x| x.as_bool()) {
        cfg.auto_stock = b;
    }
    if let Some(n) = obj.get("defaultLength").and_then(|x| x.as_i64()) {
        cfg.default_length = n;
    }
    if let Some(n) = obj.get("defaultWidth").and_then(|x| x.as_i64()) {
        cfg.default_width = n;
    }
    if let Some(n) = obj.get("defaultHeight").and_then(|x| x.as_i64()) {
        cfg.default_height = n;
    }
    if let Some(n) = obj.get("defaultWeight").and_then(|x| x.as_f64()) {
        cfg.default_weight = n;
    }
    if let Some(v) = obj.get("imageTemplates") {
        match serde_json::from_value::<crate::templates::ImageTemplates>(v.clone()) {
            Ok(t) => cfg.image_templates = Some(t),
            // Don't silently lose the user's edits without a trace — log it; the
            // app falls back to built-in defaults so generation still works.
            Err(e) => eprintln!("⚠ imageTemplates 解析失败，已回退内置默认: {}", e),
        }
    }
}

// ── Secret storage: OS keychain instead of plaintext config.json ──
// macOS Keychain / Windows Credential Manager / Linux secret-service. Secrets
// never sit on disk in cleartext (mitigates shared-PC / backup / malware reads).
// All ops degrade gracefully: if the keychain is unavailable we fall back to the
// old plaintext-in-json behavior rather than losing the user's tokens.
const KEYCHAIN_SERVICE: &str = "com.wbautolist.app";

/// (camelCase json key) of the fields kept in the keychain, not in config.json.
const SECRET_KEYS: [&str; 5] = [
    "wbContentToken",
    "wbPricesToken",
    "aurixelApiKey",
    "openaiApiKey",
    "pollinationsToken",
];

/// Tri-state read: a genuine absence must be told apart from a keychain ERROR
/// (locked / access denied / backend hiccup). Conflating them risks (a) wiping a
/// not-yet-migrated plaintext, or (b) treating a transient error as "logged out".
enum KcRead {
    Found(String),
    Absent,
    Error,
}

fn kc_read(account: &str) -> KcRead {
    let entry = match keyring::Entry::new(KEYCHAIN_SERVICE, account) {
        Ok(e) => e,
        Err(_) => return KcRead::Error,
    };
    match entry.get_password() {
        Ok(s) if !s.is_empty() => KcRead::Found(s),
        Ok(_) => KcRead::Absent, // empty stored value = effectively no secret
        Err(keyring::Error::NoEntry) => KcRead::Absent,
        Err(_) => KcRead::Error,
    }
}

fn kc_set(account: &str, val: &str) -> bool {
    match keyring::Entry::new(KEYCHAIN_SERVICE, account) {
        Ok(e) => e.set_password(val).is_ok(),
        Err(_) => false,
    }
}

fn kc_del(account: &str) {
    if let Ok(e) = keyring::Entry::new(KEYCHAIN_SERVICE, account) {
        let _ = e.delete_credential();
    }
}

/// Overlay one secret from the keychain. Keychain value wins. If it's genuinely
/// ABSENT but legacy plaintext (json/env) is present, migrate it in and record
/// the account so ONLY that key is stripped from json. On a keychain ERROR, do
/// nothing — keep whatever plaintext we have and never strip (no data loss, no
/// false logout via a partial-migration wipe).
fn resolve_secret(
    field: &mut String,
    account: &'static str,
    migrated: &mut Vec<&'static str>,
    errored: &mut Vec<&'static str>,
) {
    match kc_read(account) {
        KcRead::Found(v) => *field = v,
        KcRead::Absent => {
            let plain = field.trim().to_string();
            if !plain.is_empty() && kc_set(account, &plain) {
                // verify the write is actually readable before allowing the
                // plaintext to be stripped — otherwise we'd risk losing it.
                if matches!(kc_read(account), KcRead::Found(_)) {
                    migrated.push(account);
                }
            }
        }
        KcRead::Error => {
            eprintln!("⚠ 钥匙串读取失败({})，本次回退使用本地值", account);
            errored.push(account);
        }
    }
}

/// Remove ONLY the given (successfully-migrated) secret keys from config.json, so
/// no cleartext copy lingers — never touches keys that failed to migrate.
fn strip_secrets_from_file(file: &Path, accounts: &[&str]) {
    let txt = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(_) => return,
    };
    let mut v: Value = match serde_json::from_str(&txt) {
        Ok(v) => v,
        Err(_) => return,
    };
    if let Some(obj) = v.as_object_mut() {
        let mut changed = false;
        for k in accounts {
            if obj.remove(*k).is_some() {
                changed = true;
            }
        }
        if changed {
            let _ = atomic_write(file, &serde_json::to_vec_pretty(&v).unwrap_or_default());
        }
    }
}

pub fn get_config(paths: &Paths) -> AppConfig {
    let mut cfg = AppConfig::default();
    apply_env(&mut cfg);
    apply_file(&mut cfg, &paths.config());
    // Secrets live in the OS keychain — overlay them, migrating any legacy
    // plaintext from config.json/env on first run, then strip ONLY the cleartext
    // we successfully moved (per-field, so a partial migration loses nothing).
    let mut migrated: Vec<&'static str> = vec![];
    let mut errored: Vec<&'static str> = vec![];
    resolve_secret(&mut cfg.wb_content_token, "wbContentToken", &mut migrated, &mut errored);
    resolve_secret(&mut cfg.wb_prices_token, "wbPricesToken", &mut migrated, &mut errored);
    resolve_secret(&mut cfg.aurixel_api_key, "aurixelApiKey", &mut migrated, &mut errored);
    resolve_secret(&mut cfg.openai_api_key, "openaiApiKey", &mut migrated, &mut errored);
    resolve_secret(&mut cfg.pollinations_token, "pollinationsToken", &mut migrated, &mut errored);
    if !migrated.is_empty() {
        strip_secrets_from_file(&paths.config(), &migrated);
    }
    // Gate on the CONTENT token specifically — it drives dry-run + the cache
    // namespace. A failed read there must not look like "no token configured".
    cfg.kc_error = errored.contains(&"wbContentToken");
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
            if SECRET_KEYS.contains(&k.as_str()) {
                // Secrets → OS keychain, never plaintext json. Only drop the
                // cleartext from json once it's safely in the keychain; if the
                // keychain is unavailable, keep plaintext so we never lose it.
                match v.as_str().map(|s| s.trim()) {
                    Some(s) if !s.is_empty() => {
                        if kc_set(k, s) {
                            obj.remove(k);
                        } else {
                            obj.insert(k.clone(), Value::String(s.to_string()));
                        }
                    }
                    // explicit empty value = clear the secret everywhere
                    _ => {
                        kc_del(k);
                        obj.remove(k);
                    }
                }
            } else {
                obj.insert(k.clone(), v.clone());
            }
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

/// Days until the WB content token (a JWT) expires; None if absent/unparseable.
/// WB tokens are ~180-day JWTs — surfacing this prevents a silent mid-publish 401
/// that reads as "the app suddenly stopped working".
pub fn wb_token_expiry_days(token: &str) -> Option<i64> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    let exp = v.get("exp").and_then(|x| x.as_i64())?;
    let secs = exp - chrono::Utc::now().timestamp();
    // floor → only a genuinely expired token is negative; <24h left reads as 0
    // ("expires today"), not as "expired".
    Some((secs as f64 / 86_400.0).floor() as i64)
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
        "wbTokenExpiresInDays": wb_token_expiry_days(&cfg.wb_content_token),
        "wbSandbox": cfg.wb_sandbox,
        "imageProvider": cfg.image_provider,
        "openaiKeySet": !cfg.openai_api_key.is_empty(),
        "aurixelKeySet": !cfg.aurixel_api_key.is_empty(),
        "aurixelChatModel": cfg.aurixel_chat_model,
        "pollinationsTokenSet": !cfg.pollinations_token.is_empty(),
        "publicBaseUrl": cfg.public_base_url,
        "defaultWarehouseId": cfg.default_warehouse_id,
        "defaultStock": cfg.default_stock,
        "autoStock": cfg.auto_stock,
        "defaultLength": cfg.default_length,
        "defaultWidth": cfg.default_width,
        "defaultHeight": cfg.default_height,
        "defaultWeight": cfg.default_weight,
        // Non-secret → the one sanctioned channel for the editable templates.
        "imageTemplates": serde_json::to_value(active_templates(cfg)).unwrap_or(Value::Null),
    })
}
