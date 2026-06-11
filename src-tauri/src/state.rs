#![allow(dead_code)]
//! Shared application state, injected into Tauri commands via `State<AppState>`.

use crate::paths::Paths;
use crate::queue::BatchJob;
use crate::wb::categories::WbCaches;
use crate::wb::client::SerialGate;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64};
use std::time::Duration;
use tokio::sync::Mutex;

pub struct AppState {
    pub paths: Paths,
    pub http: reqwest::Client,
    /// Per-host serial gates (WB allows ~1 concurrent request per host).
    pub gate_content: SerialGate,
    pub gate_prices: SerialGate,
    /// Marketplace (FBS) host: warehouses + stocks. Generous limit (~300/min),
    /// so a small gap is enough to stay polite.
    pub gate_marketplace: SerialGate,
    /// WB category/dictionary caches (rarely change; avoid burning rate limit).
    pub caches: Mutex<WbCaches>,
    /// Batch job queue (persisted) + single-worker guard.
    pub queue: Mutex<Vec<BatchJob>>,
    pub worker_running: AtomicBool,
    /// Local-first cache (SQLite). std Mutex — never held across an await.
    pub db: std::sync::Mutex<rusqlite::Connection>,
    /// Epoch-seconds until which the prices DOMAIN is cooling down after a 429
    /// (set from X-Ratelimit-Retry). 0 = no cooldown. Gates all price sync.
    pub prices_cooldown_until: AtomicI64,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        let paths = Paths::new(data_dir);
        let jobs = crate::queue::load_jobs(&paths);
        let db = crate::db::open(&paths.db()).unwrap_or_else(|e| {
            // A corrupt cache should never brick the app — fall back to in-memory.
            eprintln!("⚠ 打开本地库失败({}),改用内存库", e);
            crate::db::open_memory().expect("open in-memory db")
        });
        AppState {
            paths,
            http: reqwest::Client::builder()
                .build()
                .expect("failed to build reqwest client"),
            gate_content: SerialGate::new(Duration::from_millis(900)),
            gate_prices: SerialGate::new(Duration::from_millis(900)),
            gate_marketplace: SerialGate::new(Duration::from_millis(300)),
            caches: Mutex::new(WbCaches::default()),
            queue: Mutex::new(jobs),
            worker_running: AtomicBool::new(false),
            db: std::sync::Mutex::new(db),
            prices_cooldown_until: AtomicI64::new(0),
        }
    }
}
