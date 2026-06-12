"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtDate, fmtUsd } from "@/lib/utils";

export interface EquityPoint {
  capturedAt: string;
  equity: number;
  benchmarkReturnPct: number | null;
  totalReturnPct: number;
}

export function EquityChart({ points, height = 260 }: { points: EquityPoint[]; height?: number }) {
  if (points.length < 2) {
    return (
      <p className="py-10 text-center text-sm text-faint">
        Not enough snapshots yet — the chart fills in as daily snapshots are captured.
      </p>
    );
  }
  const data = points.map((p) => ({
    date: fmtDate(p.capturedAt),
    equity: Math.round(p.equity * 100) / 100,
    bot: Math.round(p.totalReturnPct * 100) / 100,
    spy: p.benchmarkReturnPct === null ? null : Math.round(p.benchmarkReturnPct * 100) / 100,
  }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e0409a" stopOpacity={0.25} />
            <stop offset="100%" stopColor="#e0409a" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#232734" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" stroke="#5d6575" fontSize={11} tickLine={false} axisLine={false} />
        <YAxis
          stroke="#5d6575"
          fontSize={11}
          tickLine={false}
          axisLine={false}
          width={64}
          domain={["auto", "auto"]}
          tickFormatter={(v: number) => fmtUsd(v, 0)}
        />
        <Tooltip
          contentStyle={{
            background: "#171a23",
            border: "1px solid #323848",
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: "#9aa3b2" }}
          formatter={(value) => [fmtUsd(Number(value)), "Equity"]}
        />
        <Area
          type="monotone"
          dataKey="equity"
          stroke="#e0409a"
          strokeWidth={1.8}
          fill="url(#equityFill)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function BenchmarkChart({
  points,
  height = 260,
}: {
  points: EquityPoint[];
  height?: number;
}) {
  if (points.length < 2) {
    return (
      <p className="py-10 text-center text-sm text-faint">
        Not enough snapshots for a benchmark comparison yet.
      </p>
    );
  }
  const data = points.map((p) => ({
    date: fmtDate(p.capturedAt),
    bot: Math.round(p.totalReturnPct * 100) / 100,
    spy: p.benchmarkReturnPct === null ? null : Math.round(p.benchmarkReturnPct * 100) / 100,
  }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid stroke="#232734" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" stroke="#5d6575" fontSize={11} tickLine={false} axisLine={false} />
        <YAxis
          stroke="#5d6575"
          fontSize={11}
          tickLine={false}
          axisLine={false}
          width={48}
          tickFormatter={(v: number) => `${v}%`}
        />
        <Tooltip
          contentStyle={{
            background: "#171a23",
            border: "1px solid #323848",
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: "#9aa3b2" }}
          formatter={(value, name) => [
            `${Number(value).toFixed(2)}%`,
            name === "bot" ? "Bot" : "SPY",
          ]}
        />
        <Line type="monotone" dataKey="bot" stroke="#e0409a" strokeWidth={1.8} dot={false} />
        <Line type="monotone" dataKey="spy" stroke="#8b6cd9" strokeWidth={1.5} dot={false} />
        <Area type="monotone" dataKey="bot" stroke="none" fill="transparent" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
