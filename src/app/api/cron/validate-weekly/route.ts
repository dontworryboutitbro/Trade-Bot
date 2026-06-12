import { type NextRequest } from "next/server";
import { runCronJob } from "@/lib/cron";
import { runWeeklyValidation } from "@/lib/learning/weekly-validation";

export const maxDuration = 300;

// Weekly deep validation (Saturdays). Idempotent per ISO week.
const weeklyKey = (now: Date) => {
  const year = now.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((now.getTime() - start.getTime()) / 86_400_000 + 1) / 7);
  return `${year}-W${week}`;
};

export async function GET(request: NextRequest) {
  return runCronJob(request, "validate-weekly", weeklyKey, () => runWeeklyValidation());
}
