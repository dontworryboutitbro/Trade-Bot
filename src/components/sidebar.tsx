"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BarChart3,
  Layers,
  LayoutDashboard,
  Settings,
  Wand2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/positions", label: "Positions", icon: Layers },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/performance", label: "Performance", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/setup", label: "Setup", icon: Wand2 },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-edge bg-surface px-2 py-1 md:w-48 md:flex-col md:border-b-0 md:border-r md:px-3 md:py-4">
      {links.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-raised font-medium text-foreground"
                : "text-muted hover:bg-raised/60 hover:text-foreground",
            )}
          >
            <Icon size={15} strokeWidth={1.8} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
