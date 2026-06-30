"use client";

import { useEffect, useState } from "react";
import { Nav } from "./Nav";
import { SetupWizard } from "./SetupWizard";
import { GuideOverlay } from "./GuideOverlay";
import { EnvBanner } from "./EnvBadge";
import { api } from "@/lib/api";

const GUIDE_SEEN_KEY = "wb:guideSeen";

/// Client shell + first-run gate: if neither Aurixel key nor WB token is
/// configured, show the full-screen setup wizard instead of the app.
export function AppShell({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [firstRun, setFirstRun] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [env, setEnv] = useState({ dryRun: true, sandbox: false });

  // First-run USAGE guide: show once after setup is past (not on top of the wizard).
  function maybeGuide(isFirstRun: boolean) {
    if (isFirstRun) return;
    try {
      if (localStorage.getItem(GUIDE_SEEN_KEY) !== "1") setShowGuide(true);
    } catch {
      /* ignore */
    }
  }
  function closeGuide() {
    setShowGuide(false);
    try {
      localStorage.setItem(GUIDE_SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  async function check() {
    // Settings can re-trigger the wizard by setting this flag (it auto-shows only
    // on a truly fresh install otherwise).
    let rerun = false;
    try {
      rerun = localStorage.getItem("wb:rerunSetup") === "1";
    } catch {
      /* ignore */
    }
    try {
      const s = await api.getSettings();
      const fr = rerun || (!s.aurixelKeySet && !s.wbContentTokenSet);
      setFirstRun(fr);
      setEnv({ dryRun: s.dryRun, sandbox: s.wbSandbox });
      maybeGuide(fr);
    } catch {
      setFirstRun(rerun); // if settings can't load, only show wizard on explicit re-run
      maybeGuide(rerun);
    }
    setReady(true);
  }

  useEffect(() => {
    check();
  }, []);

  function doneWizard() {
    try {
      localStorage.removeItem("wb:rerunSetup");
    } catch {
      /* ignore */
    }
    setFirstRun(false);
    maybeGuide(false); // fresh install → show the usage guide right after setup
  }

  // Avoid flashing the app then snapping to the wizard.
  if (!ready) return null;
  if (firstRun) return <SetupWizard onDone={doneWizard} />;

  return (
    // Fixed-height app frame: the window never scrolls. The EnvBanner + Nav are
    // pinned; only <main> scrolls. A page that wants a one-screen, no-scroll
    // layout (the Workbench) renders `h-full` and scrolls its own panels
    // internally; taller legacy pages just scroll within <main> as before.
    <div className="flex h-screen flex-col overflow-hidden">
      <EnvBanner dryRun={env.dryRun} sandbox={env.sandbox} />
      <div className="mx-auto flex w-full min-h-0 max-w-7xl flex-1 flex-col px-4 sm:px-6">
        <Nav onHelp={() => setShowGuide(true)} />
        <main className="min-h-0 flex-1 overflow-y-auto pb-5 pt-3">{children}</main>
      </div>
      {showGuide && <GuideOverlay onClose={closeGuide} />}
    </div>
  );
}
