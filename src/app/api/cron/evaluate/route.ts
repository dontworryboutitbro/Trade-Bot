import { type NextRequest } from "next/server";
import { dailyKey, runCronJob } from "@/lib/cron";
import { runAiEvaluation, expireProposals } from "@/lib/trading/pipeline";
import { getStore } from "@/lib/store";

export const maxDuration = 300;

// Daily AI trade evaluation. Idempotency key honors the configured frequency.
export async function GET(request: NextRequest) {
  return runCronJob(
    request,
    "ai-evaluation",
    (now) => {
      return dailyKey(now);
    },
    async () => {
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
    },
  );
}
