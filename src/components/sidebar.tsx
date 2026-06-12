"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BarChart3,
  BellRing,
  BookOpenText,
  FlaskConical,
  GraduationCap,
  Layers,
  LayoutDashboard,
  Radar,
  Scale,
  ScrollText,
  Settings,
  Wand2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LivePulse } from "@/components/ui";

const links = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/positions", label: "Portfolio", icon: Layers },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/performance", label: "Performance", icon: BarChart3 },
  { href: "/strategy-lab", label: "Strategy Lab", icon: FlaskConical },
  { href: "/learning", label: "Learning Engine", icon: GraduationCap },
  { href: "/paper-journal", label: "Paper Journal", icon: BookOpenText },
  { href: "/cross-market", label: "Cross-Market", icon: Scale },
  { href: "/scanner", label: "Scanner", icon: Radar },
  { href: "/alerts", label: "Alerts", icon: BellRing },
  { href: "/audit", label: "Audit Log", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/setup", label: "Setup", icon: Wand2 },
];

/** Minimal geometric mark: three offset angular strokes forming an "F" ridge. */
function LogoMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 20 L4 4 L20 4" stroke="var(--accent)" strokeWidth="2.2" />
      <path d="M9 20 L9 9 L17 9" stroke="var(--accent-violet)" strokeWidth="1.8" opacity="0.8" />
      <path d="M14 20 L14 14 L18 14" stroke="var(--border-strong)" strokeWidth="1.6" />
    </svg>
  );
}

export interface SidebarStatus {
  mode: string;
  feed: string;
  supabaseOk: boolean;
  alpacaConfigured: boolean;
  /** Explicit system state — never an ambiguous "IDLE" while healthy. */
  systemState: string;
  scannerActive: boolean;
  killSwitch: boolean;
}

export function Sidebar({ status }: { status: SidebarStatus }) {
  const pathname = usePathname();
  return (
    <nav className="relative z-10 flex shrink-0 gap-1 overflow-x-auto border-b border-edge bg-surface px-2 py-1 md:w-52 md:flex-col md:gap-0.5 md:overflow-visible md:border-b-0 md:border-r md:px-0 md:py-0">
      {/* Brand */}
      <div className="hidden items-center gap-2.5 border-b border-edge px-4 py-4 md:flex">
        <LogoMark />
        <div>
          <div className="text-[13px] font-semibold tracking-tight">Fable Fund Lab</div>
          <div className="text-[9px] uppercase tracking-[0.14em] text-faint">
            AI-Assisted Investment Research
          </div>
        </div>
      </div>

      <div className="flex gap-1 md:mt-2 md:flex-1 md:flex-col md:gap-0.5 md:px-2">
        {links.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 whitespace-nowrap rounded-[5px] border-l-2 px-3 py-[7px] text-[13px] transition-colors",
                active
                  ? "border-accent bg-violet/10 font-medium text-foreground"
                  : "border-transparent text-muted hover:bg-raised/70 hover:text-foreground",
              )}
            >
              <Icon size={14} strokeWidth={1.8} className={active ? "text-accent" : undefined} />
              {label}
            </Link>
          );
        })}
      </div>

      {/* System status footer */}
      <div className="hidden border-t border-edge px-4 py-3 md:block">
        <div className="space-y-0.5 text-[10px]">
          <div className="flex items-center justify-between">
            <span className="uppercase tracking-[0.1em] text-faint">Mode</span>
            <span className="font-semibold uppercase tracking-[0.06em] text-muted">
              {status.mode.replace(/_/g, " ")}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="uppercase tracking-[0.1em] text-faint">Feed</span>
            <span className="uppercase text-warning">{status.feed}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="uppercase tracking-[0.1em] text-faint">Supabase</span>
            <span className="flex items-center gap-1">
              <LivePulse tone={status.supabaseOk ? "green" : "muted"} />
              <span className={status.supabaseOk ? "text-positive" : "text-faint"}>
                {status.supabaseOk ? "SYNC" : "MOCK"}
              </span>
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="uppercase tracking-[0.1em] text-faint">Alpaca</span>
            <span className={status.alpacaConfigured ? "text-positive" : "text-faint"}>
              {status.alpacaConfigured ? "LINKED" : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="uppercase tracking-[0.1em] text-faint">Scanner</span>
            <span className="flex items-center gap-1">
              {status.scannerActive && <LivePulse tone="magenta" />}
              <span className={status.scannerActive ? "text-accent" : "text-faint"}>
                {status.scannerActive ? "ACTIVE" : "6H CRON"}
              </span>
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="uppercase tracking-[0.1em] text-faint">System</span>
            <span className="text-muted">{status.systemState}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="uppercase tracking-[0.1em] text-faint">Kill switch</span>
            <span className={status.killSwitch ? "text-critical" : "text-muted"}>
              {status.killSwitch ? "ENGAGED" : "ARMED"}
            </span>
          </div>
        </div>
      </div>
    </nav>
  );
}
