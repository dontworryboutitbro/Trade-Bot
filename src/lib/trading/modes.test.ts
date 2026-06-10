import { describe, expect, it } from "vitest";
import { validateModeChange } from "./modes";
import {
  LIVE_AUTONOMOUS_CONFIRMATION_PHRASE,
  LIVE_MANUAL_CONFIRMATION_PHRASE,
} from "@/lib/config";

describe("trading mode state machine", () => {
  it("allows MOCK → PAPER_MANUAL", () => {
    expect(validateModeChange({ from: "MOCK", to: "PAPER_MANUAL" }).allowed).toBe(true);
  });

  it("blocks MOCK → LIVE_MANUAL (must pass through LIVE_LOCKED)", () => {
    const result = validateModeChange({
      from: "MOCK",
      to: "LIVE_MANUAL",
      confirmationPhrase: LIVE_MANUAL_CONFIRMATION_PHRASE,
      acknowledgmentsComplete: true,
      killSwitchTested: true,
      liveConnectivityVerified: true,
    });
    expect(result.allowed).toBe(false);
  });

  it("blocks PAPER_MANUAL → LIVE_MANUAL directly", () => {
    expect(
      validateModeChange({
        from: "PAPER_MANUAL",
        to: "LIVE_MANUAL",
        confirmationPhrase: LIVE_MANUAL_CONFIRMATION_PHRASE,
        acknowledgmentsComplete: true,
        killSwitchTested: true,
        liveConnectivityVerified: true,
      }).allowed,
    ).toBe(false);
  });

  it("requires acknowledgment for PAPER_AUTONOMOUS", () => {
    expect(
      validateModeChange({ from: "PAPER_MANUAL", to: "PAPER_AUTONOMOUS" }).allowed,
    ).toBe(false);
    expect(
      validateModeChange({
        from: "PAPER_MANUAL",
        to: "PAPER_AUTONOMOUS",
        autonomousAcknowledged: true,
      }).allowed,
    ).toBe(true);
  });

  it("LIVE_MANUAL requires the exact phrase plus every ceremony step", () => {
    const base = {
      from: "LIVE_LOCKED" as const,
      to: "LIVE_MANUAL" as const,
      acknowledgmentsComplete: true,
      killSwitchTested: true,
      liveConnectivityVerified: true,
    };
    expect(validateModeChange({ ...base }).allowed).toBe(false); // no phrase
    expect(
      validateModeChange({ ...base, confirmationPhrase: "enable live manual trading" }).allowed,
    ).toBe(false); // wrong case
    expect(
      validateModeChange({ ...base, confirmationPhrase: LIVE_AUTONOMOUS_CONFIRMATION_PHRASE })
        .allowed,
    ).toBe(false); // wrong phrase
    expect(
      validateModeChange({ ...base, confirmationPhrase: LIVE_MANUAL_CONFIRMATION_PHRASE }).allowed,
    ).toBe(true);
  });

  it("LIVE_MANUAL cannot activate without kill-switch test", () => {
    expect(
      validateModeChange({
        from: "LIVE_LOCKED",
        to: "LIVE_MANUAL",
        confirmationPhrase: LIVE_MANUAL_CONFIRMATION_PHRASE,
        acknowledgmentsComplete: true,
        killSwitchTested: false,
        liveConnectivityVerified: true,
      }).allowed,
    ).toBe(false);
  });

  it("LIVE_MANUAL cannot activate without connectivity verification", () => {
    expect(
      validateModeChange({
        from: "LIVE_LOCKED",
        to: "LIVE_MANUAL",
        confirmationPhrase: LIVE_MANUAL_CONFIRMATION_PHRASE,
        acknowledgmentsComplete: true,
        killSwitchTested: true,
        liveConnectivityVerified: false,
      }).allowed,
    ).toBe(false);
  });

  it("LIVE_AUTONOMOUS requires its own distinct phrase", () => {
    const base = {
      from: "LIVE_LOCKED" as const,
      to: "LIVE_AUTONOMOUS" as const,
      acknowledgmentsComplete: true,
      killSwitchTested: true,
      liveConnectivityVerified: true,
    };
    expect(
      validateModeChange({ ...base, confirmationPhrase: LIVE_MANUAL_CONFIRMATION_PHRASE }).allowed,
    ).toBe(false);
    expect(
      validateModeChange({ ...base, confirmationPhrase: LIVE_AUTONOMOUS_CONFIRMATION_PHRASE })
        .allowed,
    ).toBe(true);
  });

  it("an empty request can never reach a live mode (no accidental activation)", () => {
    for (const from of ["MOCK", "PAPER_MANUAL", "PAPER_AUTONOMOUS", "LIVE_LOCKED"] as const) {
      for (const to of ["LIVE_MANUAL", "LIVE_AUTONOMOUS"] as const) {
        expect(validateModeChange({ from, to }).allowed).toBe(false);
      }
    }
  });

  it("downgrades to safer modes are always allowed", () => {
    expect(validateModeChange({ from: "LIVE_AUTONOMOUS", to: "MOCK" }).allowed).toBe(true);
    expect(validateModeChange({ from: "LIVE_MANUAL", to: "LIVE_LOCKED" }).allowed).toBe(true);
    expect(validateModeChange({ from: "PAPER_AUTONOMOUS", to: "PAPER_MANUAL" }).allowed).toBe(true);
  });
});
