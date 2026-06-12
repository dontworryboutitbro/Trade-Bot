"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface BacktestSummary {
  strategyId: string;
  startDate: string;
  endDate: string;
  symbolCount: number;
  metrics: {
    totalReturnPct: number;
    benchmarkReturnPct: number | null;
    excessReturnPct: number | null;
    maxDrawdownPct: number;
    sharpe: number | null;
    winRatePct: number;
    profitFactor: number | null;
    expectancyUsd: number;
    tradeCount: number;
    totalCostsUsd: number;
    warnings: string[];
  };
  walkForward: {
    outOfSampleScore: number | null;
    warnings: string[];
    windows: { label: string; inSampleReturnPct: number; outOfSampleReturnPct: number }[];
  };
}

export function BacktestRunner({ strategies }: { strategies: { id: string; name: string }[] }) {
  const [strategyId, setStrategyId] = useState(strategies[0]?.id ?? "");
  const [days, setDays] = useState(500);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<BacktestSummary | null>(null);
  const router = useRouter();

  async function run() {
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const res = await fetch("/api/admin/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategyId, days, costBpsPerSide: 10 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setError(json.error ?? "Backtest failed");
      else {
        setSummary(json.result);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={strategyId}
          onChange={(e) => setStrategyId(e.target.value)}
          className="rounded border border-edge-strong bg-raised px-2 py-1.5 text-sm"
        >
          {strategies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="rounded border border-edge-strong bg-raised px-2 py-1.5 text-sm"
        >
          <option value={250}>~1 year</option>
          <option value={500}>~2 years</option>
          <option value={750}>~3 years</option>
        </select>
        <button
          onClick={run}
          disabled={busy || !strategyId}
          className="rounded bg-accent/90 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-background hover:bg-accent disabled:opacity-40"
        >
          {busy ? "Running…" : "Run backtest"}
        </button>
        <span className="text-xs text-faint">
          Daily bars, next-open fills, 10 bps/side costs, walk-forward splits. One positive backtest
          is not proof a strategy works.
        </span>
      </div>
      {error && <p className="mt-2 text-xs text-critical">{error}</p>}
      {summary && (
        <div className="mt-4 rounded-md border border-edge bg-raised p-3 text-sm">
          <div className="tabular grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-faint">Return</div>
              <div className={summary.metrics.totalReturnPct >= 0 ? "text-positive" : "text-negative"}>
                {summary.metrics.totalReturnPct.toFixed(1)}%
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-faint">vs SPY</div>
              <div>{summary.metrics.excessReturnPct?.toFixed(1) ?? "—"}%</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-faint">Max DD</div>
              <div className="text-negative">-{summary.metrics.maxDrawdownPct.toFixed(1)}%</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-faint">Trades / Win%</div>
              <div>
                {summary.metrics.tradeCount} / {summary.metrics.winRatePct.toFixed(0)}%
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-faint">Sharpe</div>
              <div>{summary.metrics.sharpe?.toFixed(2) ?? "—"}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-faint">Profit factor</div>
              <div>{summary.metrics.profitFactor?.toFixed(2) ?? "—"}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-faint">Est. costs</div>
              <div>${summary.metrics.totalCostsUsd.toFixed(0)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-faint">OS score</div>
              <div>{summary.walkForward.outOfSampleScore?.toFixed(2) ?? "—"}</div>
            </div>
          </div>
          {summary.walkForward.windows.length > 0 && (
            <div className="tabular mt-3 text-xs text-muted">
              Walk-forward:{" "}
              {summary.walkForward.windows
                .map(
                  (w) =>
                    `${w.label} IS ${w.inSampleReturnPct.toFixed(1)}% → OS ${w.outOfSampleReturnPct.toFixed(1)}%`,
                )
                .join(" · ")}
            </div>
          )}
          {[...summary.metrics.warnings, ...summary.walkForward.warnings].length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-warning">
              {[...summary.metrics.warnings, ...summary.walkForward.warnings].map((w) => (
                <li key={w}>⚠ {w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
