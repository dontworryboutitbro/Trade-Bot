import "server-only";
// Thin service helpers shared by routes and the pipeline:
// audit logging and alerting (in-app always; email optional via Resend).
// Notification failures must never break risk controls — all alert paths
// swallow their own errors.

import { getEnv } from "@/lib/env";
import { getStore } from "@/lib/store";
import type { Severity } from "@/lib/types";
import type { AuditEventRow } from "@/lib/store/types";

export async function audit(input: Omit<AuditEventRow, "id" | "createdAt">): Promise<void> {
  const store = await getStore();
  await store.createAuditEvent(input);
}

export async function alert(input: {
  notificationType: string;
  severity: Severity;
  title: string;
  message: string;
}): Promise<void> {
  try {
    const store = await getStore();
    await store.createNotification(input);
    await sendEmailAlert(input).catch(() => undefined);
  } catch (error) {
    // Never let alerting failures break the calling flow.
    console.error("alert() failed:", error instanceof Error ? error.message : error);
  }
}

async function sendEmailAlert(input: {
  severity: Severity;
  title: string;
  message: string;
}): Promise<void> {
  const env = getEnv();
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL_TO || !env.ALERT_EMAIL_FROM) return;
  if (input.severity === "INFO") return; // email only for WARNING/CRITICAL
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.ALERT_EMAIL_FROM,
      to: [env.ALERT_EMAIL_TO],
      subject: `[Fable Fund Lab] ${input.severity}: ${input.title}`,
      text: input.message,
    }),
  });
}
