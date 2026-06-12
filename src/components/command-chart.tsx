"use client";

// Central command-center chart: portfolio equity / SPY comparison / drawdown
// with compact range controls. Magenta primary, violet benchmark, deep-black
// chart surface, restrained motion.

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtDate, fmtUsd } from "@/lib/utils";

export interface CommandPoint {
  capturedAt: string;
  equity: number;
  totalReturnPct: number;
  benchmarkReturnPct: number | null;
  drawdownPct: number;
}

type ChartMode = "PORTFOLIO" | "VS SPY" | "DRAWDOWN";
type Range = "5D" | "1M" | "3M" | "YTD" | "ALL";

const TOOLTIP_STYLE = {
  background: "#171a23",
  border: "1px solid #323848",
  borderRadius: 6,
  fontSize: 12,
} as const;

function cutoff(range: Range): string {
  const now = new Date();
  if (range === "5D") now.setDate(now.getDate() - 7);
  else if (range === "1M") now.setMonth(now.getMonth() - 1);
  else if (range === "3M") now.setMonth(now.getMonth() - 3);
  else if (range === "YTD") return `${new Date().getFullYear()}-01-01`;
  else return "1970-01-01";
  return now.toISOString();
}

export function CommandChart({ points }: { points: CommandPoint[] }) {
  const [mode, setMode] = useState<ChartMode>("PORTFOLIO");
  const [range, setRange] = useState<Range>("3M");

  const data = useMemo(() => {
    const from = cutoff(range);
    return points
      .filter((p) => p.capturedAt >= from)
      .map((p) => ({
        date: fmtDate(p.capturedAt),
        equity: Math.round(p.equity * 100) / 100,
        bot: Math.round(p.totalReturnPct * 100) / 100,
        spy: p.benchmarkReturnPct === null ? null : Math.round(p.benchmarkReturnPct * 100) / 100,
        dd: -Math.abs(Math.round(p.drawdownPct * 100) / 100),
      }));
  }, [points, range]);

  const controls = (
    <div className="flex flex-wrap items-center gap-1.5">
      {(["PORTFOLIO", "VS SPY", "DRAWDOWN"] as ChartMode[]).map((m) => (
        <button
          key={m}
          onClick={() => setMode(m)}
          className={`rounded-[4px] border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] transition-colors ${
            mode === m
              ? "border-accent/60 bg-accent/10 text-accent"
              : "border-edge text-faint hover:text-muted"
          }`}
        >
          {m}
        </button>
      ))}
      <span className="mx-1 h-3 w-px bg-edge" />
      {(["5D", "1M", "3M", "YTD", "ALL"] as Range[]).map((r) => (
        <button
          key={r}
          onClick={() => setRange(r)}
          className={`rounded-[4px] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] transition-colors ${
            range === r ? "bg-violet/15 text-violet" : "text-faint hover:text-muted"
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  );

  if (data.length < 2) {
    return (
      <div>
        {controls}
        <p className="py-14 text-center text-[12px] uppercase tracking-wide text-faint">
          Awaiting snapshots for this range
        </p>
      </div>
    );
  }

  return (
    <div>
      {controls}
      <div className="mt-3">
        <ResponsiveContainer width="100%" height={300}>
          {mode === "PORTFOLIO" ? (
            <AreaChart data={data} margin={{ top: 8, right: 6, bottom: 0, left: 6 }}>
              <defs>
                <linearGradient id="cmdFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#e0409a" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="#e0409a" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#232734" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" stroke="#5d6575" fontSize={10} tickLine={false} axisLine={false} minTickGap={40} />
              <YAxis stroke="#5d6575" fontSize={10} tickLine={false} axisLine={false} width={66} domain={["auto", "auto"]} tickFormatter={(v: number) => fmtUsd(v, 0)} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: "#9aa3b2" }} formatter={(v) => [fmtUsd(Number(v)), "Equity"]} />
              <Area type="monotone" dataKey="equity" stroke="#e0409a" strokeWidth={1.6} fill="url(#cmdFill)" isAnimationActive={false} />
            </AreaChart>
          ) : mode === "VS SPY" ? (
            <LineChart data={data} margin={{ top: 8, right: 6, bottom: 0, left: 6 }}>
              <CartesianGrid stroke="#232734" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" stroke="#5d6575" fontSize={10} tickLine={false} axisLine={false} minTickGap={40} />
              <YAxis stroke="#5d6575" fontSize={10} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => `${v}%`} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: "#9aa3b2" }} formatter={(v, name) => [`${Number(v).toFixed(2)}%`, name === "bot" ? "Bot" : "SPY"]} />
              <Line type="monotone" dataKey="bot" stroke="#e0409a" strokeWidth={1.6} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="spy" stroke="#8b6cd9" strokeWidth={1.4} dot={false} isAnimationActive={false} />
            </LineChart>
          ) : (
            <AreaChart data={data} margin={{ top: 8, right: 6, bottom: 0, left: 6 }}>
              <CartesianGrid stroke="#232734" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" stroke="#5d6575" fontSize={10} tickLine={false} axisLine={false} minTickGap={40} />
              <YAxis stroke="#5d6575" fontSize={10} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => `${v}%`} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: "#9aa3b2" }} formatter={(v) => [`${Number(v).toFixed(2)}%`, "Drawdown"]} />
              <Area type="monotone" dataKey="dd" stroke="#d45a5f" strokeWidth={1.4} fill="rgba(212,90,95,0.12)" isAnimationActive={false} />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
      {mode === "VS SPY" && (
        <div className="mt-1.5 flex gap-4 text-[10px] uppercase tracking-[0.1em] text-faint">
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-accent" /> Bot</span>
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-violet" /> SPY</span>
        </div>
      )}
    </div>
  );
}
