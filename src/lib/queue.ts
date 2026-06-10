import fs from "node:fs";
import { QUEUE_PATH, atomicWrite, quarantineCorrupt } from "./paths";
import { getConfig } from "./config";
import { generateListing } from "./generate";
import { publishListing } from "./wb/pipeline";
import { saveListing, updateListing } from "./store";
import { newId, nowIso } from "./util";
import type { ListingInput } from "./types";

export type JobStatus =
  | "pending"
  | "generating"
  | "publishing"
  | "done" // generated (draft) or published, success
  | "error";

export interface BatchJob {
  id: string;
  input: ListingInput;
  autoPublish: boolean;
  status: JobStatus;
  listingId: string | null;
  nmID: number | null;
  sandbox: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── persistence (single-process, sync read-modify-write = atomic in Node) ──
let jobs: BatchJob[] | null = null;

function load(): BatchJob[] {
  if (jobs) return jobs;
  try {
    jobs = fs.existsSync(QUEUE_PATH)
      ? (JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8")) as BatchJob[])
      : [];
  } catch {
    quarantineCorrupt(QUEUE_PATH);
    jobs = [];
  }
  // a job left mid-flight by a crash/restart → re-queue
  let resumed = false;
  for (const j of jobs) {
    if (j.status === "generating" || j.status === "publishing") {
      j.status = "pending";
      resumed = true;
    }
  }
  if (resumed) persist();
  return jobs;
}

function persist() {
  atomicWrite(QUEUE_PATH, JSON.stringify(jobs ?? [], null, 2));
}

function patch(id: string, p: Partial<BatchJob>) {
  const list = load();
  const j = list.find((x) => x.id === id);
  if (!j) return;
  Object.assign(j, p, { updatedAt: nowIso() });
  persist();
}

export function listJobs(): BatchJob[] {
  return [...load()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function clearJobs(which: "finished" | "all"): void {
  const list = load();
  jobs =
    which === "all"
      ? list.filter((j) => j.status === "generating" || j.status === "publishing")
      : list.filter((j) => j.status !== "done" && j.status !== "error");
  persist();
}

/** Add product rows to the queue and start the worker. */
export function enqueue(inputs: ListingInput[], autoPublish: boolean): BatchJob[] {
  const list = load();
  const now = nowIso();
  const added = inputs
    .filter((i) => i.productName?.trim())
    .map<BatchJob>((input) => ({
      id: newId("job_"),
      input,
      autoPublish,
      status: "pending",
      listingId: null,
      nmID: null,
      sandbox: false,
      error: null,
      createdAt: now,
      updatedAt: now,
    }));
  list.push(...added);
  persist();
  void runWorker();
  return added;
}

// ── single sequential worker ──
let running = false;

export async function runWorker(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (true) {
      const job = load().find((j) => j.status === "pending");
      if (!job) break;
      const cfg = getConfig();
      try {
        patch(job.id, { status: "generating" });
        const listing = await generateListing(cfg, job.input);
        saveListing(listing);
        patch(job.id, { listingId: listing.id });

        if (job.autoPublish) {
          patch(job.id, { status: "publishing" });
          const result = await publishListing(listing, cfg);
          updateListing(listing.id, {
            stage: result.stage,
            nmID: result.nmID,
            imtID: result.imtID,
            subjectId: result.subjectId,
            subjectName: result.subjectName,
            dryRun: result.dryRun,
            sandbox: result.sandbox,
            logs: result.logs,
            error: result.error,
          });
          patch(job.id, {
            status: result.stage === "error" ? "error" : "done",
            nmID: result.nmID,
            sandbox: result.sandbox,
            error: result.error,
          });
        } else {
          // generated as draft only
          patch(job.id, { status: "done" });
        }
      } catch (e) {
        patch(job.id, {
          status: "error",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } finally {
    running = false;
  }
}

/** Re-kick the worker on server start if jobs were left pending. */
export function resumeWorkerIfNeeded(): void {
  if (load().some((j) => j.status === "pending")) void runWorker();
}
