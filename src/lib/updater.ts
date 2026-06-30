// Thin, browser/dev-safe wrapper around the Tauri updater plugin. In a plain
// browser (no Tauri runtime) every call no-ops so the UI never crashes.
export type UpdateInfo = { version: string; current: string; notes: string };

// Hold the resolved Update object between "check" and "install" so we hit the
// network/manifest only once.
let _update: { version: string; currentVersion: string; body?: string; downloadAndInstall: (cb?: (e: unknown) => void) => Promise<void> } | null =
  null;

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    _update = (await check()) as typeof _update;
    if (!_update) return null;
    return { version: _update.version, current: _update.currentVersion, notes: _update.body || "" };
  } catch {
    return null; // not in Tauri, offline, or no manifest yet
  }
}

/** Download + install the pending update, reporting 0–100% progress, then relaunch. */
export async function runUpdate(onProgress?: (pct: number) => void): Promise<void> {
  if (!_update) {
    const got = await checkForUpdate();
    if (!got) return;
  }
  const upd = _update;
  if (!upd) return;
  const { relaunch } = await import("@tauri-apps/plugin-process");
  let total = 0;
  let got = 0;
  await upd.downloadAndInstall((e) => {
    const ev = e as { event: string; data?: { contentLength?: number; chunkLength?: number } };
    if (ev.event === "Started") total = ev.data?.contentLength || 0;
    else if (ev.event === "Progress") {
      got += ev.data?.chunkLength || 0;
      if (total && onProgress) onProgress(Math.min(99, Math.round((got / total) * 100)));
    } else if (ev.event === "Finished" && onProgress) onProgress(100);
  });
  await relaunch();
}

/** Current app version (for display); empty string outside Tauri. */
export async function appVersion(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "";
  }
}
