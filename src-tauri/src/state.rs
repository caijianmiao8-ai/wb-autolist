#![allow(dead_code)]
//! Shared application state, injected into Tauri commands via `State<AppState>`.

use crate::paths::Paths;
use crate::wb::categories::WbCaches;
use crate::wb::client::SerialGate;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::Mutex;

pub struct AppState {
    pub paths: Paths,
    pub http: reqwest::Client,
    /// Per-host serial gates (WB allows ~1 concurrent request per host).
    pub gate_content: SerialGate,
    pub gate_prices: SerialGate,
    /// WB category/dictionary caches (rarely change; avoid burning rate limit).
    pub caches: Mutex<WbCaches>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        AppState {
            paths: Paths::new(data_dir),
            http: reqwest::Client::builder()
                .build()
                .expect("failed to build reqwest client"),
            gate_content: SerialGate::new(Duration::from_millis(900)),
            gate_prices: SerialGate::new(Duration::from_millis(900)),
            caches: Mutex::new(WbCaches::default()),
        }
    }
}
