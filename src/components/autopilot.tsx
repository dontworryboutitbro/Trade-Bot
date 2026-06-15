"use client";

// Autopilot: while this panel is open and enabled, it (1) polls live equity
// every 30s for the session profit chart and (2) triggers an AI evaluation on
// a fixed interval plus order reconciliation every 5 minutes. All trades still
// pass the full server-side risk engine; this component only schedules work an
// admin could trigger by hand. It cannot bypass any limit.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui";
import { fmtUsd } from "@/lib/utils";
import { isAutonomousMode, type TradingMode } from "@/lib/types";

interface EquityPoint {
  time: string; // HH:MM:SS for display
  ts: number;
  equity: number;
}

const POLL_MS = 30_000;
const RECONCILE_MS = 5 * 60_000;
const STORAGE_KEY = "ffl-autopilot";

interface Persisted {
  enabled: boolean;
  evalMinutes: number;
  points: EquityPoint[];
  lastEvalAt: number;
  day: string;
}

const FALLBACK: Persisted = {
  enabled: false,
  evalMinutes: 30,
  points: [],
  lastEvalAt: 0,
  day: "",
};

function loadPersisted(): Persisted {
  const fallback: Persisted = { ...FALLBACK, day: new Date().toDateString() };
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Persisted;
    // Reset the chart each new day.
    if (parsed.day !== new Date().toDateString()) return fallback;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

export function Autopilot({ mode }: { mode: TradingMode }) {
  // Server and first client render must match: start from the static fallback
  // and hydrate persisted session state after mount.
  const [state, setState] = useState<Persisted>(FALLBACK);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => {
      setState(loadPersisted());
      setHydrated(true);
    }, 0);
    return () => clearTimeout(id);
  }, []);
  const [marketOpen, setMarketOpen] = useState<boolean | null>(null);
  const [lastAction, setLastAction] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const router = useRouter();

  const autonomous = isAutonomousMode(mode);

  // Persist on every change (only after the stored state has been loaded).
  useEffect(() => {
    if (!hydrated) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // storage full/unavailable — chart just won't survive a refresh
    }
  }, [state, hydrated]);

  const pollEquity = useCallback(async () => {
    try {
      const res = await fetch("/api/equity", { cache: "no-store" });
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? `Equity feed error ${res.status}`);
        return;
      }
      const data = await res.json();
      setError(null);
      setMarketOpen(data.marketOpen);
      const now = new Date();
      setState((prev) => {
        const point: EquityPoint = {
          time: now.toLocaleTimeString("en-US", { hour12: false, timeZone: "America/Chicago" }),
          ts: now.getTime(),
          equity: data.equity,
        };
        const last = prev.points[prev.points.length - 1];
        if (last && now.getTime() - last.ts < POLL_MS - 5_000) return prev;
        return { ...prev, points: [...prev.points, point].slice(-720) }; // ~6h at 30s
      });
    } catch {
      setError("Equity feed unreachable");
    }
  }, []);

  const runJob = useCallback(async (job: string): Promise<string> => {
    const res = await fetch("/api/admin/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return JSON.stringify(json.result ?? {});
  }, []);

  // Main autopilot loop.
  useEffect(() => {
    if (!hydrated || !state.enabled) return;
    let cancelled = false;
    let lastReconcile = 0;

    const tick = async () => {
      if (cancelled || busyRef.current) return;
      busyRef.current = true;
      try {
        await pollEquity();
        const now = Date.now();
        if (now - lastReconcile > RECONCILE_MS) {
          lastReconcile = now;
          await runJob("RECONCILE_ORDERS").catch(() => undefined);
        }
        if (now - state.lastEvalAt > state.evalMinutes * 60_000) {
          setState((prev) => ({ ...prev, lastEvalAt: now }));
          try {
            const summary = await runJob("AI_EVALUATION");
            setLastAction(
              `${new Date().toLocaleTimeString("en-US", { hour12: false, timeZone: "America/Chicago" })} — AI evaluation: ${summary.slice(0, 160)}`,
            );
            router.refresh();
          } catch (e) {
            setLastAction(
              `${new Date().toLocaleTimeString("en-US", { hour12: false, timeZone: "America/Chicago" })} — AI evaluation failed: ${e instanceof Error ? e.message.slice(0, 140) : "unknown"}`,
            );
          }
        }
      } finally {
        busyRef.current = false;
      }
    };

    tick();
    const interval = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, state.enabled, state.evalMinutes, state.lastEvalAt, pollEquity, runJob]);

  // Passive equity polling even when autopilot is off, so the chart is alive.
  useEffect(() => {
    if (!hydrated || state.enabled) return;
    const initial = setTimeout(pollEquity, 0);
    const interval = setInterval(pollEquity, POLL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [hydrated, state.enabled, pollEquity]);

  const first = state.points[0];
  const last = state.points[state.points.length - 1];
  const sessionPl = first && last ? last.equity - first.equity : 0;
  const sessionPlPct = first && last && first.equity > 0 ? (sessionPl / first.equity) * 100 : 0;

  return (
    <section className="rounded-lg border border-edge bg-surface">
      <header className="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-3">
        <h2 className="text-[13px] font-medium uppercase tracking-wider text-muted">
          Autopilot — live session
        </h2>
        {marketOpen !== null && (
          <Badge tone={marketOpen ? "green" : "muted"}>
            Market {marketOpen ? "open" : "closed"}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <select
            value={state.evalMinutes}
            onChange={(e) => setState((p) => ({ ...p, evalMinutes: Number(e.target.value) }))}
            className="rounded border border-edge-strong bg-raised px-2 py-1 text-xs"
            title="How often the AI reviews the portfolio while autopilot is on"
          >
            <option value={15}>AI check every 15 min</option>
            <option value={30}>AI check every 30 min</option>
            <option value={60}>AI check every 60 min</option>
          </select>
          <button
            onClick={() => setState((p) => ({ ...p, enabled: !p.enabled, lastEvalAt: 0 }))}
            className={`rounded border px-3 py-1.5 text-xs font-bold uppercase tracking-wide ${
              state.enabled
                ? "border-positive bg-positive/15 text-positive"
                : "border-edge-strong text-muted hover:border-accent hover:text-foreground"
            }`}
          >
            {state.enabled ? "Autopilot on" : "Start autopilot"}
          </button>
        </div>
      </header>

      <div className="p-4">
        {!autonomous && (
          <p className="mb-3 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-warning">
            Mode is {mode}: autopilot will create proposals, but they wait for your approval. For
            fully hands-off trading, switch to PAPER_AUTONOMOUS in Settings.
          </p>
        )}

        <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <span className="tabular text-2xl font-semibold">{fmtUsd(last?.equity)}</span>
          <span
            className={`tabular text-sm font-medium ${
              sessionPl > 0 ? "text-positive" : sessionPl < 0 ? "text-negative" : "text-muted"
            }`}
          >
            {sessionPl >= 0 ? "+" : ""}
            {fmtUsd(sessionPl)} ({sessionPlPct >= 0 ? "+" : ""}
            {sessionPlPct.toFixed(3)}%) this session
          </span>
          {state.enabled && (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-positive" />
              watching · next AI check ≤ {state.evalMinutes} min
            </span>
          )}
        </div>

        {state.points.length < 2 ? (
          <p className="py-8 text-center text-sm text-faint">
            Collecting live data — the graph draws a point every 30 seconds.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={state.points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid stroke="#232734" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="time"
                stroke="#5d6575"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                minTickGap={48}
              />
              <YAxis
                stroke="#5d6575"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                width={70}
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
              <Line
                type="monotone"
                dataKey="equity"
                stroke={sessionPl >= 0 ? "#4fae7c" : "#d4655f"}
                strokeWidth={1.8}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}

        {lastAction && <p className="mt-2 text-xs text-faint">{lastAction}</p>}
        {error && <p className="mt-2 text-xs text-critical">{error}</p>}
        <p className="mt-2 text-xs text-faint">
          Autopilot runs while this page is open. Every trade still passes the full risk engine
          (max 3 trades/day, market hours only). The kill switch stops everything instantly.
        </p>
      </div>
    </section>
  );
}
