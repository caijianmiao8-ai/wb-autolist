"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Sparkles, Settings, History, Layers, Boxes, Sun, Moon } from "lucide-react";
import clsx from "clsx";

const links = [
  { href: "/", label: "工作台", icon: Sparkles },
  { href: "/batch", label: "批量上架", icon: Layers },
  { href: "/manage", label: "商品管理", icon: Boxes },
  { href: "/history", label: "上架记录", icon: History },
  { href: "/settings", label: "设置", icon: Settings },
];

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.getAttribute("data-theme") === "dark");
  }, []);
  function toggle() {
    const next = !dark;
    setDark(next);
    if (next) document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    try {
      localStorage.setItem("wb:theme", next ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }
  return (
    <button
      type="button"
      onClick={toggle}
      title={dark ? "切换到淡色" : "切换到深色"}
      aria-label="切换主题"
      className="grid h-8 w-8 place-items-center rounded-lg border border-slate-900/[0.08] bg-slate-900/[0.02] text-slate-500 transition hover:text-slate-900 dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-slate-400 dark:hover:text-white"
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-30 -mx-4 mb-2 border-b border-slate-900/[0.07] bg-white/70 px-4 py-3.5 backdrop-blur-xl dark:border-white/[0.06] dark:bg-wb-ink/60 sm:-mx-6 sm:px-6">
      <div className="flex items-center justify-between gap-3">
        <Link href="/" className="group flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="WB AutoList"
            width={36}
            height={36}
            className="h-9 w-9 rounded-xl shadow-glow transition-transform duration-200 group-hover:scale-[1.04]"
          />
          <span className="text-[15px] font-semibold tracking-tight text-slate-800 dark:text-slate-100">
            WB<span className="text-wb-pink">AutoList</span>
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <nav className="flex items-center gap-0.5 rounded-xl border border-slate-900/[0.06] bg-slate-900/[0.02] p-1 dark:border-white/[0.06] dark:bg-white/[0.02]">
            {links.map(({ href, label, icon: Icon }) => {
              const active =
                href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  className={clsx(
                    "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-all duration-200",
                    active
                      ? "bg-slate-900/[0.06] text-slate-900 shadow-sm dark:bg-white/[0.08] dark:text-white"
                      : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span className="hidden sm:inline">{label}</span>
                </Link>
              );
            })}
          </nav>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
