"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui";
import type { AppSettings, ApprovedSymbol, RiskLimits, TradingMode } from "@/lib/types";

async function post(url: string, body: unknown): Promise<{ ok: boolean; error?: string; result?: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, ...json } : { ok: false, error: json.error ?? res.statusText };
}

function Msg({ text, error }: { text: string | null; error?: boolean }) {
  if (!text) return null;
  return <p className={`mt-2 text-xs ${error ? "text-critical" : "text-positive"}`}>{text}</p>;
}

/* ============ Trading mode ============ */

const MODE_DESCRIPTIONS: Record<TradingMode, string> = {
  MOCK: "Simulated data only. No external requests.",
  PAPER_MANUAL: "Alpaca paper account. Every trade waits for your approval.",
  PAPER_AUTONOMOUS: "Alpaca paper account. Valid proposals execute automatically.",
  LIVE_LOCKED: "Live account, read-only. Verifies connectivity; can never trade.",
  LIVE_MANUAL: "REAL MONEY. Each trade requires your approval.",
  LIVE_AUTONOMOUS: "REAL MONEY. Valid proposals execute automatically.",
};

export function TradingModeCard({ settings }: { settings: AppSettings }) {
  const [target, setTarget] = useState<TradingMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const current = settings.tradingMode;

  async function simpleChange(to: TradingMode, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    const result = await post("/api/admin/mode", { from: current, to, ...extra });
    setBusy(false);
    if (!result.ok) setError(result.error ?? "Mode change failed");
    else {
      setTarget(null);
      router.refresh();
    }
  }

  function requestChange(to: TradingMode) {
    setError(null);
    if (to === "PAPER_AUTONOMOUS") {
      if (
        window.confirm(
          "Enable AUTONOMOUS paper trading?\n\nValid AI proposals will execute automatically on the paper account after passing every risk check. Every action is logged.",
        )
      ) {
        simpleChange(to, { autonomousAcknowledged: true });
      }
      return;
    }
    if (to === "LIVE_MANUAL" || to === "LIVE_AUTONOMOUS") {
      setTarget(to);
      return;
    }
    simpleChange(to);
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm text-muted">Current mode:</span>
        <span className="font-semibold">{current}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {(Object.keys(MODE_DESCRIPTIONS) as TradingMode[]).map((mode) => (
          <button
            key={mode}
            disabled={busy || mode === current}
            onClick={() => requestChange(mode)}
            className={`rounded-md border p-3 text-left text-sm transition-colors disabled:cursor-default ${
              mode === current
                ? "border-accent/60 bg-accent/10"
                : "border-edge hover:border-edge-strong"
            }`}
          >
            <div className="flex items-center gap-2 font-medium">
              {mode}
              {mode.startsWith("LIVE") && <Badge tone="red">Live</Badge>}
              {mode.startsWith("PAPER") && <Badge tone="amber">Paper</Badge>}
            </div>
            <p className="mt-1 text-xs text-muted">{MODE_DESCRIPTIONS[mode]}</p>
          </button>
        ))}
      </div>
      <Msg text={error} error />
      <p className="mt-3 text-xs text-faint">
        Live modes can only be enabled from LIVE_LOCKED after a connectivity check, a kill-switch
        test, acknowledgments, and a typed confirmation phrase. The AI can never change the mode.
      </p>
      {target && (
        <LiveActivationWizard
          from={current}
          to={target}
          onClose={() => setTarget(null)}
          onError={setError}
        />
      )}
    </div>
  );
}

