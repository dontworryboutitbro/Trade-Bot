// Server-side trading-mode state machine. Mode changes only happen through
// changeTradingMode(), which enforces allowed transitions, live-activation
// ceremonies, and audit logging. The AI has no path to this module.

import { LIVE_AUTONOMOUS_CONFIRMATION_PHRASE, LIVE_MANUAL_CONFIRMATION_PHRASE } from "@/lib/config";
import type { TradingMode } from "@/lib/types";

export const ALL_MODES: TradingMode[] = [
  "MOCK",
  "PAPER_MANUAL",
  "PAPER_AUTONOMOUS",
  "LIVE_LOCKED",
  "LIVE_MANUAL",
  "LIVE_AUTONOMOUS",
];

/**
 * Allowed transitions. Live trading modes are reachable ONLY from LIVE_LOCKED
 * (or each other / downgrade), so the connectivity-verification step can never
 * be skipped. Any mode may always step DOWN to something safer.
 */
const TRANSITIONS: Record<TradingMode, TradingMode[]> = {
  MOCK: ["PAPER_MANUAL"],
  PAPER_MANUAL: ["MOCK", "PAPER_AUTONOMOUS", "LIVE_LOCKED"],
  PAPER_AUTONOMOUS: ["MOCK", "PAPER_MANUAL", "LIVE_LOCKED"],
  LIVE_LOCKED: ["MOCK", "PAPER_MANUAL", "PAPER_AUTONOMOUS", "LIVE_MANUAL", "LIVE_AUTONOMOUS"],
  LIVE_MANUAL: ["MOCK", "PAPER_MANUAL", "LIVE_LOCKED", "LIVE_AUTONOMOUS"],
  LIVE_AUTONOMOUS: ["MOCK", "PAPER_MANUAL", "LIVE_LOCKED", "LIVE_MANUAL"],
};

export interface ModeChangeRequest {
  from: TradingMode;
  to: TradingMode;
  /** Typed confirmation phrase; required for live trading modes. */
  confirmationPhrase?: string;
  /** All ceremony acknowledgments checked (live only). */
  acknowledgmentsComplete?: boolean;
  /** A successful kill-switch test recorded during this session (live only). */
  killSwitchTested?: boolean;
  /** A successful live connectivity check (live only). */
  liveConnectivityVerified?: boolean;
  /** PAPER_AUTONOMOUS also requires deliberate activation. */
  autonomousAcknowledged?: boolean;
}

export interface ModeChangeValidation {
  allowed: boolean;
  reasons: string[];
}

export function requiredPhraseFor(mode: TradingMode): string | null {
  if (mode === "LIVE_MANUAL") return LIVE_MANUAL_CONFIRMATION_PHRASE;
  if (mode === "LIVE_AUTONOMOUS") return LIVE_AUTONOMOUS_CONFIRMATION_PHRASE;
  return null;
}

export function validateModeChange(req: ModeChangeRequest): ModeChangeValidation {
  const reasons: string[] = [];

  if (req.from === req.to) reasons.push("Already in this mode.");
  if (!TRANSITIONS[req.from]?.includes(req.to)) {
    reasons.push(`Transition ${req.from} → ${req.to} is not allowed. Live trading modes require passing through LIVE_LOCKED first.`);
  }

  if (req.to === "PAPER_AUTONOMOUS" && !req.autonomousAcknowledged) {
    reasons.push("Autonomous paper trading requires explicit acknowledgment in Settings.");
  }

  const phrase = requiredPhraseFor(req.to);
  if (phrase) {
    if (req.confirmationPhrase !== phrase) {
      reasons.push(`Typed confirmation phrase must be exactly "${phrase}".`);
    }
    if (!req.acknowledgmentsComplete) {
      reasons.push("All acknowledgment checkboxes must be confirmed.");
    }
    if (!req.killSwitchTested) {
      reasons.push("A successful kill-switch test is required before enabling live trading.");
    }
    if (!req.liveConnectivityVerified) {
      reasons.push("A successful live account connectivity check (LIVE_LOCKED) is required.");
    }
  }

  return { allowed: reasons.length === 0, reasons };
}
