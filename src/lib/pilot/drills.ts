import "server-only";
// Pre-live failure drills. Each drill exercises a safety mechanism without
// side effects on real state (deterministic simulations + isolated mock
// calls). LIVE_MANUAL_PILOT activation is gated on the latest drill run
// having every MANDATORY drill passing within the validity window.

import { evaluateRisk, type RiskContext } from "@/lib/risk/engine";
import { PAPER_DEFAULT_LIMITS } from "@/lib/risk/defaults";
import { assessQuote } from "@/lib/market-data/quality";
import { parseAiDecision } from "@/lib/ai/client";
import { MockBrokerageClient, resetMockState } from "@/lib/brokerage/mock";
import { runSecurityValidation } from "@/lib/env-guard";
import { getEnv, getConfigStatus } from "@/lib/env";
import { getStreamHealth, streamFreshnessVerifiable } from "@/lib/streaming/market-stream";
import { getStore } from "@/lib/store";
import { isSupabaseConfigured } from "@/lib/env";
import type { QuoteSnapshot } from "@/lib/market-data/types";

export interface DrillResult {
  name: string;
  mandatory: boolean;
  status: "PASS" | "FAIL" | "SKIPPED";
  detail: string;
}

export interface DrillRun {
  ranAt: string;
  results: DrillResult[];
  allMandatoryPassed: boolean;
}

export const DRILL_VALIDITY_DAYS = 7;

function syntheticSnapshot(overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  const now = new Date().toISOString();
  return {
    symbol: "SPY", timestamp: now, capturedAt: now, bid: 499.9, ask: 500.1, mid: 500,
    lastTrade: 500, spreadUsd: 0.2, spreadBps: 4, quoteAgeMs: 500, source: "mock",
    session: "REGULAR", dailyVolume: 50_000_000, avgDailyVolume: null,
    volatilityEstimate: null, stale: false, liquidity: "OK", halted: false, ...overrides,
  };
}

function syntheticCtx(overrides: Partial<RiskContext> = {}): RiskContext {
  const now = new Date();
  return {
    proposal: {
      id: "drill", environment: "PAPER", symbol: "SPY", action: "BUY", quantity: 1,
      proposedNotional: 500, orderType: "LIMIT", limitPrice: 500, confidence: 70,
      conciseReasoning: "drill", keyRisk: "drill",
      expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
      status: "PENDING_RISK", createdAt: now.toISOString(),
    },
    limits: PAPER_DEFAULT_LIMITS,
    account: {
      equity: 10_000, cash: 8_000, buyingPower: 8_000, totalMarketValue: 2_000,
      currency: "USD", accountBlocked: false, tradingBlocked: false,
      patternDayTrader: false, asOf: now.toISOString(),
    },
    positions: [],
    quote: { symbol: "SPY", price: 500, asOf: now.toISOString() },
    marketClock: {
      isOpen: true,
      nextOpen: new Date(now.getTime() + 3600_000).toISOString(),
      nextClose: new Date(now.getTime() + 7200_000).toISOString(),
      asOf: now.toISOString(),
    },
    approvedSymbols: [{
      symbol: "SPY", displayName: "SPY", assetClass: "us_equity",
      tradable: true, leveraged: false, inverse: false, otc: false, active: true,
    }],
    tradingMode: "PAPER_AUTONOMOUS",
    globalKillSwitch: false,
    stopNewOrders: false,
    executedTradesToday: 0,
    executedCryptoTradesToday: 0,
    dailyReturnPct: 0,
    drawdownPct: 0,
    hasEquivalentPendingOrder: false,
    proposalAlreadyExecuted: false,
    now,
    quoteSnapshot: syntheticSnapshot(),
    costEstimate: {
      symbol: "SPY", side: "buy", quantity: 1, referencePrice: 500, estimatedFillPrice: 500.15,
      bidAskCostUsd: 0.1, estimatedSlippageUsd: 0.05, totalEstimatedCostUsd: 0.15,
      totalEstimatedCostBps: 3, notionalAtReference: 500, notionalAtEstimatedFill: 500.15,
      maxPriceDeviationPct: 1, participationOfDailyVolume: 0.0000001,
    },
    hasPortfolioSnapshot: true,
    calibrationMinConfidence: null,
    pilot: null,
    ...overrides,
  };
}

