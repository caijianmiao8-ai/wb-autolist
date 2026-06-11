#![allow(dead_code)]
//! WB Supplier/Content API client (ported from src/lib/wb/client.ts).
//!
//! Auth: WB expects the RAW token in `Authorization` (NO "Bearer " prefix) —
//! a Bearer prefix makes the gateway reject it ("token is malformed: invalid
//! number of segments"). We send raw first and fall back to Bearer only on 401.
//! WB's gateway allows ~1 concurrent request per host, so requests are
//! serialized per host with a ≥900ms gap (SerialGate); 429/5xx are retried.

use crate::state::AppState;
use anyhow::{anyhow, Result};
use reqwest::Method;
use serde_json::Value;
use std::future::Future;
use std::time::Duration;

pub const HOST_CONTENT: &str = "https://content-api.wildberries.ru";
pub const HOST_PRICES: &str = "https://discounts-prices-api.wildberries.ru";
pub const HOST_MARKETPLACE: &str = "https://marketplace-api.wildberries.ru";

#[derive(Clone, Copy)]
pub enum Host {
    Content,
    Prices,
    /// FBS marketplace: warehouses + stocks. No sandbox variant exists.
    Marketplace,
}

#[derive(Clone)]
pub struct WbCtx {
    pub token: String,
    pub sandbox: bool,
}

/// Concurrency-1 gate with a trailing gap — the next waiter starts ≥`gap` after
/// the previous request settles. Matches the TS per-host SerialGate(900ms).
pub struct SerialGate {
    lock: tokio::sync::Mutex<()>,
    gap: Duration,
}

impl SerialGate {
    pub fn new(gap: Duration) -> Self {
        Self {
            lock: tokio::sync::Mutex::new(()),
            gap,
        }
    }
    pub async fn run<T>(&self, fut: impl Future<Output = T>) -> T {
        let _g = self.lock.lock().await;
        let out = fut.await;
        tokio::time::sleep(self.gap).await;
        out
    }
}

pub struct MultipartData {
    pub field: String,
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

pub struct WbReq {
    pub method: Method,
    pub host: Host,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub json: Option<Value>,
    pub multipart: Option<MultipartData>,
    pub headers: Vec<(String, String)>,
    pub timeout_ms: u64,
}

impl WbReq {
    pub fn new(method: Method, path: &str) -> Self {
        Self {
            method,
            host: Host::Content,
            path: path.to_string(),
            query: vec![],
            json: None,
            multipart: None,
            headers: vec![],
            timeout_ms: 30_000,
        }
    }
    pub fn get(path: &str) -> Self {
        Self::new(Method::GET, path)
    }
    pub fn post(path: &str) -> Self {
        Self::new(Method::POST, path)
    }
    pub fn put(path: &str) -> Self {
        Self::new(Method::PUT, path)
    }
    pub fn delete(path: &str) -> Self {
        Self::new(Method::DELETE, path)
    }
    pub fn on(mut self, host: Host) -> Self {
        self.host = host;
        self
    }
    pub fn q(mut self, k: &str, v: impl ToString) -> Self {
        self.query.push((k.to_string(), v.to_string()));
        self
    }
    pub fn body(mut self, v: Value) -> Self {
        self.json = Some(v);
        self
    }
    pub fn header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.to_string(), v.to_string()));
        self
    }
    pub fn timeout(mut self, ms: u64) -> Self {
        self.timeout_ms = ms;
        self
    }
    pub fn form(mut self, m: MultipartData) -> Self {
        self.multipart = Some(m);
        self
    }
}

fn base_host(host: Host, sandbox: bool) -> String {
    // Marketplace has no sandbox host — always hit production (stock ops only
    // make sense against the live FBS warehouse).
    if let Host::Marketplace = host {
        return HOST_MARKETPLACE.to_string();
    }
    let base = match host {
        Host::Content => HOST_CONTENT,
        Host::Prices => HOST_PRICES,
        Host::Marketplace => HOST_MARKETPLACE,
    };
    if sandbox {
        base.replace("-api.wildberries.ru", "-api-sandbox.wildberries.ru")
    } else {
        base.to_string()
    }
}

