import { describe, expect, it } from "vitest";
import { parseAiDecision } from "./client";

const valid = {
  evaluated_at: "2026-06-10T15:00:00Z",
  actions: [
    {
      symbol: "SPY",
      action: "BUY",
      quantity: 1,
      proposed_notional: 612.4,
      order_type: "MARKET",
      limit_price: null,
      confidence: 70,
      concise_reasoning: "Adds core index exposure within limits.",
      key_risk: "Broad market drawdown.",
      expiration_timestamp: "2026-06-10T19:00:00Z",
    },
  ],
};

describe("AI response validation", () => {
  it("accepts a valid decision", () => {
    const decision = parseAiDecision(JSON.stringify(valid));
    expect(decision.actions[0].symbol).toBe("SPY");
  });

  it("accepts markdown-fenced JSON", () => {
    const decision = parseAiDecision("```json\n" + JSON.stringify(valid) + "\n```");
    expect(decision.actions).toHaveLength(1);
  });

  it("accepts JSON wrapped in prose (smaller models add commentary)", () => {
    const wrapped =
      "Here is my analysis for today:\n\n" + JSON.stringify(valid) + "\n\nLet me know if you need more.";
    const decision = parseAiDecision(wrapped);
    expect(decision.actions).toHaveLength(1);
    expect(decision.actions[0].symbol).toBe("SPY");
  });

  it("rejects non-JSON output", () => {
    expect(() => parseAiDecision("I think you should buy SPY")).toThrow("not valid JSON");
  });

  it("rejects unknown actions", () => {
    const bad = structuredClone(valid);
    bad.actions[0].action = "YOLO";
    expect(() => parseAiDecision(JSON.stringify(bad))).toThrow("schema validation");
  });

  it("rejects reasoning over 500 characters", () => {
    const bad = structuredClone(valid);
    bad.actions[0].concise_reasoning = "x".repeat(501);
    expect(() => parseAiDecision(JSON.stringify(bad))).toThrow("schema validation");
  });

  it("rejects key risk over 250 characters", () => {
    const bad = structuredClone(valid);
    bad.actions[0].key_risk = "x".repeat(251);
    expect(() => parseAiDecision(JSON.stringify(bad))).toThrow("schema validation");
  });

  it("rejects confidence outside 0–100", () => {
    const bad = structuredClone(valid);
    bad.actions[0].confidence = 140;
    expect(() => parseAiDecision(JSON.stringify(bad))).toThrow("schema validation");
  });

  it("rejects negative quantities", () => {
    const bad = structuredClone(valid);
    bad.actions[0].quantity = -5;
    expect(() => parseAiDecision(JSON.stringify(bad))).toThrow("schema validation");
  });

  it("rejects extra fields (strict schema — no smuggled instructions)", () => {
    const bad = structuredClone(valid) as Record<string, unknown>;
    bad.set_risk_limits = { maxOrderNotional: 999999 };
    expect(() => parseAiDecision(JSON.stringify(bad))).toThrow("schema validation");
  });

  it("rejects extra fields inside actions", () => {
    const bad = structuredClone(valid);
    (bad.actions[0] as Record<string, unknown>).disable_kill_switch = true;
    expect(() => parseAiDecision(JSON.stringify(bad))).toThrow("schema validation");
  });
});
