#![allow(dead_code)]
//! Subject (category) resolution + dictionaries (ported from
//! src/lib/wb/categories.ts). In-process caches avoid burning the rate limit on
//! repeated identical lookups during concurrent publishes.

use crate::state::AppState;
use crate::wb::client::{wb_fetch, WbCtx, WbReq};
use crate::wb::types::{WbCharacteristic, WbColor, WbSubject};
use anyhow::Result;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub struct WbCaches {
    pub subjects: HashMap<String, Vec<WbSubject>>,
    pub charcs: HashMap<String, Vec<WbCharacteristic>>,
    pub tnved: HashMap<String, Option<String>>,
    pub colors: Option<Vec<WbColor>>,
}

fn ck(ctx: &WbCtx, k: &str) -> String {
    format!("{}:{}", if ctx.sandbox { "s" } else { "p" }, k)
}

fn data_array<T: DeserializeOwned>(v: &Value) -> Vec<T> {
    v.get("data")
        .and_then(|d| serde_json::from_value::<Vec<T>>(d.clone()).ok())
        .unwrap_or_default()
}

pub async fn search_subjects(
    state: &AppState,
    ctx: &WbCtx,
    name: &str,
    limit: i64,
) -> Result<Vec<WbSubject>> {
    let key = ck(ctx, &format!("subj:{}", name.to_lowercase()));
    {
        let c = state.caches.lock().await;
        if let Some(hit) = c.subjects.get(&key) {
            return Ok(hit.clone());
        }
    }
    let v = wb_fetch(
        state,
        ctx,
        WbReq::get("/content/v2/object/all")
            .q("name", name)
            .q("limit", limit)
            .q("offset", 0)
            .q("locale", "ru"),
    )
    .await?;
    let data: Vec<WbSubject> = data_array(&v);
    state.caches.lock().await.subjects.insert(key, data.clone());
    Ok(data)
}

/// Resolve a free-text hint to the single best subject.
pub async fn resolve_subject(
    state: &AppState,
    ctx: &WbCtx,
    hint: &str,
) -> Result<Option<WbSubject>> {
    let q = hint.trim().to_string();
    if q.is_empty() {
        return Ok(None);
    }
    let mut seen: Vec<WbSubject> = vec![];
    let mut ids: HashSet<i64> = HashSet::new();

    for s in search_subjects(state, ctx, &q, 50).await? {
        if ids.insert(s.subject_id) {
            seen.push(s);
        }
    }

    let mut words: Vec<String> = q
        .split(|c: char| c.is_whitespace() || ",，/".contains(c))
        .map(|w| w.trim().to_string())
        .filter(|w| w.chars().count() >= 3)
        .collect();
    words.sort_by(|a, b| b.chars().count().cmp(&a.chars().count()));
    words.truncate(2);

    for w in &words {
        if seen.len() >= 40 {
            break;
        }
        for s in search_subjects(state, ctx, w, 30).await? {
            if ids.insert(s.subject_id) {
                seen.push(s);
            }
        }
    }

    Ok(pick_best(&seen, &q))
}

fn tok(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| c.is_whitespace() || ",，/()-".contains(c))
        .map(|w| w.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
        .filter(|w| w.chars().count() >= 3)
        .collect()
}

/// Crude stem match: equal, or share a 4+ char prefix (handles ru declensions).
fn stem_eq(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let n = a.chars().count().min(b.chars().count()).min(5);
    if n < 4 {
        return false;
    }
    let ap: String = a.chars().take(n).collect();
    let bp: String = b.chars().take(n).collect();
    ap == bp
}

/// Score candidates against the hint, prioritizing the head noun.
fn pick_best(list: &[WbSubject], q: &str) -> Option<WbSubject> {
    if list.is_empty() {
        return None;
    }
    let lower = q.to_lowercase();
    let q_words = tok(q);
    let head = q_words.first().cloned();

    let mut best: Option<&WbSubject> = None;
    let mut best_score = -1f64;
    for s in list {
        let name = s.subject_name.to_lowercase();
        let n_words = tok(&name);
        if n_words.is_empty() {
            continue;
        }
        let score = if name == lower {
            1000.0
        } else {
            let covered: Vec<&String> = n_words
                .iter()
                .filter(|n| q_words.iter().any(|w| stem_eq(w, n)))
                .collect();
            let coverage = covered.len() as f64 / n_words.len() as f64;
            let head_in_name = head
                .as_ref()
                .map(|h| n_words.iter().any(|n| stem_eq(n, h)))
                .unwrap_or(false);
            let head_is_head = match (&head, n_words.first()) {
                (Some(h), Some(n0)) => stem_eq(n0, h),
                _ => false,
            };
            coverage * 40.0
                + if lower.contains(&name) { 30.0 } else { 0.0 }
                + if head_in_name { 35.0 } else { 0.0 }
                + if head_is_head { 20.0 } else { 0.0 }
                + covered.len() as f64 * 4.0
                - name.chars().count() as f64 * 0.05
        };
        if score > best_score {
            best_score = score;
            best = Some(s);
        }
    }
    if best_score > 0.0 {
        best.cloned()
    } else {
        Some(list[0].clone())
    }
}

pub async fn get_characteristics(
    state: &AppState,
    ctx: &WbCtx,
    subject_id: i64,
) -> Result<Vec<WbCharacteristic>> {
    let key = ck(ctx, &format!("charcs:{}", subject_id));
    {
        let c = state.caches.lock().await;
        if let Some(hit) = c.charcs.get(&key) {
            return Ok(hit.clone());
        }
    }
    let v = wb_fetch(
        state,
        ctx,
        WbReq::get(&format!("/content/v2/object/charcs/{}", subject_id)).q("locale", "ru"),
    )
    .await?;
    let data: Vec<WbCharacteristic> = data_array(&v);
    state.caches.lock().await.charcs.insert(key, data.clone());
    Ok(data)
}

pub async fn get_colors(state: &AppState, ctx: &WbCtx) -> Result<Vec<WbColor>> {
    {
        let c = state.caches.lock().await;
        if let Some(hit) = &c.colors {
            return Ok(hit.clone());
        }
    }
    let v = wb_fetch(
        state,
        ctx,
        WbReq::get("/content/v2/directory/colors").q("locale", "ru"),
    )
    .await?;
    let data: Vec<WbColor> = data_array(&v);
    state.caches.lock().await.colors = Some(data.clone());
    Ok(data)
}

/// Find a TNVED (customs) code for a subject — required for some categories.
pub async fn get_tnved(
    state: &AppState,
    ctx: &WbCtx,
    subject_id: i64,
    search: Option<&str>,
) -> Result<Option<String>> {
    let key = ck(ctx, &format!("tnved:{}", subject_id));
    {
        let c = state.caches.lock().await;
        if let Some(hit) = c.tnved.get(&key) {
            return Ok(hit.clone());
        }
    }
    let mut req = WbReq::get("/content/v2/directory/tnved")
        .q("subjectID", subject_id)
        .q("locale", "ru");
    if let Some(s) = search {
        req = req.q("search", s);
    }
    let v = wb_fetch(state, ctx, req).await?;
    let val = v
        .pointer("/data/0/tnved")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    state.caches.lock().await.tnved.insert(key, val.clone());
    Ok(val)
}
