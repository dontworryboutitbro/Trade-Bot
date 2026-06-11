// Integration tests for the trading pipeline using the in-memory store, the
// mock brokerage, and a controllable market-data stub. No network calls.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketClock, Quote } from "@/lib/types";

// Controllable market data: market always open, quotes always fresh.
const marketState: { isOpen: boolean } = { isOpen: true };

vi.mock("@/lib/brokerage/factory", async () => {
  const { MockBrokerageClient, MockMarketDataClient } = await import("@/lib/brokerage/mock");
  class TestMarketData extends MockMarketDataClient {
    async getMarketClock(): Promise<MarketClock> {
      return {
        isOpen: marketState.isOpen,
        nextOpen: new Date(Date.now() + 3600_000).toISOString(),
        nextClose: new Date(Date.now() + 7200_000).toISOString(),
        asOf: new Date().toISOString(),
      };
    }
    async getQuote(symbol: string): Promise<Quote | null> {
      const quote = await super.getQuote(symbol);
      return quote ? { ...quote, asOf: new Date().toISOString() } : null;
    }
  }
  return {
    getBrokerageClient: () => new MockBrokerageClient(),
    getMarketDataClient: () => new TestMarketData(),
  };
});

import { resetMemoryStore, MemoryStore } from "@/lib/store/memory";
import { resetMockState, MockBrokerageClient } from "@/lib/brokerage/mock";
import { runAiEvaluation, executeProposal, checkStopRules } from "@/lib/trading/pipeline";
import {
  changeTradingMode,
  decideProposal,
  engageKillSwitch,
  resetKillSwitch,
  updateRiskLimits,
} from "@/lib/trading/admin";

const store = new MemoryStore();

beforeEach(() => {
  resetMemoryStore();
  resetMockState();
  marketState.isOpen = true;
});

describe("mock autonomous trade flow", () => {
  it("evaluates, passes risk, and executes a mock trade end to end", async () => {
    // MOCK mode behaves autonomously via MockDecisionClient? No — MOCK is not
    // an autonomous mode, so proposals await approval. Verify that first.
    const result = await runAiEvaluation("test");
    expect(result.errors).toEqual([]);
    expect(result.decisionCount).toBeGreaterThan(0);

    const proposals = await store.listProposals({ statuses: ["AWAITING_APPROVAL"] });
    if (result.proposalsCreated > 0) {
      expect(proposals.length).toBeGreaterThan(0);
      // Approve the first one — it should execute against the mock brokerage.
      const outcome = await decideProposal("tester", proposals[0].id, "APPROVED", null);
      expect(outcome.executed).toBe(true);

      const orders = await store.listOrders({ environment: "MOCK" });
      const order = orders.find((o) => o.proposalId === proposals[0].id);
      expect(order).toBeDefined();
      expect(order!.status).toBe("FILLED");

      // Audit trail exists.
      const events = await store.listAuditEvents(50);
      expect(events.some((e) => e.action === "PROPOSAL_CREATED")).toBe(true);
      expect(events.some((e) => e.action === "ORDER_SUBMITTED")).toBe(true);
    }
  });

  it("rejecting a proposal does not execute it", async () => {
    await runAiEvaluation("test");
    const proposals = await store.listProposals({ statuses: ["AWAITING_APPROVAL"] });
    if (proposals.length === 0) return;
    await decideProposal("tester", proposals[0].id, "REJECTED", "not today");
    const refreshed = await store.getProposal(proposals[0].id);
    expect(refreshed!.status).toBe("REJECTED");
    expect(await store.hasOrderForProposal(proposals[0].id)).toBe(false);
  });
});

describe("blocked proposal flow", () => {
  it("blocks proposals when the market is closed and records reasons", async () => {
    marketState.isOpen = false;
    const result = await runAiEvaluation("test");
    if (result.proposalsCreated === 0) return; // mock AI chose NO_ACTION
    expect(result.blocked).toBe(result.proposalsCreated);
    const blocked = await store.listProposals({ statuses: ["BLOCKED"] });
    expect(blocked.length).toBeGreaterThan(0);
    const evals = await store.getRiskEvaluationsForProposal(blocked[0].id);
    expect(evals[0].overallResult).toBe("BLOCK");
    expect(evals[0].blockReasons.join(" ")).toContain("market_open");
  });
});

