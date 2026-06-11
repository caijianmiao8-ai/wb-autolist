#![allow(dead_code)]
//! Runtime data dir + atomic writes (ported from src/lib/paths.ts).
//! In the desktop app the base dir is Tauri's per-user app_data_dir.

use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct Paths {
    pub data_dir: PathBuf,
}

impl Paths {
    pub fn new(data_dir: PathBuf) -> Self {
        let p = Self { data_dir };
        p.ensure();
        p
    }
    pub fn config(&self) -> PathBuf {
        self.data_dir.join("config.json")
    }
    pub fn listings(&self) -> PathBuf {
        self.data_dir.join("listings.json")
    }
    pub fn queue(&self) -> PathBuf {
        self.data_dir.join("queue.json")
    }
    pub fn db(&self) -> PathBuf {
        self.data_dir.join("wb.db")
    }
    pub fn images(&self) -> PathBuf {
        self.data_dir.join("images")
    }
    pub fn ensure(&self) {
        let _ = fs::create_dir_all(&self.data_dir);
        let _ = fs::create_dir_all(self.images());
    }
}

/// Write to a temp file then rename (same-dir rename is atomic), so a crash
/// mid-write can't truncate the real file.
pub fn atomic_write(file: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(format!(".tmp.{}", std::process::id()));
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, data)?;
    fs::rename(&tmp, file)?;
    Ok(())
}

/// Move a corrupt/unparseable file aside instead of silently overwriting it.
pub fn quarantine_corrupt(file: &Path) {
    if file.exists() {
        let ts = chrono::Utc::now().timestamp_millis();
        let mut bak = file.as_os_str().to_owned();
        bak.push(format!(".corrupt-{}", ts));
        let _ = fs::rename(file, PathBuf::from(bak));
    }
}
