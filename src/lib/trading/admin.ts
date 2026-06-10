import "server-only";
// Admin-only server operations: emergency controls, mode changes, approvals,
// risk-limit changes, symbol management. Every entry point requires an
// authenticated admin (enforced by the calling route) and audits.

import { getBrokerageClient } from "@/lib/brokerage/factory";
import { alert, audit } from "@/lib/services";
import { getStore } from "@/lib/store";
import { executeProposal } from "@/lib/trading/pipeline";
import { validateModeChange, type ModeChangeRequest } from "@/lib/trading/modes";
import { isLiveMode, type Environment, type RiskLimits } from "@/lib/types";

export async function engageKillSwitch(actor: string, reason: string): Promise<void> {
  const store = await getStore();
  await store.updateSettings({ globalKillSwitch: true, stopNewOrders: true });
  await audit({
    actorType: "USER",
    actorId: actor,
    action: "KILL_SWITCH_ENGAGED",
    entityType: "app_settings",
    entityId: null,
    severity: "CRITICAL",
    summary: `Global kill switch ENGAGED by ${actor}. Reason: ${reason || "not given"}.`,
    metadata: { reason },
  });
  await alert({
    notificationType: "KILL_SWITCH_ENGAGED",
    severity: "CRITICAL",
    title: "Global kill switch engaged",
    message: "All new order creation is blocked. Queued proposals will be rejected.",
  });

  // Reject anything queued or awaiting approval.
  const pending = await store.listProposals({
    statuses: ["AWAITING_APPROVAL", "QUEUED", "APPROVED", "PENDING_RISK"],
  });
  for (const proposal of pending) {
    await store.updateProposalStatus(proposal.id, "REJECTED");
  }

  // Best-effort cancel of open brokerage orders (never blocks the switch).
  try {
    const settings = await store.getSettings();
    const brokerage = getBrokerageClient(settings.tradingMode);
    if (!brokerage.readOnly) {
      const canceled = await brokerage.cancelAllOrders();
      await audit({
        actorType: "SYSTEM",
        actorId: actor,
        action: "ORDERS_CANCELED_BY_KILL_SWITCH",
        entityType: null,
        entityId: null,
        severity: "WARNING",
        summary: `Kill switch attempted cancellation of open orders (${canceled} reported).`,
        metadata: {},
      });
    }
  } catch (error) {
    await audit({
      actorType: "SYSTEM",
      actorId: actor,
      action: "KILL_SWITCH_CANCEL_FAILED",
      entityType: null,
      entityId: null,
      severity: "WARNING",
      summary: `Kill switch could not cancel open orders: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
      metadata: {},
    });
  }
}

export async function resetKillSwitch(actor: string, acknowledgment: string): Promise<void> {
  if (acknowledgment !== "RESET KILL SWITCH") {
    throw new Error('Reset requires the typed acknowledgment "RESET KILL SWITCH".');
  }
  const store = await getStore();
  await store.updateSettings({ globalKillSwitch: false });
  await audit({
    actorType: "USER",
    actorId: actor,
    action: "KILL_SWITCH_RESET",
    entityType: "app_settings",
    entityId: null,
    severity: "CRITICAL",
    summary: `Global kill switch RESET by ${actor} with typed acknowledgment. Stop-new-orders remains ON until separately disabled.`,
    metadata: {},
  });
  await alert({
    notificationType: "KILL_SWITCH_RESET",
    severity: "WARNING",
    title: "Global kill switch reset",
    message: "Order creation is possible again once stop-new-orders is also disabled.",
  });
}

export async function setStopNewOrders(actor: string, stop: boolean): Promise<void> {
  const store = await getStore();
  await store.updateSettings({ stopNewOrders: stop });
  await audit({
    actorType: "USER",
    actorId: actor,
    action: stop ? "STOP_NEW_ORDERS_ENABLED" : "STOP_NEW_ORDERS_DISABLED",
    entityType: "app_settings",
    entityId: null,
    severity: stop ? "WARNING" : "INFO",
    summary: `Stop-new-orders ${stop ? "ENABLED" : "disabled"} by ${actor}.`,
    metadata: {},
  });
}

export async function cancelOpenOrders(actor: string): Promise<number> {
  const store = await getStore();
  const settings = await store.getSettings();
  const brokerage = getBrokerageClient(settings.tradingMode);
  const count = await brokerage.cancelAllOrders();
  await audit({
    actorType: "USER",
    actorId: actor,
    action: "CANCEL_OPEN_ORDERS",
    entityType: null,
    entityId: null,
    severity: "WARNING",
    summary: `${actor} canceled all open orders (${count} reported).`,
    metadata: {},
  });
  await alert({
    notificationType: "ORDERS_CANCELED",
    severity: "WARNING",
    title: "Open orders canceled",
    message: `${count} open order(s) were canceled by the administrator.`,
  });
  return count;
}

export async function closeAllPositions(actor: string, confirmation: string): Promise<number> {
  if (confirmation !== "CLOSE ALL POSITIONS") {
    throw new Error('This action requires the typed confirmation "CLOSE ALL POSITIONS".');
  }
  const store = await getStore();
  const settings = await store.getSettings();
  const brokerage = getBrokerageClient(settings.tradingMode);
  const count = await brokerage.closeAllPositions();
  await audit({
    actorType: "USER",
    actorId: actor,
    action: "CLOSE_ALL_POSITIONS",
    entityType: null,
    entityId: null,
    severity: "CRITICAL",
    summary: `${actor} closed ALL positions (${count} reported). Live fill prices may vary from quotes.`,
    metadata: {},
  });
  await alert({
    notificationType: "POSITIONS_CLOSED",
    severity: "CRITICAL",
    title: "All positions closed",
    message: `${count} position(s) liquidated by the administrator. Fill prices may differ from last quotes.`,
  });
  return count;
}

export async function changeTradingMode(actor: string, request: ModeChangeRequest): Promise<void> {
  const store = await getStore();
  const settings = await store.getSettings();
  if (settings.tradingMode !== request.from) {
    throw new Error(
      `Mode changed concurrently (now ${settings.tradingMode}). Refresh and try again.`,
    );
  }

  const validation = validateModeChange(request);
  if (!validation.allowed) {
    await audit({
      actorType: "USER",
      actorId: actor,
      action: "MODE_CHANGE_REJECTED",
      entityType: "app_settings",
      entityId: null,
      severity: "WARNING",
      summary: `Mode change ${request.from} → ${request.to} rejected: ${validation.reasons.join("; ")}`,
      metadata: { reasons: validation.reasons },
    });
    throw new Error(validation.reasons.join(" "));
  }

  await store.updateSettings({ tradingMode: request.to });
  const live = isLiveMode(request.to);
  await audit({
    actorType: "USER",
    actorId: actor,
    action: "MODE_CHANGED",
    entityType: "app_settings",
    entityId: null,
    severity: live ? "CRITICAL" : "INFO",
    summary: `Trading mode changed ${request.from} → ${request.to} by ${actor}.`,
    metadata: { from: request.from, to: request.to },
  });
  await alert({
    notificationType: "MODE_CHANGED",
    severity: live || request.to === "PAPER_AUTONOMOUS" ? "CRITICAL" : "INFO",
    title: `Trading mode: ${request.to}`,
    message: live
      ? `LIVE trading mode ${request.to} is now active. Real money is at risk.`
      : `Trading mode changed to ${request.to}.`,
  });
}

export async function decideProposal(
  actor: string,
  proposalId: string,
  decision: "APPROVED" | "REJECTED",
  reason: string | null,
): Promise<{ executed?: boolean; reasons?: string[] }> {
  const store = await getStore();
  const proposal = await store.getProposal(proposalId);
  if (!proposal) throw new Error("Proposal not found.");
  if (proposal.status !== "AWAITING_APPROVAL") {
    throw new Error(`Proposal is ${proposal.status}, not awaiting approval.`);
  }

  await store.saveApproval({
    proposalId,
    decision,
    decidedBy: actor,
    reason,
    decidedAt: new Date().toISOString(),
  });
  await audit({
    actorType: "USER",
    actorId: actor,
    action: `PROPOSAL_${decision}`,
    entityType: "trade_proposal",
    entityId: proposalId,
    severity: "INFO",
    summary: `${actor} ${decision.toLowerCase()} ${proposal.action} ${proposal.quantity} ${proposal.symbol}.`,
    metadata: { reason },
  });

  if (decision === "REJECTED") {
    await store.updateProposalStatus(proposalId, "REJECTED");
    return {};
  }

  await store.updateProposalStatus(proposalId, "APPROVED");
  const outcome = await executeProposal(proposalId, actor);
  return { executed: outcome.executed, reasons: outcome.reasons };
}

const TIGHTEN_ONLY_NUMERIC: { key: keyof RiskLimits; lowerIsSafer: boolean }[] = [
  { key: "maxPositions", lowerIsSafer: true },
  { key: "maxTotalExposurePct", lowerIsSafer: true },
  { key: "maxSymbolExposurePct", lowerIsSafer: true },
  { key: "maxOrderNotional", lowerIsSafer: true },
  { key: "maxTradesPerDay", lowerIsSafer: true },
  { key: "maxDailyLossPct", lowerIsSafer: true },
  { key: "maxDrawdownPct", lowerIsSafer: true },
  { key: "minSharePrice", lowerIsSafer: false },
];

export async function updateRiskLimits(
  actor: string,
  environment: Environment,
  next: RiskLimits,
  confirmation: string | null,
  reason: string,
): Promise<void> {
  const store = await getStore();
  const current = await store.getRiskLimits(environment);

  // The prohibition flags can never be loosened through the app, by anyone.
  const frozen: (keyof RiskLimits)[] = [
    "allowMargin",
    "allowOptions",
    "allowShorting",
    "allowCrypto",
    "allowLeveragedEtfs",
    "allowInverseEtfs",
    "allowOtc",
  ];
  for (const key of frozen) {
    if (next[key] !== current[key]) {
      throw new Error(`${key} cannot be changed through the app.`);
    }
  }
  if (next.maxOrderNotionalIsPct !== current.maxOrderNotionalIsPct) {
    throw new Error("maxOrderNotional unit cannot be changed through the app.");
  }

  // Determine whether any change loosens a limit.
  const loosened: string[] = [];
  for (const { key, lowerIsSafer } of TIGHTEN_ONLY_NUMERIC) {
    const prev = current[key] as number;
    const value = next[key] as number;
    if (lowerIsSafer ? value > prev : value < prev) {
      loosened.push(`${key}: ${prev} → ${value}`);
    }
  }
  if (current.marketHoursOnly && !next.marketHoursOnly) loosened.push("marketHoursOnly: on → off");
  if (
    current.maxLiveFundedBalance !== null &&
    (next.maxLiveFundedBalance === null || next.maxLiveFundedBalance > current.maxLiveFundedBalance)
  ) {
    loosened.push(`maxLiveFundedBalance: ${current.maxLiveFundedBalance} → ${next.maxLiveFundedBalance}`);
  }

  if (loosened.length > 0 && confirmation !== "INCREASE RISK LIMITS") {
    throw new Error(
      `Loosening limits (${loosened.join(", ")}) requires the typed confirmation "INCREASE RISK LIMITS".`,
    );
  }

  await store.updateRiskLimits(environment, next, actor, reason);
  await audit({
    actorType: "USER",
    actorId: actor,
    action: loosened.length > 0 ? "RISK_LIMITS_LOOSENED" : "RISK_LIMITS_TIGHTENED",
    entityType: "risk_profiles",
    entityId: environment,
    severity: loosened.length > 0 ? "CRITICAL" : "INFO",
    summary:
      loosened.length > 0
        ? `${actor} LOOSENED ${environment} risk limits: ${loosened.join("; ")}. Reason: ${reason}`
        : `${actor} tightened/updated ${environment} risk limits. Reason: ${reason}`,
    metadata: { previous: current, next, loosened },
  });
  if (loosened.length > 0) {
    await alert({
      notificationType: "RISK_LIMITS_LOOSENED",
      severity: "CRITICAL",
      title: `Risk limits loosened (${environment})`,
      message: loosened.join("; "),
    });
  }
}

/** Validate a symbol through the brokerage before it can be activated. */
export async function validateAndAddSymbol(
  actor: string,
  symbol: string,
  displayName?: string,
): Promise<{ ok: boolean; detail: string }> {
  const store = await getStore();
  const settings = await store.getSettings();
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z]{1,6}$/.test(normalized)) {
    return { ok: false, detail: "Symbol must be 1–6 letters." };
  }

  const brokerage = getBrokerageClient(settings.tradingMode);
  const asset = await brokerage.getAsset(normalized);
  if (!asset) return { ok: false, detail: `${normalized} was not found at the brokerage.` };
  if (!asset.tradable) return { ok: false, detail: `${normalized} is not tradable.` };
  if (asset.assetClass !== "us_equity") {
    return { ok: false, detail: `Asset class ${asset.assetClass} is not permitted.` };
  }

  // Heuristic leveraged/inverse screen on the official name; the admin remains
  // responsible for the allowlist, and the risk engine re-checks flags at trade time.
  const name = asset.name.toLowerCase();
  const leveraged = /\b(2x|3x|ultra|ultrapro|leveraged|bull 2|bull 3)\b/.test(name);
  const inverse = /\b(short|inverse|bear)\b/.test(name);
  const otc = asset.exchange === "OTC";

  await store.upsertApprovedSymbol({
    symbol: normalized,
    displayName: displayName || asset.name,
    assetClass: asset.assetClass,
    tradable: asset.tradable,
    leveraged,
    inverse,
    otc,
    active: false, // activation is a separate explicit step
    validationDetails: { exchange: asset.exchange, name: asset.name, validatedBy: actor },
  });
  await audit({
    actorType: "USER",
    actorId: actor,
    action: "SYMBOL_VALIDATED",
    entityType: "approved_symbols",
    entityId: normalized,
    severity: "INFO",
    summary: `${actor} validated ${normalized} (${asset.name}). leveraged=${leveraged} inverse=${inverse} otc=${otc}. Not yet active.`,
    metadata: { asset },
  });

  if (leveraged || inverse || otc) {
    return {
      ok: false,
      detail: `${normalized} was saved but flagged (${[leveraged && "leveraged", inverse && "inverse", otc && "OTC"].filter(Boolean).join(", ")}) and cannot be activated.`,
    };
  }
  return { ok: true, detail: `${normalized} validated. Activate it to allow trading.` };
}

export async function setSymbolActive(
  actor: string,
  symbol: string,
  active: boolean,
): Promise<void> {
  const store = await getStore();
  const symbols = await store.getApprovedSymbols();
  const entry = symbols.find((s) => s.symbol === symbol);
  if (!entry) throw new Error("Symbol not found.");
  if (active && (entry.leveraged || entry.inverse || entry.otc || !entry.tradable)) {
    throw new Error("This symbol is flagged as prohibited and cannot be activated.");
  }
  await store.setSymbolActive(symbol, active);
  await audit({
    actorType: "USER",
    actorId: actor,
    action: active ? "SYMBOL_ACTIVATED" : "SYMBOL_DEACTIVATED",
    entityType: "approved_symbols",
    entityId: symbol,
    severity: "INFO",
    summary: `${actor} ${active ? "activated" : "deactivated"} ${symbol}.`,
    metadata: {},
  });
}