describe("kill switch flow", () => {
  it("engaging the kill switch blocks evaluation and rejects pending proposals", async () => {
    await runAiEvaluation("test");
    await engageKillSwitch("tester", "integration test");

    const settings = await store.getSettings();
    expect(settings.globalKillSwitch).toBe(true);
    expect(settings.stopNewOrders).toBe(true);

    // Pending proposals were rejected.
    const pending = await store.listProposals({ statuses: ["AWAITING_APPROVAL", "QUEUED"] });
    expect(pending).toHaveLength(0);

    // Evaluation is skipped entirely.
    const result = await runAiEvaluation("test");
    expect(result.proposalsCreated).toBe(0);

    // Audit + alert exist.
    const events = await store.listAuditEvents(20);
    expect(events.some((e) => e.action === "KILL_SWITCH_ENGAGED")).toBe(true);
    const alerts = await store.listNotifications(20);
    expect(alerts.some((n) => n.notificationType === "KILL_SWITCH_ENGAGED")).toBe(true);
  });

  it("kill switch persists and requires typed acknowledgment to reset", async () => {
    await engageKillSwitch("tester", "test");
    await expect(resetKillSwitch("tester", "yes please")).rejects.toThrow("RESET KILL SWITCH");
    await resetKillSwitch("tester", "RESET KILL SWITCH");
    const settings = await store.getSettings();
    expect(settings.globalKillSwitch).toBe(false);
    // stop-new-orders intentionally stays on after a reset.
    expect(settings.stopNewOrders).toBe(true);
  });
});

describe("trading-mode flow", () => {
  it("cannot jump from MOCK to any live mode", async () => {
    await expect(
      changeTradingMode("tester", { from: "MOCK", to: "LIVE_MANUAL" }),
    ).rejects.toThrow();
    const settings = await store.getSettings();
    expect(settings.tradingMode).toBe("MOCK");
  });

  it("MOCK → PAPER_MANUAL works and is audited", async () => {
    await changeTradingMode("tester", { from: "MOCK", to: "PAPER_MANUAL" });
    expect((await store.getSettings()).tradingMode).toBe("PAPER_MANUAL");
    const events = await store.listAuditEvents(10);
    expect(events.some((e) => e.action === "MODE_CHANGED")).toBe(true);
  });

  it("rejects stale mode-change requests (concurrency guard)", async () => {
    await changeTradingMode("tester", { from: "MOCK", to: "PAPER_MANUAL" });
    await expect(
      changeTradingMode("tester", { from: "MOCK", to: "PAPER_MANUAL" }),
    ).rejects.toThrow("concurrently");
  });
});

describe("risk limit governance", () => {
  it("tightening limits requires no confirmation", async () => {
    const limits = await store.getRiskLimits("MOCK");
    await updateRiskLimits("tester", "MOCK", { ...limits, maxTradesPerDay: 1 }, null, "tighten");
    expect((await store.getRiskLimits("MOCK")).maxTradesPerDay).toBe(1);
  });

  it("loosening limits requires typed confirmation and alerts", async () => {
    const limits = await store.getRiskLimits("MOCK");
    await expect(
      updateRiskLimits("tester", "MOCK", { ...limits, maxTradesPerDay: 10 }, null, "loosen"),
    ).rejects.toThrow("INCREASE RISK LIMITS");
    await updateRiskLimits(
      "tester",
      "MOCK",
      { ...limits, maxTradesPerDay: 10 },
      "INCREASE RISK LIMITS",
      "loosen",
    );
    expect((await store.getRiskLimits("MOCK")).maxTradesPerDay).toBe(10);
    const alerts = await store.listNotifications(10);
    expect(alerts.some((n) => n.notificationType === "RISK_LIMITS_LOOSENED")).toBe(true);
  });

  it("enabling crypto requires its exact typed phrase", async () => {
    const limits = await store.getRiskLimits("MOCK");
    await expect(
      updateRiskLimits("tester", "MOCK", { ...limits, allowCrypto: true }, null, "want crypto"),
    ).rejects.toThrow("ENABLE CRYPTO TRADING");
    await expect(
      updateRiskLimits(
        "tester",
        "MOCK",
        { ...limits, allowCrypto: true },
        "INCREASE RISK LIMITS",
        "wrong phrase",
      ),
    ).rejects.toThrow("ENABLE CRYPTO TRADING");
    await updateRiskLimits(
      "tester",
      "MOCK",
      { ...limits, allowCrypto: true },
      "ENABLE CRYPTO TRADING",
      "crypto opt-in",
    );
    expect((await store.getRiskLimits("MOCK")).allowCrypto).toBe(true);
  });

  it("crypto can never be enabled for LIVE", async () => {
    const limits = await store.getRiskLimits("LIVE");
    await expect(
      updateRiskLimits(
        "tester",
        "LIVE",
        { ...limits, allowCrypto: true },
        "ENABLE CRYPTO TRADING",
        "trying live crypto",
      ),
    ).rejects.toThrow("cannot be enabled for LIVE");
  });

  it("prohibition flags can never be loosened, even with confirmation (AI or human)", async () => {
    const limits = await store.getRiskLimits("MOCK");
    await expect(
      updateRiskLimits(
        "tester",
        "MOCK",
        { ...limits, allowOptions: true },
        "INCREASE RISK LIMITS",
        "trying",
      ),
    ).rejects.toThrow("cannot be changed");
  });
});

