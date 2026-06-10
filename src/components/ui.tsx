import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function Card({
  title,
  action,
  children,
  className,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-edge bg-surface", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between border-b border-edge px-4 py-3">
          {title && (
            <h2 className="text-[13px] font-medium uppercase tracking-wider text-muted">{title}</h2>
          )}
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

const badgeStyles: Record<string, string> = {
  muted: "bg-raised text-muted border-edge-strong",
  amber: "bg-warning/15 text-warning border-warning/40",
  red: "bg-critical/15 text-critical border-critical/50",
  green: "bg-positive/15 text-positive border-positive/40",
};

export function Badge({
  tone = "muted",
  children,
  className,
}: {
  tone?: "muted" | "amber" | "red" | "green";
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        badgeStyles[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "positive" | "negative" | "neutral";
}) {
  return (
    <div className="rounded-lg border border-edge bg-surface px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</div>
      <div
        className={cn(
          "tabular mt-1 text-xl font-semibold",
          tone === "positive" && "text-positive",
          tone === "negative" && "text-negative",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-faint",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn("tabular px-3 py-2 text-sm", className)}>{children}</td>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-faint">{children}</p>;
}

export function plTone(value: number | null | undefined): "positive" | "negative" | "neutral" {
  if (value === null || value === undefined || value === 0) return "neutral";
  return value > 0 ? "positive" : "negative";
}