async fn build_and_send(
    http: &reqwest::Client,
    url: &str,
    req: &WbReq,
    auth: &str,
) -> Result<reqwest::Response> {
    let mut rb = http
        .request(req.method.clone(), url)
        .header("Authorization", auth)
        .query(&req.query)
        .timeout(Duration::from_millis(req.timeout_ms));
    for (k, v) in &req.headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    if let Some(m) = &req.multipart {
        let part = reqwest::multipart::Part::bytes(m.bytes.clone())
            .file_name(m.filename.clone())
            .mime_str(&m.content_type)?;
        rb = rb.multipart(reqwest::multipart::Form::new().part(m.field.clone(), part));
    } else if let Some(j) = &req.json {
        rb = rb
            .header("Content-Type", "application/json")
            .body(serde_json::to_vec(j)?);
    }
    Ok(rb.send().await?)
}

/// Core request: auth + JSON handling + per-host serialization + retry on
/// 429/5xx and one Bearer→raw auth fallback on 401.
pub async fn wb_fetch(state: &AppState, ctx: &WbCtx, req: WbReq) -> Result<Value> {
    let url = format!("{}{}", base_host(req.host, ctx.sandbox), req.path);
    let gate = match req.host {
        Host::Content => &state.gate_content,
        Host::Prices => &state.gate_prices,
        Host::Marketplace => &state.gate_marketplace,
    };
    let mut attempt: u64 = 0;
    // WB wants the raw token; Bearer is only a 401 fallback.
    let mut use_bearer = false;
    loop {
        attempt += 1;
        let auth = if use_bearer {
            format!("Bearer {}", ctx.token)
        } else {
            ctx.token.clone()
        };
        let res = gate
            .run(build_and_send(&state.http, &url, &req, &auth))
            .await;
        let res = match res {
            Ok(r) => r,
            Err(e) => {
                if attempt < 3 {
                    tokio::time::sleep(Duration::from_millis(attempt * 800)).await;
                    continue;
                }
                return Err(anyhow!("Сетевая ошибка при запросе {}: {}", req.path, e));
            }
        };
        let status = res.status().as_u16();
        let retry_after = res
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok());
        let text = res.text().await.unwrap_or_default();
        let json: Option<Value> = serde_json::from_str(&text).ok();

        // one-time fallback: raw rejected with 401 → retry with Bearer (don't
        // consume an attempt)
        if status == 401 && !use_bearer {
            use_bearer = true;
            attempt -= 1;
            continue;
        }
        if (status == 429 || status >= 500) && attempt < 3 {
            let wait = retry_after.unwrap_or(attempt * 2);
            tokio::time::sleep(Duration::from_secs(wait)).await;
            continue;
        }
        if status == 429 {
            // WB returns the rate-limit doc URL in `detail`; surface it as a
            // human message instead of a bare link.
            let link = json
                .as_ref()
                .and_then(|j| j.get("detail").and_then(|v| v.as_str()))
                .filter(|s| s.starts_with("http"))
                .map(|s| format!("（说明: {}）", s))
                .unwrap_or_default();
            return Err(anyhow!(
                "WB API {}: 请求过于频繁(429)，接口限流，请稍候再试{}",
                req.path,
                link
            ));
        }
        if !(200..300).contains(&status) {
            let msg = json
                .as_ref()
                .and_then(err_msg)
                .unwrap_or_else(|| format!("HTTP {}", status));
            return Err(anyhow!("WB API {}: {}", req.path, with_token_diag(msg, &ctx.token)));
        }
        // WB content API often wraps errors in a 200 with {error:true,errorText}
        if let Some(j) = &json {
            if j.get("error").and_then(|v| v.as_bool()) == Some(true) {
                let msg = j
                    .get("errorText")
                    .and_then(|v| v.as_str())
                    .unwrap_or("ошибка")
                    .to_string();
                return Err(anyhow!("WB API {}: {}", req.path, with_token_diag(msg, &ctx.token)));
            }
        }
        return Ok(json.unwrap_or(Value::String(text)));
    }
}

fn err_msg(j: &Value) -> Option<String> {
    for k in ["errorText", "detail", "title", "message"] {
        if let Some(s) = j.get(k).and_then(|v| v.as_str()) {
            return Some(s.to_string());
        }
    }
    None
}

/// For token-shaped errors, append a non-sensitive diagnostic (length + segment
/// count) so a truncated/whitespace-mangled stored token is obvious. A valid WB
/// JWT has 3 dot-separated segments.
fn with_token_diag(msg: String, token: &str) -> String {
    let lower = msg.to_lowercase();
    if lower.contains("token") || lower.contains("segment") || lower.contains("malformed") {
        format!(
            "{} [本地 token: {} 字符 / {} 段（正常应为 3 段 JWT）]",
            msg,
            token.chars().count(),
            token.split('.').count()
        )
    } else {
        msg
    }
}