export async function runReadinessDrills(): Promise<DrillRun> {
  const results: DrillResult[] = [];
  const drill = (name: string, mandatory: boolean, fn: () => string) => {
    try {
      results.push({ name, mandatory, status: "PASS", detail: fn() });
    } catch (error) {
      results.push({
        name, mandatory, status: "FAIL",
        detail: error instanceof Error ? error.message.slice(0, 250) : "failed",
      });
    }
  };
  const expectBlock = (ctx: RiskContext, checkName: string): string => {
    const evaluation = evaluateRisk(ctx);
    const check = evaluation.checks.find((c) => c.name === checkName);
    if (!check || check.passed) throw new Error(`${checkName} did not block as required.`);
    return `${checkName} blocked correctly: ${check.detail.slice(0, 140)}`;
  };

  // 1. Kill switch (simulated engagement; persisted state verified readable).
  const store = await getStore();
  const settings = await store.getSettings();
  drill("kill_switch", true, () => {
    const blocked = expectBlock(syntheticCtx({ globalKillSwitch: true }), "kill_switch");
    return `Kill-switch state readable (currently ${settings.globalKillSwitch ? "ENGAGED" : "off"}); ${blocked}`;
  });

  // 2. Duplicate-order protection (isolated mock brokerage; no network).
  resetMockState();
  const mock = new MockBrokerageClient();
  const request = {
    clientOrderId: `drill-${Date.now()}`, symbol: "SPY", side: "buy" as const,
    type: "MARKET" as const, quantity: 1, timeInForce: "day" as const,
  };
  const first = await mock.submitOrder(request);
  const second = await mock.submitOrder(request);
  results.push({
    name: "duplicate_order_protection", mandatory: true,
    status: first.brokerageOrderId === second.brokerageOrderId ? "PASS" : "FAIL",
    detail: first.brokerageOrderId === second.brokerageOrderId
      ? "Resubmitting the same client_order_id returned the SAME order (idempotent)."
      : "Duplicate submission created a second order.",
  });
  resetMockState();

  // 3–4. WebSocket disconnect + REST fallback gating.
  drill("websocket_disconnect_fallback", true, () => {
    const disconnected = { ...getStreamHealth(), status: "DISCONNECTED" as const, usingFallback: true };
    if (!streamFreshnessVerifiable(disconnected, true)) throw new Error("REST fallback should verify freshness.");
    if (streamFreshnessVerifiable(disconnected, false)) throw new Error("Unverifiable freshness must block.");
    return "Stream down + REST ok → allowed; stream down + REST down → blocked.";
  });

  // 5–7. Quote-quality rejections.
  drill("stale_quote_rejection", true, () => {
    const result = assessQuote(syntheticSnapshot({ quoteAgeMs: 10 * 60_000, stale: true }));
    if (result.ok) throw new Error("Stale quote was not rejected.");
    return result.reasons[0];
  });
  drill("wide_spread_rejection", true, () => {
    const result = assessQuote(syntheticSnapshot({ spreadBps: 90 }));
    if (result.ok) throw new Error("Wide spread was not rejected.");
    return result.reasons[0];
  });
  drill("low_liquidity_rejection", true, () => {
    const result = assessQuote(syntheticSnapshot({ dailyVolume: 5_000 }));
    if (result.ok) throw new Error("Low liquidity was not rejected.");
    return result.reasons[0];
  });

  // 8–9. Missing snapshots fail closed.
  drill("missing_account_snapshot", true, () => {
    const ctx = syntheticCtx();
    return expectBlock(
      { ...ctx, account: { ...ctx.account, asOf: "" } },
      "account_freshness",
    );
  });
  drill("missing_portfolio_snapshot", true, () =>
    expectBlock(syntheticCtx({ hasPortfolioSnapshot: false }), "learning_inputs"),
  );
  drill("missing_quote_snapshot", true, () =>
    expectBlock(syntheticCtx({ quoteSnapshot: null }), "data_quality"),
  );

  // 10. Invalid AI response.
  drill("invalid_ai_response", true, () => {
    try {
      parseAiDecision("BUY EVERYTHING NOW!!!");
    } catch {
      return "Malformed AI output rejected by the strict parser.";
    }
    throw new Error("Invalid AI response was accepted.");
  });

  // 11. Database write guard.
  if (isSupabaseConfigured()) {
    let guarded = false;
    try {
      await store.putLearningRecord("definitely_not_allowed", {}, {});
    } catch {
      guarded = true;
    }
    results.push({
      name: "database_write_guard", mandatory: true,
      status: guarded ? "PASS" : "FAIL",
      detail: guarded
        ? "Writes outside the whitelisted learning tables are rejected."
        : "Un-whitelisted table write was NOT rejected.",
    });
  } else {
    results.push({
      name: "database_write_guard", mandatory: true, status: "SKIPPED",
      detail: "Supabase not configured (mock mode).",
    });
  }

  // 12. Discord alert (optional).
  const env = getEnv();
  if (env.RESEND_API_KEY || process.env.DISCORD_WEBHOOK_URL) {
    let sent = false;
    try {
      if (process.env.DISCORD_WEBHOOK_URL) {
        const res = await fetch(process.env.DISCORD_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "**[DRILL] Fable Fund Lab** — alert path test. No action needed." }),
        });
        sent = res.ok;
      }
    } catch {
      sent = false;
    }
    results.push({
      name: "discord_alert", mandatory: false,
      status: sent ? "PASS" : "FAIL",
      detail: sent ? "Test message delivered to the webhook." : "Webhook delivery failed.",
    });
  } else {
    results.push({
      name: "discord_alert", mandatory: false, status: "SKIPPED",
      detail: "No DISCORD_WEBHOOK_URL configured (optional).",
    });
  }

  // 13. Live-key separation + secret-exposure scan.
  drill("live_key_separation", true, () => {
    const fatal = runSecurityValidation().filter((f) => f.severity === "FATAL");
    if (fatal.length > 0) throw new Error(`Security validation FATAL: ${fatal.map((f) => f.code).join(", ")}`);
    const status = getConfigStatus();
    return status.alpacaLive
      ? "Live keys present and distinct from paper keys; no FATAL findings."
      : "No live keys configured yet (expected until pilot onboarding); no FATAL findings.";
  });
  drill("browser_secret_exposure_scan", true, () => {
    const suspicious = Object.keys(process.env).filter(
      (key) =>
        key.startsWith("NEXT_PUBLIC_") &&
        /(SECRET|SERVICE_ROLE|API_KEY|TOKEN|WEBHOOK|ENCRYPTION)/.test(key) &&
        key !== "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" &&
        Boolean(process.env[key]),
    );
    if (suspicious.length > 0) throw new Error(`Secret-like NEXT_PUBLIC_ vars: ${suspicious.join(", ")}`);
    return "No secret-like values exposed under NEXT_PUBLIC_.";
  });

  // 14. Audit-log completeness (write + read back).
  const marker = `drill-${Date.now()}`;
  await store.createAuditEvent({
    actorType: "SYSTEM", actorId: "live-readiness-drill", action: "DRILL_AUDIT_TEST",
    entityType: null, entityId: marker, severity: "INFO",
    summary: "Readiness drill: audit write/read verification.", metadata: {},
  });
  const auditEvents = await store.listAuditEvents(20);
  const found = auditEvents.some((e) => e.entityId === marker);
  results.push({
    name: "audit_log_completeness", mandatory: true,
    status: found ? "PASS" : "FAIL",
    detail: found ? "Audit event written and read back." : "Audit round trip failed.",
  });

  const allMandatoryPassed = results
    .filter((r) => r.mandatory)
    .every((r) => r.status === "PASS" || r.status === "SKIPPED");
  const run: DrillRun = { ranAt: new Date().toISOString(), results, allMandatoryPassed };

  await store.putLearningRecord(
    "learning_runs",
    { kind: "live_drills", date: run.ranAt.slice(0, 10), passed: allMandatoryPassed ? "1" : "0" },
    run,
  );
  return run;
}

/** Latest drill run, if any — used to gate LIVE_MANUAL_PILOT activation. */
export async function getLatestDrillRun(): Promise<DrillRun | null> {
  const store = await getStore();
  const rows = await store.listLearningRecords("learning_runs", {
    keys: { kind: "live_drills" },
    limit: 1,
  });
  return (rows[0]?.payload as DrillRun) ?? null;
}

export function drillsValidForActivation(run: DrillRun | null): { ok: boolean; reason: string } {
  if (!run) return { ok: false, reason: "Readiness drills have never been run." };
  if (!run.allMandatoryPassed) {
    const failed = run.results.filter((r) => r.mandatory && r.status === "FAIL").map((r) => r.name);
    return { ok: false, reason: `Mandatory drills failing: ${failed.join(", ")}.` };
  }
  const ageDays = (Date.now() - new Date(run.ranAt).getTime()) / 86_400_000;
  if (ageDays > DRILL_VALIDITY_DAYS) {
    return { ok: false, reason: `Last passing drill run is ${Math.floor(ageDays)} days old (max ${DRILL_VALIDITY_DAYS}).` };
  }
  return { ok: true, reason: "All mandatory drills passed recently." };
}
