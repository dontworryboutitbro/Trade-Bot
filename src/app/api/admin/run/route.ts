import { z } from "zod";
import { adminRoute } from "@/lib/api";
import { audit } from "@/lib/services";
import {
  captureSnapshot,
  checkStopRules,
  expireProposals,
  reconcileOrders,
  runAiEvaluation,
  runHealthChecks,
  syncAccount,
} from "@/lib/trading/pipeline";
import { getStore } from "@/lib/store";

// Manual "Run now" trigger for jobs + connectivity tests + settings tweaks.
export const POST = adminRoute(
  z.object({
    job: z.enum([
      "SYNC_ACCOUNT",
      "RECONCILE_ORDERS",
      "CAPTURE_SNAPSHOT",
      "HEALTH_CHECK",
      "AI_EVALUATION",
      "TEST_LIVE_CONNECTION",
      "SET_EVALUATION_FREQUENCY",
    ]),
    frequency: z.enum(["DAILY", "TWICE_DAILY", "WEEKLY", "MANUAL_ONLY"]).optional(),
  }),
  async (body, user) => {
    await audit({
      actorType: "USER",
      actorId: user.email,
      action: `MANUAL_RUN_${body.job}`,
      entityType: null,
      entityId: null,
      severity: "INFO",
      summary: `${user.email} manually triggered ${body.job}.`,
      metadata: {},
    });

    switch (body.job) {
      case "SYNC_ACCOUNT":
        return { result: await syncAccount() };
      case "RECONCILE_ORDERS": {
        const expired = await expireProposals();
        const { updated } = await reconcileOrders(user.email);
        const stops = await checkStopRules(user.email);
        return { result: { expired, updated, stopsTriggered: stops.triggered } };
      }
      case "CAPTURE_SNAPSHOT":
        return { result: await captureSnapshot() };
      case "HEALTH_CHECK":
        return { result: await runHealthChecks() };
      case "AI_EVALUATION":
        return { result: await runAiEvaluation(user.email) };
      case "TEST_LIVE_CONNECTION": {
        // Read-only connectivity check against the LIVE account (LIVE_LOCKED client).
        const { AlpacaLiveBrokerageClient } = await import("@/lib/brokerage/factory");
        const client = new AlpacaLiveBrokerageClient(true);
        const check = await client.checkConnection();
        await audit({
          actorType: "USER",
          actorId: user.email,
          action: "LIVE_CONNECTIVITY_TEST",
          entityType: null,
          entityId: null,
          severity: "WARNING",
          summary: `Live connectivity test by ${user.email}: ${check.ok ? "SUCCESS" : "FAILED"}.`,
          metadata: { detail: check.detail.slice(0, 300) },
        });
        return { result: check };
      }
      case "SET_EVALUATION_FREQUENCY": {
        if (!body.frequency) throw new Error("frequency is required");
        const store = await getStore();
        await store.updateSettings({ aiEvaluationFrequency: body.frequency });
        return { result: { frequency: body.frequency } };
      }
    }
  },
);
