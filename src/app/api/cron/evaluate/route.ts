import { type NextRequest } from "next/server";
import { runCronJob } from "@/lib/cron";
import { runAiEvaluation, expireProposals } from "@/lib/trading/pipeline";
import { getStore } from "@/lib/store";

export const maxDuration = 300;

// AI trade evaluation. Idempotency is per 30-minute slot so the worker can
// trigger it repeatedly through the trading day (more learning samples). The
// hard limits on actual spend/activity remain: the daily AI-call budget, the
// actionable preflight gate, and the per-day trade caps — all inside
// runAiEvaluation. A double-fire within the same 30-min slot still dedupes.
const slotKey = (now: Date) => {
  const d = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  return `${d}-${Math.floor(now.getUTCMinutes() / 30)}`;
};

export async function GET(request: NextRequest) {
  return runCronJob(request, "ai-evaluation", slotKey, async () => {
    const store = await getStore();
    const settings = await store.getSettings();
    if (settings.aiEvaluationFrequency === "MANUAL_ONLY") {
      return { skipped: "MANUAL_ONLY frequency" };
    }
    if (settings.aiEvaluationFrequency === "WEEKLY" && new Date().getUTCDay() !== 1) {
      return { skipped: "WEEKLY frequency: runs Mondays only" };
    }
    await expireProposals();
    return runAiEvaluation("cron");
  });
}
