"use client";

import { useEffect, useState } from "react";
import { Nav } from "./Nav";
import { SetupWizard } from "./SetupWizard";
import { EnvBanner } from "./EnvBadge";
import { api } from "@/lib/api";

/// Client shell + first-run gate: if neither Aurixel key nor WB token is
/// configured, show the full-screen setup wizard instead of the app.
export function AppShell({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [firstRun, setFirstRun] = useState(false);
  const [env, setEnv] = useState({ dryRun: true, sandbox: false });

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
      setFirstRun(rerun || (!s.aurixelKeySet && !s.wbContentTokenSet));
      setEnv({ dryRun: s.dryRun, sandbox: s.wbSandbox });
    } catch {
      setFirstRun(rerun); // if settings can't load, only show wizard on explicit re-run
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
  }

  // Avoid flashing the app then snapping to the wizard.
  if (!ready) return null;
  if (firstRun) return <SetupWizard onDone={doneWizard} />;

  return (
    <>
      <EnvBanner dryRun={env.dryRun} sandbox={env.sandbox} />
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 sm:px-6">
        <Nav />
        <main className="flex-1 pb-6 pt-5">{children}</main>
      </div>
    </>
  );
}
