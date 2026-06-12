// Integration: the daily learner runs end-to-end against the in-memory store
// and mock market data, places ZERO orders, changes ZERO settings, and is
// idempotent at the cron layer.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketClock } from "@/lib/types";

vi.mock("@/lib/brokerage/factory", async () => {
  const { MockBrokerageClient, MockMarketDataClient } = await import("@/lib/brokerage/mock");
  class TestMarketData extends MockMarketDataClient {
    async getMarketClock(): Promise<MarketClock> {
      return {
        isOpen: true,
        nextOpen: new Date(Date.now() + 3600_000).toISOString(),
        nextClose: new Date(Date.now() + 7200_000).toISOString(),
        asOf: new Date().toISOString(),
      };
    }
  }
  return {
    getBrokerageClient: () => new MockBrokerageClient(),
    getMarketDataClient: () => new TestMarketData(),
  };
});

import { resetMemoryStore, MemoryStore } from "@/lib/store/memory";
import { resetMockState } from "@/lib/brokerage/mock";
import { runDailyLearning } from "./daily-review";
import { runWeeklyValidation } from "./weekly-validation";

const store = new MemoryStore();

beforeEach(() => {
  resetMemoryStore();
  resetMockState();
});

describe("daily learning run", () => {
  it("completes, seeds champions, writes a report — and never places orders or changes settings", async () => {
    const ordersBefore = await store.listOrders({});
    const settingsBefore = await store.getSettings();
    const limitsBefore = await store.getRiskLimits("MOCK");

    const report = await runDailyLearning();
    expect(report.marketDate).toBe(new Date().toISOString().slice(0, 10));
    expect(report.narrative).toContain("Learning run complete");

    // Champions seeded for all 5 families.
    const versions = await store.listLearningRecords("strategy_versions");
    expect(versions.filter((v) => v.keys.status === "CHAMPION").length).toBe(5);

    // Report stored.
    const runs = await store.listLearningRecords("learning_runs", { keys: { kind: "daily" } });
    expect(runs.length).toBe(1);

    // ZERO new orders, settings untouched, limits untouched.
    const ordersAfter = await store.listOrders({});
    expect(ordersAfter.length).toBe(ordersBefore.length);
    expect(await store.getSettings()).toEqual(settingsBefore);
    expect(await store.getRiskLimits("MOCK")).toEqual(limitsBefore);
  });

  it("generates at most the weekly challenger budget and shadow trades stay isolated", async () => {
    await runDailyLearning();
    await runDailyLearning(); // second run same day — budget shared
    const versions = await store.listLearningRecords("strategy_versions");
    const challengers = versions.filter((v) => v.keys.status === "SHADOW_TESTING");
    expect(challengers.length).toBeLessThanOrEqual(3);

    // Shadow proposals (if any) created no brokerage orders.
    const orders = await store.listOrders({});
    const seedOrders = orders.filter((o) => o.clientOrderId.startsWith("seed-"));
    expect(orders.length).toBe(seedOrders.length);
  });
});

describe("weekly validation run", () => {
  it("completes and never auto-promotes or touches live settings", async () => {
    await runDailyLearning();
    const report = await runWeeklyValidation();
    expect(report.weekOf).toBeTruthy();

    // No challenger was promoted to CHAMPION automatically.
    const versions = await store.listLearningRecords("strategy_versions");
    const champions = versions.filter((v) => v.keys.status === "CHAMPION");
    expect(champions.length).toBe(5); // exactly the baselines
    for (const c of champions) {
      expect(String(c.keys.version_id)).toMatch(/@1$/);
    }

    // Mode untouched.
    expect((await store.getSettings()).tradingMode).toBe("MOCK");
  });
});

describe("learning cron idempotency", () => {
  it("duplicate learn-daily invocations are skipped via the cron-run key", async () => {
    const key = new Date().toISOString().slice(0, 10);
    expect(await store.tryStartCronRun("learn-daily", key)).not.toBeNull();
    expect(await store.tryStartCronRun("learn-daily", key)).toBeNull();
    expect(await store.tryStartCronRun("validate-weekly", "2026-W24")).not.toBeNull();
    expect(await store.tryStartCronRun("validate-weekly", "2026-W24")).toBeNull();
  });
});
