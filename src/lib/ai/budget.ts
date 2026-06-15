import "server-only";
// AI cost control. The learning engine is free (deterministic); the only spend
// is the trade-evaluation call to Claude. Two cheap gates protect the balance:
//
//   1. Daily budget  — a hard cap on Claude calls per day (per env/mode).
//   2. Actionable preflight — skip the call entirely when no trade could
//      possibly be placed right now (market closed with no crypto, daily trade
//      capacity exhausted, or no candidates). Skipping is strictly safer than
//      calling — it can only prevent trades, never cause one.
//
// MOCK mode uses the free MockDecisionClient, so it is never throttled.

import type { MarketClock, RiskLimits, TradingMode } from "@/lib/types";
import type { Store } from "@/lib/store/types";

/** Per-day Claude-call ceiling. Env override, else conservative per-mode default. */
export function getAiDailyBudget(mode: TradingMode): number {
  const raw = process.env.AI_DAILY_BUDGET;
  const override = raw ? Number(raw) : NaN;
  if (Number.isFinite(override) && override >= 0) return override;
  if (mode === "MOCK") return Number.POSITIVE_INFINITY; // free client
  if (mode === "PAPER_MANUAL" || mode === "PAPER_AUTONOMOUS") return 4; // learning/growing: keep it cheap
  return 12; // live modes: more responsive (real money at stake)
}

function todayKey(): string {
  // Central calendar day — matches the dashboard's display zone.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
}

/** Count Claude invocations recorded today (free; reads the learning store). */
export async function countAiInvocationsToday(store: Store): Promise<number> {
  try {
    const rows = await store.listLearningRecords("learning_runs", {
      keys: { kind: "ai_invocation", date: todayKey() },
      limit: 200,
    });
    return rows.length;
  } catch {
    return 0;
  }
}

/** Record a real Claude call so the daily budget can be enforced. */
export async function recordAiInvocation(store: Store, triggeredBy: string): Promise<void> {
  try {
    await store.putLearningRecord(
      "learning_runs",
      { kind: "ai_invocation", date: todayKey() },
      { triggeredBy, at: new Date().toISOString() },
    );
  } catch {
    // counting is best-effort; never block the pipeline
  }
}

export interface BudgetState {
  used: number;
  budget: number;
  remaining: number;
}

export async function getBudgetState(store: Store, mode: TradingMode): Promise<BudgetState> {
  const budget = getAiDailyBudget(mode);
  const used = mode === "MOCK" ? 0 : await countAiInvocationsToday(store);
  return { used, budget, remaining: Math.max(0, budget - used) };
}

export interface PreflightInputs {
  mode: TradingMode;
  marketClock: MarketClock;
  limits: RiskLimits;
  activeSymbols: string[];
  candidatePool: string[];
  positionSymbols: string[];
  equityTradesToday: number;
  cryptoTradesToday: number;
}

/**
 * Cheap deterministic check: is ANY order possible right now? If not, there is
 * no reason to pay Claude to think. Returns a skip reason or null (proceed).
 */
export function actionablePreflight(input: PreflightInputs): string | null {
  const isCrypto = (s: string) => s.includes("/");
  const cryptoEnabled = input.limits.allowCrypto;
  const hasEquityCandidate =
    input.candidatePool.some((s) => !isCrypto(s)) || input.positionSymbols.some((s) => !isCrypto(s));
  const hasCryptoCandidate =
    cryptoEnabled &&
    (input.candidatePool.some(
      (s) => isCrypto(s) && input.activeSymbols.includes(s),
    ) ||
      input.positionSymbols.some(isCrypto));

  // Equity capacity: market open + under the daily trade cap + something to act on.
  const equityCapacity =
    input.marketClock.isOpen &&
    input.equityTradesToday < input.limits.maxTradesPerDay &&
    hasEquityCandidate;

  // Crypto capacity: 24/7 + under the crypto daily cap + an eligible pair.
  const cryptoCapacity =
    hasCryptoCandidate &&
    input.cryptoTradesToday < (input.limits.maxCryptoTradesPerDay ?? 0);

  if (!equityCapacity && !cryptoCapacity) {
    if (!input.marketClock.isOpen && !hasCryptoCandidate) {
      return "Market closed and no eligible crypto — no trade possible. Skipping the AI call to save cost.";
    }
    if (input.candidatePool.length === 0 && input.positionSymbols.length === 0) {
      return "No ranked candidates and no open positions — nothing to evaluate. Skipping the AI call.";
    }
    return "Daily trade capacity exhausted (no equity or crypto headroom). Skipping the AI call.";
  }
  return null;
}