function LiveActivationWizard({
  from,
  to,
  onClose,
  onError,
}: {
  from: TradingMode;
  to: TradingMode;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const phrase = to === "LIVE_MANUAL" ? "ENABLE LIVE MANUAL TRADING" : "ENABLE LIVE AUTONOMOUS TRADING";
  const [step, setStep] = useState(1);
  const [connectivityOk, setConnectivityOk] = useState(false);
  const [killSwitchTested, setKillSwitchTested] = useState(false);
  const [acks, setAcks] = useState({ isolated: false, limits: false, lossRisk: false, noAdvice: false });
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const router = useRouter();

  const allAcks = Object.values(acks).every(Boolean);

  async function testConnectivity() {
    setBusy(true);
    setNote(null);
    const result = await post("/api/admin/run", { job: "TEST_LIVE_CONNECTION" });
    setBusy(false);
    const check = (result.result ?? {}) as { ok?: boolean; detail?: string };
    if (result.ok && check.ok) {
      setConnectivityOk(true);
      setNote(`Connectivity verified: ${check.detail ?? ""}`);
    } else {
      setNote(`Connectivity check failed: ${check.detail ?? result.error ?? "unknown"}`);
    }
  }

  async function testKillSwitch() {
    setBusy(true);
    setNote(null);
    const engage = await post("/api/admin/kill-switch", {
      action: "ENGAGE",
      reason: "Pre-live kill-switch test",
    });
    if (!engage.ok) {
      setBusy(false);
      setNote(`Kill-switch test failed: ${engage.error}`);
      return;
    }
    const reset = await post("/api/admin/kill-switch", {
      action: "RESET",
      acknowledgment: "RESET KILL SWITCH",
    });
    await post("/api/admin/stop-orders", { stop: false });
    setBusy(false);
    if (reset.ok) {
      setKillSwitchTested(true);
      setNote("Kill switch engaged and reset successfully. Test passed.");
    } else {
      setNote(`Kill-switch reset failed: ${reset.error}`);
    }
  }

  async function activate() {
    setBusy(true);
    const result = await post("/api/admin/mode", {
      from,
      to,
      confirmationPhrase: typed,
      acknowledgmentsComplete: allAcks,
      killSwitchTested,
      liveConnectivityVerified: connectivityOk,
    });
    setBusy(false);
    if (!result.ok) {
      onError(result.error ?? "Activation failed");
      onClose();
    } else {
      onClose();
      router.refresh();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-critical/60 bg-surface p-5">
        <h2 className="text-base font-bold text-critical">
          {to === "LIVE_MANUAL" ? "Enable live manual trading" : "Enable live AUTONOMOUS trading"}
        </h2>
        <p className="mt-1 text-xs text-muted">
          Step {step} of 3 — this enables trading with real money on your isolated Alpaca live
          account.
        </p>

        {from !== "LIVE_LOCKED" && (
          <div className="mt-4 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm text-warning">
            You must switch to LIVE_LOCKED first and verify the live connection there. Close this
            dialog, select LIVE_LOCKED, then return.
          </div>
        )}

        {step === 1 && from === "LIVE_LOCKED" && (
          <div className="mt-4 space-y-3">
            <button
              disabled={busy}
              onClick={testConnectivity}
              className={`w-full rounded border px-3 py-2 text-sm font-medium ${connectivityOk ? "border-positive text-positive" : "border-edge-strong hover:border-accent"}`}
            >
              {connectivityOk ? "✓ Live connectivity verified" : "1. Test live account connectivity"}
            </button>
            <button
              disabled={busy}
              onClick={testKillSwitch}
              className={`w-full rounded border px-3 py-2 text-sm font-medium ${killSwitchTested ? "border-positive text-positive" : "border-edge-strong hover:border-accent"}`}
            >
              {killSwitchTested ? "✓ Kill-switch test passed" : "2. Run kill-switch test (engage + reset)"}
            </button>
            {note && <p className="text-xs text-muted">{note}</p>}
            <button
              disabled={!connectivityOk || !killSwitchTested}
              onClick={() => setStep(2)}
              className="w-full rounded bg-critical px-3 py-2 text-sm font-bold text-white disabled:opacity-40"
            >
              Continue
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="mt-4 space-y-2 text-sm">
            {(
              [
                ["isolated", "This Alpaca live account is isolated and holds only money I can afford to lose entirely."],
                ["limits", "I have reviewed the LIVE risk limits (max $1,000 funded, $100 per order, 3 trades/day, 2% daily loss halt, 8% drawdown halt)."],
                ["lossRisk", "AI-driven trading can lose money quickly. Past mock/paper results do not predict live results."],
                ["noAdvice", "This software is a personal tool, not investment advice. I am solely responsible for every trade."],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex cursor-pointer items-start gap-2 rounded border border-edge p-2.5 hover:border-edge-strong">
                <input
                  type="checkbox"
                  checked={acks[key]}
                  onChange={(e) => setAcks({ ...acks, [key]: e.target.checked })}
                  className="mt-0.5"
                />
                <span className="text-xs text-muted">{label}</span>
              </label>
            ))}
            <button
              disabled={!allAcks}
              onClick={() => setStep(3)}
              className="w-full rounded bg-critical px-3 py-2 text-sm font-bold text-white disabled:opacity-40"
            >
              Continue to final confirmation
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="mt-4 space-y-3">
            <div className="rounded-md border border-critical/60 bg-critical/10 p-3 text-sm text-critical">
              Final confirmation. Type the exact phrase:
              <code className="mt-1 block font-mono text-xs">{phrase}</code>
            </div>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Type the phrase exactly"
              className="w-full rounded border border-edge-strong bg-raised px-3 py-2 font-mono text-sm"
            />
            <button
              disabled={typed !== phrase || busy}
              onClick={activate}
              className="w-full rounded bg-critical px-3 py-2 text-sm font-bold text-white disabled:opacity-40"
            >
              {busy ? "Activating…" : `Activate ${to}`}
            </button>
          </div>
        )}

        <button onClick={onClose} className="mt-4 w-full rounded border border-edge px-3 py-2 text-sm text-muted hover:text-foreground">
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ============ Approved symbols ============ */

export function SymbolsCard({ symbols }: { symbols: ApprovedSymbol[] }) {
  const [newSymbol, setNewSymbol] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function add() {
    if (!newSymbol.trim()) return;
    setBusy(true);
    setMessage(null);
    const result = await post("/api/admin/symbols", { action: "ADD", symbol: newSymbol.trim() });
    setBusy(false);
    const detail = (result as { detail?: string }).detail;
    setIsError(!result.ok || !(result as { ok?: boolean }).ok);
    setMessage(detail ?? result.error ?? "Done");
    setNewSymbol("");
    router.refresh();
  }

  async function toggle(symbol: string, active: boolean) {
    setBusy(true);
    const result = await post("/api/admin/symbols", { action: "SET_ACTIVE", symbol, active });
    setBusy(false);
    if (!result.ok) {
      setIsError(true);
      setMessage(result.error ?? "Failed");
    }
    router.refresh();
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          value={newSymbol}
          onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
          placeholder="Add symbol (validated via brokerage)"
          className="flex-1 rounded border border-edge-strong bg-raised px-3 py-1.5 text-sm"
        />
        <button
          onClick={add}
          disabled={busy}
          className="rounded bg-accent/90 px-4 py-1.5 text-xs font-bold uppercase text-background hover:bg-accent disabled:opacity-40"
        >
          Validate
        </button>
      </div>
      <Msg text={message} error={isError} />
      <div className="mt-3 flex flex-wrap gap-1.5">
        {symbols.map((s) => (
          <button
            key={s.symbol}
            disabled={busy}
            onClick={() => toggle(s.symbol, !s.active)}
            title={`${s.displayName} — click to ${s.active ? "deactivate" : "activate"}`}
            className={`rounded border px-2.5 py-1 text-xs font-medium ${
              s.active
                ? "border-positive/50 bg-positive/10 text-positive"
                : "border-edge text-faint hover:text-muted"
            }`}
          >
            {s.symbol}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-faint">
        Green = active (tradable by the bot). The AI can suggest symbols but can never add or
        activate them.
      </p>
    </div>
  );
}

/* ============ Risk limits ============ */

export function RiskLimitsCard({ limits }: { limits: RiskLimits }) {
  const [form, setForm] = useState({
    maxPositions: limits.maxPositions,
    maxTotalExposurePct: limits.maxTotalExposurePct,
    maxSymbolExposurePct: limits.maxSymbolExposurePct,
    maxOrderNotional: limits.maxOrderNotional,
    maxTradesPerDay: limits.maxTradesPerDay,
    maxDailyLossPct: limits.maxDailyLossPct,
    maxDrawdownPct: limits.maxDrawdownPct,
    minSharePrice: limits.minSharePrice,
  });
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const loosening =
    form.maxPositions > limits.maxPositions ||
    form.maxTotalExposurePct > limits.maxTotalExposurePct ||
    form.maxSymbolExposurePct > limits.maxSymbolExposurePct ||
    form.maxOrderNotional > limits.maxOrderNotional ||
    form.maxTradesPerDay > limits.maxTradesPerDay ||
    form.maxDailyLossPct > limits.maxDailyLossPct ||
    form.maxDrawdownPct > limits.maxDrawdownPct ||
    form.minSharePrice < limits.minSharePrice;

  async function save() {
    let confirmation: string | null = null;
    if (loosening) {
      confirmation = window.prompt(
        `WARNING: you are LOOSENING risk limits for ${limits.environment}.\n\nCurrent → new values are recorded in the audit log.\n\nType "INCREASE RISK LIMITS" to confirm:`,
      );
      if (confirmation === null) return;
    }
    const reason = window.prompt("Reason for this change (recorded in the audit log):");
    if (reason === null || reason.trim() === "") return;
    setBusy(true);
    setMessage(null);
    const result = await post("/api/admin/risk-limits", {
      environment: limits.environment,
      ...form,
      maxLiveFundedBalance: limits.maxLiveFundedBalance,
      marketHoursOnly: limits.marketHoursOnly,
      confirmation,
      reason,
    });
    setBusy(false);
    setIsError(!result.ok);
    setMessage(result.ok ? "Limits saved." : (result.error ?? "Failed"));
    router.refresh();
  }

  const fields: { key: keyof typeof form; label: string }[] = [
    { key: "maxPositions", label: "Max positions" },
    { key: "maxTotalExposurePct", label: "Max total exposure %" },
    { key: "maxSymbolExposurePct", label: "Max per-symbol %" },
    {
      key: "maxOrderNotional",
      label: limits.maxOrderNotionalIsPct ? "Max order (% equity)" : "Max order ($)",
    },
    { key: "maxTradesPerDay", label: "Max trades / day" },
    { key: "maxDailyLossPct", label: "Daily loss halt %" },
    { key: "maxDrawdownPct", label: "Drawdown halt %" },
    { key: "minSharePrice", label: "Min share price $" },
  ];

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {fields.map(({ key, label }) => (
          <label key={key} className="text-xs text-muted">
            {label}
            <input
              type="number"
              step="any"
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })}
              className="tabular mt-1 w-full rounded border border-edge-strong bg-raised px-2 py-1.5 text-sm text-foreground"
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={save}
          disabled={busy}
          className={`rounded px-4 py-1.5 text-xs font-bold uppercase tracking-wide ${
            loosening ? "bg-critical text-white" : "bg-accent/90 text-background hover:bg-accent"
          } disabled:opacity-40`}
        >
          {loosening ? "Save (loosens limits)" : "Save limits"}
        </button>
        <span className="text-xs text-faint">
          Margin, options, shorting, crypto, leveraged/inverse ETFs and OTC are permanently
          prohibited and cannot be enabled here.
        </span>
      </div>
      <Msg text={message} error={isError} />
    </div>
  );
}

/* ============ Automation ============ */

const JOBS = [
  { job: "SYNC_ACCOUNT", label: "Sync account" },
  { job: "RECONCILE_ORDERS", label: "Reconcile orders" },
  { job: "CAPTURE_SNAPSHOT", label: "Capture snapshot" },
  { job: "HEALTH_CHECK", label: "Health check" },
  { job: "AI_EVALUATION", label: "AI evaluation" },
] as const;

export function AutomationCard({ settings }: { settings: AppSettings }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const router = useRouter();

  async function run(job: string) {
    setBusy(job);
    setMessage(null);
    const result = await post("/api/admin/run", { job });
    setBusy(null);
    setIsError(!result.ok);
    setMessage(
      result.ok ? `${job} completed: ${JSON.stringify(result.result).slice(0, 300)}` : (result.error ?? "Failed"),
    );
    router.refresh();
  }

  async function setFrequency(frequency: string) {
    setBusy("freq");
    const result = await post("/api/admin/run", { job: "SET_EVALUATION_FREQUENCY", frequency });
    setBusy(null);
    setIsError(!result.ok);
    if (!result.ok) setMessage(result.error ?? "Failed");
    router.refresh();
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {JOBS.map(({ job, label }) => (
          <button
            key={job}
            disabled={busy !== null}
            onClick={() => run(job)}
            className="rounded border border-edge-strong px-3 py-1.5 text-xs font-medium text-muted hover:border-accent hover:text-foreground disabled:opacity-40"
          >
            {busy === job ? "Running…" : `Run ${label}`}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 text-sm">
        <span className="text-xs text-muted">AI evaluation frequency:</span>
        <select
          value={settings.aiEvaluationFrequency}
          disabled={busy !== null}
          onChange={(e) => setFrequency(e.target.value)}
          className="rounded border border-edge-strong bg-raised px-2 py-1 text-xs"
        >
          <option value="DAILY">Once each trading day</option>
          <option value="WEEKLY">Weekly (Mondays)</option>
          <option value="MANUAL_ONLY">Manual only</option>
        </select>
      </div>
      <Msg text={message} error={isError} />
    </div>
  );
}

export function SettingsSection({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
