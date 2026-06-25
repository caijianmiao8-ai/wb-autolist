#![allow(dead_code)]
//! File-backed listings store (ported from src/lib/store.ts).

use crate::paths::{atomic_write, quarantine_corrupt, Paths};
use crate::types::Listing;
use crate::util::now_iso;
use std::sync::{Mutex, OnceLock};

/// Process-wide guard held across the read+write of listings.json, so concurrent
/// mutators (batch worker + user commands on the multi-threaded runtime) can't
/// last-writer-wins each other (which could revert a just-saved nmID → orphan).
fn store_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

fn read_all(paths: &Paths) -> Vec<Listing> {
    let file = paths.listings();
    let txt = match std::fs::read_to_string(&file) {
        Ok(t) => t,
        Err(_) => return vec![],
    };
    match serde_json::from_str::<Vec<Listing>>(&txt) {
        Ok(v) => v,
        Err(_) => {
            quarantine_corrupt(&file);
            vec![]
        }
    }
}

fn write_all(paths: &Paths, list: &[Listing]) {
    let _ = atomic_write(&paths.listings(), &serde_json::to_vec_pretty(list).unwrap_or_default());
}

pub fn list_listings(paths: &Paths) -> Vec<Listing> {
    let mut v = read_all(paths);
    v.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    v
}

pub fn get_listing(paths: &Paths, id: &str) -> Option<Listing> {
    read_all(paths).into_iter().find(|l| l.id == id)
}

pub fn save_listing(paths: &Paths, mut listing: Listing) -> Listing {
    let _g = store_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut all = read_all(paths);
    listing.updated_at = now_iso();
    if let Some(i) = all.iter().position(|l| l.id == listing.id) {
        all[i] = listing.clone();
    } else {
        all.push(listing.clone());
    }
    write_all(paths, &all);
    listing
}

pub fn update_listing<F: FnOnce(&mut Listing)>(paths: &Paths, id: &str, f: F) -> Option<Listing> {
    let _g = store_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut all = read_all(paths);
    let i = all.iter().position(|l| l.id == id)?;
    f(&mut all[i]);
    all[i].updated_at = now_iso();
    let updated = all[i].clone();
    write_all(paths, &all);
    Some(updated)
}

pub fn delete_listing(paths: &Paths, id: &str) -> bool {
    let _g = store_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut all = read_all(paths);
    let n = all.len();
    all.retain(|l| l.id != id);
    if all.len() == n {
        return false;
    }
    write_all(paths, &all);
    true
}
