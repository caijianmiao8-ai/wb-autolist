#![allow(dead_code)]
//! Batch job queue with a single sequential worker (ported from
//! src/lib/queue.ts). Persisted to queue.json; a job left mid-flight by a
//! crash/restart is re-queued.

use crate::config::get_config;
use crate::generate::generate_listing;
use crate::paths::{atomic_write, quarantine_corrupt, Paths};
use crate::state::AppState;
use crate::store::{save_listing, update_listing};
use crate::types::{ListingInput, ListingStage};
use crate::util::{new_id, now_iso};
use crate::wb::pipeline::publish_listing;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Pending,
    Generating,
    Publishing,
    Done,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchJob {
    pub id: String,
    pub input: ListingInput,
    pub auto_publish: bool,
    pub status: JobStatus,
    pub listing_id: Option<String>,
    #[serde(rename = "nmID")]
    pub nm_id: Option<i64>,
    pub sandbox: bool,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn persist_jobs(paths: &Paths, jobs: &[BatchJob]) {
    let _ = atomic_write(&paths.queue(), &serde_json::to_vec_pretty(jobs).unwrap_or_default());
}

/// Load persisted jobs; re-queue any left mid-flight by a crash/restart.
pub fn load_jobs(paths: &Paths) -> Vec<BatchJob> {
    let file = paths.queue();
    let mut jobs: Vec<BatchJob> = match std::fs::read_to_string(&file) {
        Ok(t) => match serde_json::from_str(&t) {
            Ok(v) => v,
            Err(_) => {
                quarantine_corrupt(&file);
                vec![]
            }
        },
        Err(_) => vec![],
    };
    let mut resumed = false;
    for j in jobs.iter_mut() {
        if j.status == JobStatus::Generating || j.status == JobStatus::Publishing {
            j.status = JobStatus::Pending;
            resumed = true;
        }
    }
    if resumed {
        persist_jobs(paths, &jobs);
    }
    jobs
}

pub async fn list_jobs(state: &AppState) -> Vec<BatchJob> {
    let q = state.queue.lock().await;
    let mut v = q.clone();
    v.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    v
}

pub async fn clear_jobs(state: &AppState, which: &str) -> Vec<BatchJob> {
    {
        let mut q = state.queue.lock().await;
        if which == "all" {
            q.retain(|j| j.status == JobStatus::Generating || j.status == JobStatus::Publishing);
        } else {
            q.retain(|j| j.status != JobStatus::Done && j.status != JobStatus::Error);
        }
        persist_jobs(&state.paths, &q);
    }
    list_jobs(state).await
}

/// Add product rows to the queue and start the worker.
pub async fn enqueue(
    state: Arc<AppState>,
    inputs: Vec<ListingInput>,
    auto_publish: bool,
) -> Vec<BatchJob> {
    let now = now_iso();
    let added: Vec<BatchJob> = inputs
        .into_iter()
        .filter(|i| !i.product_name.trim().is_empty())
        .map(|input| BatchJob {
            id: new_id("job_"),
            input,
            auto_publish,
            status: JobStatus::Pending,
            listing_id: None,
            nm_id: None,
            sandbox: false,
            error: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .collect();
    {
        let mut q = state.queue.lock().await;
        q.extend(added.iter().cloned());
        persist_jobs(&state.paths, &q);
    }
    let st = state.clone();
    tauri::async_runtime::spawn(async move { run_worker(st).await });
    added
}

async fn patch<F: FnOnce(&mut BatchJob)>(state: &AppState, id: &str, f: F) {
    let mut q = state.queue.lock().await;
    if let Some(j) = q.iter_mut().find(|j| j.id == id) {
        f(j);
        j.updated_at = now_iso();
        persist_jobs(&state.paths, &q);
    }
}

pub async fn run_worker(state: Arc<AppState>) {
    if state.worker_running.swap(true, Ordering::SeqCst) {
        return; // already running
    }
    loop {
        // claim the next pending job
        let job = {
            let mut q = state.queue.lock().await;
            match q.iter_mut().find(|j| j.status == JobStatus::Pending) {
                Some(j) => {
                    j.status = JobStatus::Generating;
                    j.updated_at = now_iso();
                    let snap = j.clone();
                    persist_jobs(&state.paths, &q);
                    Some(snap)
                }
                None => None,
            }
        };
        let job = match job {
            Some(j) => j,
            None => break,
        };

        let cfg = get_config(&state.paths);
        let outcome: anyhow::Result<()> = async {
            let noop = |_s: &str, _o: bool, _m: &str| {};
            // Crash-resume: if this job already produced a listing, REUSE it
            // rather than regenerating — regenerate + re-publish would create a
            // duplicate card. The pipeline's nmID idempotency covers the case
            // where the prior run already created the WB card.
            let listing = match job
                .listing_id
                .as_ref()
                .and_then(|lid| crate::store::get_listing(&state.paths, lid))
            {
                Some(l) => l,
                None => {
                    let l = generate_listing(&state, &cfg, &job.input, &noop, false).await?;
                    let lid = l.id.clone();
                    save_listing(&state.paths, l.clone());
                    patch(&state, &job.id, |j| j.listing_id = Some(lid.clone())).await;
                    l
                }
            };

            if job.auto_publish {
                patch(&state, &job.id, |j| j.status = JobStatus::Publishing).await;
                // Share the in-flight guard with the manual `publish` command so a
                // user clicking Publish on this same listing can't race us into a
                // duplicate card. If it's already in flight, the other path owns it.
                let got_lock = {
                    let mut inflight = state.publishing.lock().unwrap_or_else(|e| e.into_inner());
                    inflight.insert(listing.id.clone())
                };
                if !got_lock {
                    patch(&state, &job.id, |j| {
                        j.status = JobStatus::Done;
                        j.error = Some("已由手动上架处理，跳过以避免重复建卡".into());
                    })
                    .await;
                    return Ok(());
                }
                let noop = |_s: &str, _o: bool, _m: &str| {};
                let result = publish_listing(&state, &listing, &cfg, &noop).await;
                {
                    let mut inflight = state.publishing.lock().unwrap_or_else(|e| e.into_inner());
                    inflight.remove(&listing.id);
                }
                update_listing(&state.paths, &listing.id, |l| {
                    l.stage = result.stage;
                    // never erase a known nmID with a None (orphan guard)
                    l.nm_id = result.nm_id.or(l.nm_id);
                    l.imt_id = result.imt_id.or(l.imt_id);
                    l.subject_id = result.subject_id.or(l.subject_id);
                    if result.subject_name.is_some() {
                        l.subject_name = result.subject_name.clone();
                    }
                    if let Some(vc) = &result.vendor_code {
                        l.vendor_code = vc.clone();
                    }
                    if let Some(sk) = &result.sku {
                        l.sku = sk.clone();
                    }
                    l.dry_run = result.dry_run;
                    l.sandbox = result.sandbox;
                    l.logs = result.logs.clone();
                    l.error = result.error.clone();
                });
                let stage = result.stage;
                let nm = result.nm_id;
                let sb = result.sandbox;
                let err = result.error.clone();
                patch(&state, &job.id, move |j| {
                    j.status = if stage == ListingStage::Error {
                        JobStatus::Error
                    } else {
                        JobStatus::Done
                    };
                    j.nm_id = nm;
                    j.sandbox = sb;
                    j.error = err;
                })
                .await;
            } else {
                patch(&state, &job.id, |j| j.status = JobStatus::Done).await;
            }
            Ok(())
        }
        .await;

        if let Err(e) = outcome {
            let msg = e.to_string();
            patch(&state, &job.id, move |j| {
                j.status = JobStatus::Error;
                j.error = Some(msg);
            })
            .await;
        }
    }
    state.worker_running.store(false, Ordering::SeqCst);
}

/// Re-kick the worker on startup if jobs were left pending.
pub async fn resume_worker_if_needed(state: Arc<AppState>) {
    let has_pending = {
        let q = state.queue.lock().await;
        q.iter().any(|j| j.status == JobStatus::Pending)
    };
    if has_pending {
        tauri::async_runtime::spawn(async move { run_worker(state).await });
    }
}
