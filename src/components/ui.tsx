import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/* Terminal design primitives: charcoal panels, thin graphite borders,
   uppercase micro-labels, monospaced numerals, restrained accent glow. */

export function Card({
  title,
  action,
  children,
  className,
  glow,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  glow?: "accent" | "violet";
}) {
  return (
    <section
      className={cn(
        "panel-hover rounded-md border border-edge bg-surface",
        glow === "accent" && "glow-accent",
        glow === "violet" && "glow-violet",
        className,
      )}
    >
      {(title || action) && (
        <header className="flex items-center justify-between border-b border-edge px-4 py-2.5">
          {title && (
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
              {title}
            </h2>
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
  amber: "bg-warning/10 text-warning border-warning/40",
  red: "bg-critical/10 text-critical border-critical/50",
  green: "bg-positive/10 text-positive border-positive/40",
  magenta: "bg-accent/10 text-accent border-accent/40",
  violet: "bg-violet/10 text-violet border-violet/40",
  blue: "bg-info/10 text-info border-info/40",
};

export function Badge({
  tone = "muted",
  children,
  className,
}: {
  tone?: "muted" | "amber" | "red" | "green" | "magenta" | "violet" | "blue";
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em]",
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
    <div className="panel-hover rounded-md border border-edge bg-surface px-3.5 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
        {label}
      </div>
      <div
        className={cn(
          "font-num mt-1 text-lg font-medium leading-tight",
          tone === "positive" && "text-positive",
          tone === "negative" && "text-negative",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        "sticky top-0 bg-surface px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-faint",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn("font-num px-3 py-1.5 text-[13px]", className)}>{children}</td>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="py-6 text-center text-[13px] uppercase tracking-wide text-faint">{children}</p>
  );
}

export function plTone(value: number | null | undefined): "positive" | "negative" | "neutral" {
  if (value === null || value === undefined || value === 0) return "neutral";
  return value > 0 ? "positive" : "negative";
}

/** Tiny animated dot for live connections. Respects reduced motion via CSS. */
export function LivePulse({
  tone = "green",
  className,
}: {
  tone?: "green" | "magenta" | "amber" | "red" | "muted";
  className?: string;
}) {
  const colors: Record<string, string> = {
    green: "bg-positive",
    magenta: "bg-accent",
    amber: "bg-warning",
    red: "bg-critical",
    muted: "bg-faint",
  };
  return (
    <span
      className={cn(
        "live-pulse inline-block h-1.5 w-1.5 rounded-full",
        colors[tone],
        className,
      )}
    />
  );
}

/** Terminal status row: LABEL ............ STATE */
export function StatusRow({
  label,
  state,
  tone = "muted",
  pulse,
}: {
  label: string;
  state: string;
  tone?: "muted" | "amber" | "red" | "green" | "magenta" | "violet" | "blue";
  pulse?: boolean;
}) {
  const toneText: Record<string, string> = {
    muted: "text-muted",
    amber: "text-warning",
    red: "text-critical",
    green: "text-positive",
    magenta: "text-accent",
    violet: "text-violet",
    blue: "text-info",
  };
  return (
    <div className="flex items-center justify-between gap-2 py-1 text-[11px]">
      <span className="uppercase tracking-[0.1em] text-faint">{label}</span>
      <span className={cn("flex items-center gap-1.5 font-semibold uppercase tracking-[0.08em]", toneText[tone])}>
        {pulse && <LivePulse tone={tone === "violet" || tone === "blue" ? "magenta" : (tone as never)} />}
        {state}
      </span>
    </div>
  );
}
