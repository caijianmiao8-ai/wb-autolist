"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, Settings, History, Layers } from "lucide-react";
import clsx from "clsx";

const links = [
  { href: "/", label: "工作台", icon: Sparkles },
  { href: "/batch", label: "批量上架", icon: Layers },
  { href: "/history", label: "上架记录", icon: History },
  { href: "/settings", label: "设置", icon: Settings },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-30 -mx-4 mb-2 border-b border-white/[0.06] bg-wb-ink/60 px-4 py-3.5 backdrop-blur-xl sm:-mx-6 sm:px-6">
      <div className="flex items-center justify-between">
        <Link href="/" className="group flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="WB AutoList"
            width={36}
            height={36}
            className="h-9 w-9 rounded-xl shadow-glow transition-transform duration-200 group-hover:scale-[1.04]"
          />
          <span className="text-[15px] font-semibold tracking-tight text-slate-100">
            WB<span className="text-wb-pink">AutoList</span>
          </span>
        </Link>
        <nav className="flex items-center gap-0.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1">
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
                    ? "bg-white/[0.08] text-white shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="hidden sm:inline">{label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
