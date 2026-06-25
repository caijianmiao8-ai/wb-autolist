"use client";

import { useEffect, useState } from "react";
import { Nav } from "./Nav";
import { SetupWizard } from "./SetupWizard";
import { api } from "@/lib/api";

/// Client shell + first-run gate: if neither Aurixel key nor WB token is
/// configured, show the full-screen setup wizard instead of the app.
export function AppShell({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [firstRun, setFirstRun] = useState(false);

  async function check() {
    try {
      const s = await api.getSettings();
      setFirstRun(!s.aurixelKeySet && !s.wbContentTokenSet);
    } catch {
      setFirstRun(false); // if settings can't load, don't trap the user in the wizard
    }
    setReady(true);
  }

  useEffect(() => {
    check();
  }, []);

  // Avoid flashing the app then snapping to the wizard.
  if (!ready) return null;
  if (firstRun) return <SetupWizard onDone={() => setFirstRun(false)} />;

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 sm:px-6">
      <Nav />
      <main className="flex-1 pb-24 pt-10">{children}</main>
      <footer className="border-t border-slate-900/[0.06] py-7 text-center text-xs tracking-wide text-slate-400 hairline dark:text-slate-600">
        WB AutoList · 商品自动化上架工作流
      </footer>
    </div>
  );
}
