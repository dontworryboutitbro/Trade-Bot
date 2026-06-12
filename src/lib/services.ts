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
    await sendDiscordAlert(input).catch(() => undefined);
  } catch (error) {
    // Never let alerting failures break the calling flow.
    console.error("alert() failed:", error instanceof Error ? error.message : error);
  }
}

// Discord webhook alerts (optional, server-only). Per-type cooldown prevents
// spam; failures never break risk controls. Orders are NEVER sent to Discord —
// only human-readable notifications.
const discordCooldowns = new Map<string, number>();
const DISCORD_COOLDOWN_MS = 10 * 60 * 1000;

async function sendDiscordAlert(input: {
  notificationType: string;
  severity: Severity;
  title: string;
  message: string;
}): Promise<void> {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;
  if (input.severity === "INFO" && input.notificationType !== "CROSS_MARKET_DIVERGENCE") return;
  const last = discordCooldowns.get(input.notificationType) ?? 0;
  if (Date.now() - last < DISCORD_COOLDOWN_MS) return;
  discordCooldowns.set(input.notificationType, Date.now());
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `**[${input.severity}] ${input.title}**\n${input.message.slice(0, 1500)}`,
    }),
  });
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
