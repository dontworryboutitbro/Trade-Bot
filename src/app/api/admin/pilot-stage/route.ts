import { z } from "zod";
import { adminRoute } from "@/lib/api";
import { alert, audit } from "@/lib/services";
import { getStore } from "@/lib/store";
import { CAPITAL_STAGES, type CapitalStage } from "@/lib/pilot/config";

// Capital stage changes: never automatic, always typed-confirmed and audited.
export const POST = adminRoute(
  z.object({
    stage: z.enum(["CANARY_100", "PILOT_250", "PILOT_500", "REVIEW_REQUIRED"]),
    confirmation: z.string().max(100),
    reason: z.string().min(1).max(500),
  }),
  async (body, user) => {
    if (body.confirmation !== "CHANGE LIVE CAPITAL STAGE") {
      throw new Error('Capital stage changes require the typed confirmation "CHANGE LIVE CAPITAL STAGE".');
    }
    const store = await getStore();
    const settings = await store.getSettings();
    const previous = settings.pilotCapitalStage ?? "CANARY_100";
    const expanding =
      CAPITAL_STAGES[body.stage as CapitalStage] > CAPITAL_STAGES[previous as CapitalStage];
    await store.updateSettings({ pilotCapitalStage: body.stage });
    await audit({
      actorType: "USER",
      actorId: user.email,
      action: expanding ? "PILOT_CAPITAL_EXPANDED" : "PILOT_CAPITAL_REDUCED",
      entityType: "app_settings",
      entityId: null,
      severity: "CRITICAL",
      summary: `${user.email} changed pilot capital stage ${previous} → ${body.stage} ($${CAPITAL_STAGES[body.stage as CapitalStage]}). Reason: ${body.reason}`,
      metadata: { previous, next: body.stage },
    });
    await alert({
      notificationType: "PILOT_CAPITAL_STAGE",
      severity: "CRITICAL",
      title: `Live pilot capital stage: ${body.stage}`,
      message: `Enabled capital is now $${CAPITAL_STAGES[body.stage as CapitalStage]}. Historical performance does not guarantee future profit.`,
    });
    return { stage: body.stage };
  },
);