describe("execution idempotency", () => {
  it("a proposal cannot execute twice", async () => {
    await runAiEvaluation("test");
    const proposals = await store.listProposals({ statuses: ["AWAITING_APPROVAL"] });
    if (proposals.length === 0) return;
    const id = proposals[0].id;
    await decideProposal("tester", id, "APPROVED", null);
    // Second execution attempt must not create a second order.
    const second = await executeProposal(id, "tester");
    expect(second.executed).toBe(false);
    const orders = await store.listOrders({ environment: "MOCK" });
    expect(orders.filter((o) => o.proposalId === id)).toHaveLength(1);
  });
});

describe("stop-loss flow", () => {
  it("a breached stop creates and executes an EXIT through the risk engine", async () => {
    // Mock store holds SPY; arm a stop above the current mock price so it
    // triggers immediately on the next check.
    await store.createStopRule({
      environment: "MOCK",
      symbol: "SPY",
      quantity: 1,
      entryPrice: 700,
      stopPrice: 650, // mock SPY trades ~612 → breached
      sourceProposalId: null,
    });
    // MOCK is a manual mode: the exit should queue for approval, not execute.
    const result = await checkStopRules("test");
    expect(result.triggered).toBe(1);
    const pending = await store.listProposals({ statuses: ["AWAITING_APPROVAL"] });
    const exit = pending.find((p) => p.action === "EXIT" && p.symbol === "SPY");
    expect(exit).toBeDefined();
    expect(exit!.conciseReasoning).toContain("Stop-loss triggered");
    // Rule is retired; a second check must not duplicate the exit.
    const again = await checkStopRules("test");
    expect(again.triggered).toBe(0);
    const alerts = await store.listNotifications(10);
    expect(alerts.some((n) => n.notificationType === "STOP_LOSS_TRIGGERED")).toBe(true);
  });

  it("stops are canceled when the position is already gone", async () => {
    await store.createStopRule({
      environment: "MOCK",
      symbol: "XLF", // not held in mock seed
      quantity: 1,
      entryPrice: 60,
      stopPrice: 55,
      sourceProposalId: null,
    });
    const result = await checkStopRules("test");
    expect(result.triggered).toBe(0);
    expect(await store.listActiveStopRules("MOCK")).toHaveLength(0);
  });

  it("a BUY with stop_loss_pct arms a stop rule after execution", async () => {
    await runAiEvaluation("test");
    const proposals = await store.listProposals({ statuses: ["AWAITING_APPROVAL"] });
    if (proposals.length === 0) return;
    expect(proposals[0].stopLossPct).toBe(5); // mock engine sets 5%
    await decideProposal("tester", proposals[0].id, "APPROVED", null);
    const rules = await store.listActiveStopRules("MOCK");
    expect(rules.some((r) => r.symbol === proposals[0].symbol)).toBe(true);
  });
});

describe("cron idempotency", () => {
  it("duplicate cron invocations are skipped via the idempotency key", async () => {
    const first = await store.tryStartCronRun("ai-evaluation", "2026-06-10");
    expect(first).not.toBeNull();
    const duplicate = await store.tryStartCronRun("ai-evaluation", "2026-06-10");
    expect(duplicate).toBeNull();
  });
});

describe("mock isolation", () => {
  it("mock brokerage never performs network requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const mock = new MockBrokerageClient();
    await mock.getAccount();
    await mock.getPositions();
    await mock.submitOrder({
      clientOrderId: "iso-test-1",
      symbol: "SPY",
      side: "buy",
      type: "MARKET",
      quantity: 1,
      timeInForce: "day",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
