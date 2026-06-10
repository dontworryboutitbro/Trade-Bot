import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { getStore } from "@/lib/store";
import { alert, audit } from "@/lib/services";

/**
 * Shared wrapper for cron routes: CRON_SECRET auth + idempotency via the
 * cron_runs table (unique job_name + key) + failure alerting.
 */
export async function runCronJob(
  request: NextRequest,
  jobName: string,
  // Idempotency window: one run per key. Default = one per hour.
  keyFn: (now: Date) => string,
  job: () => Promise<unknown>,
): Promise<NextResponse> {
  const env = getEnv();
  const authHeader = request.headers.get("authorization");
  const provided = authHeader?.replace(/^Bearer\s+/i, "") ?? "";
  if (!env.CRON_SECRET || provided !== env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const store = await getStore();
  const idempotencyKey = keyFn(new Date());
  const run = await store.tryStartCronRun(jobName, idempotencyKey);
  if (!run) {
    return NextResponse.json({ ok: true, skipped: "duplicate", jobName, idempotencyKey });
  }

  try {
    const details = await job();
    await store.finishCronRun(run.id, "COMPLETED", details ?? {});
    return NextResponse.json({ ok: true, jobName, details });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await store.finishCronRun(run.id, "FAILED", { error: message.slice(0, 500) });
    await audit({
      actorType: "CRON",
      actorId: jobName,
      action: "CRON_FAILED",
      entityType: "cron_runs",
      entityId: run.id,
      severity: "WARNING",
      summary: `Cron job ${jobName} failed: ${message.slice(0, 300)}`,
      metadata: {},
    });
    await alert({
      notificationType: "CRON_FAILURE",
      severity: "WARNING",
      title: `Cron failed: ${jobName}`,
      message: message.slice(0, 500),
    });
    return NextResponse.json({ ok: false, error: message.slice(0, 500) }, { status: 500 });
  }
}

export const hourlyKey = (now: Date) => now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
export const dailyKey = (now: Date) => now.toISOString().slice(0, 10); // YYYY-MM-DD
export const quarterHourKey = (now: Date) =>
  `${now.toISOString().slice(0, 14)}${Math.floor(now.getUTCMinutes() / 15)}`;
