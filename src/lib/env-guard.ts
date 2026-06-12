import "server-only";
// Startup security validation. Protected routes call assertSecureBoot() and
// refuse to operate when the environment is misconfigured in a way that could
// leak credentials or blur the paper/live boundary. Messages never include
// credential values — booleans and masked indicators only.

import { getEnv, getConfigStatus } from "@/lib/env";

export interface SecurityFinding {
  code: string;
  severity: "FATAL" | "WARNING";
  message: string;
}

let cachedFindings: SecurityFinding[] | null = null;

export function runSecurityValidation(): SecurityFinding[] {
  if (cachedFindings) return cachedFindings;
  const env = getEnv();
  const status = getConfigStatus();
  const findings: SecurityFinding[] = [];

  // 1. No server-only secret may use a NEXT_PUBLIC_ prefix.
  const leakedPublic = Object.keys(process.env).filter(
    (key) =>
      key.startsWith("NEXT_PUBLIC_") &&
      /(SECRET|SERVICE_ROLE|API_KEY|TOKEN|WEBHOOK|ENCRYPTION)/.test(key) &&
      !["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"].includes(key) &&
      Boolean(process.env[key]),
  );
  for (const key of leakedPublic) {
    findings.push({
      code: "PUBLIC_SECRET_PREFIX",
      severity: "FATAL",
      message: `${key} looks like a secret but is exposed to the browser via NEXT_PUBLIC_. Rename it.`,
    });
  }

  // 2. Paper and live Alpaca keys must never be identical.
  if (
    env.ALPACA_PAPER_API_KEY &&
    env.ALPACA_LIVE_API_KEY &&
    (env.ALPACA_PAPER_API_KEY === env.ALPACA_LIVE_API_KEY ||
      env.ALPACA_PAPER_API_SECRET === env.ALPACA_LIVE_API_SECRET)
  ) {
    findings.push({
      code: "PAPER_LIVE_KEYS_IDENTICAL",
      severity: "FATAL",
      message:
        "Alpaca paper and live credentials are identical. The paper/live boundary is ambiguous; fix the environment before trading.",
    });
  }

  // 3. Paper/live base URLs must not be swapped.
  if (env.ALPACA_PAPER_BASE_URL.includes("api.alpaca.markets") &&
      !env.ALPACA_PAPER_BASE_URL.includes("paper")) {
    findings.push({
      code: "PAPER_URL_POINTS_LIVE",
      severity: "FATAL",
      message: "ALPACA_PAPER_BASE_URL points at the live API. Environment is ambiguous.",
    });
  }
  if (env.ALPACA_LIVE_BASE_URL.includes("paper")) {
    findings.push({
      code: "LIVE_URL_POINTS_PAPER",
      severity: "WARNING",
      message: "ALPACA_LIVE_BASE_URL points at the paper API.",
    });
  }

  // 4. Live credentials present while safety configuration is incomplete.
  if (status.alpacaLive && (!status.cronSecret || !status.supabaseServiceRole)) {
    findings.push({
      code: "LIVE_KEYS_WITHOUT_SAFETY_CONFIG",
      severity: "FATAL",
      message:
        "Live Alpaca credentials are configured but safety configuration (cron secret / Supabase persistence for the kill switch) is incomplete. Remove live keys or complete the configuration.",
    });
  }

  // 5. Supabase service-role key must not equal the publishable key (paste error).
  if (
    env.SUPABASE_SERVICE_ROLE_KEY &&
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY &&
    env.SUPABASE_SERVICE_ROLE_KEY === env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  ) {
    findings.push({
      code: "SERVICE_ROLE_EQUALS_PUBLISHABLE",
      severity: "FATAL",
      message:
        "SUPABASE_SERVICE_ROLE_KEY equals the publishable key. The service-role key is missing or the publishable key is over-privileged.",
    });
  }

  cachedFindings = findings;
  return findings;
}

export class SecurityBootError extends Error {
  constructor(public findings: SecurityFinding[]) {
    super(
      `Security validation failed: ${findings
        .filter((f) => f.severity === "FATAL")
        .map((f) => f.code)
        .join(", ")}`,
    );
    this.name = "SecurityBootError";
  }
}

/**
 * Throws when any FATAL security finding exists. Call at the top of protected
 * routes that can reach a brokerage or the database with secrets.
 */
export function assertSecureBoot(): void {
  const fatal = runSecurityValidation().filter((f) => f.severity === "FATAL");
  if (fatal.length > 0) throw new SecurityBootError(fatal);
}
