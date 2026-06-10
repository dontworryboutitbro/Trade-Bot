import "server-only";
import { z } from "zod";

// Server-only environment access. Never import this from client components.
// Values are validated lazily so MOCK mode works with an empty .env.local.

const optionalUrl = z
  .string()
  .url()
  .optional()
  .or(z.literal("").transform(() => undefined));

const optionalString = z
  .string()
  .min(1)
  .optional()
  .or(z.literal("").transform(() => undefined));

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: optionalUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().default("claude-fable-5"),
  ALPACA_PAPER_API_KEY: optionalString,
  ALPACA_PAPER_API_SECRET: optionalString,
  ALPACA_LIVE_API_KEY: optionalString,
  ALPACA_LIVE_API_SECRET: optionalString,
  ALPACA_PAPER_BASE_URL: z.string().url().default("https://paper-api.alpaca.markets"),
  ALPACA_LIVE_BASE_URL: z.string().url().default("https://api.alpaca.markets"),
  ALPACA_DATA_BASE_URL: z.string().url().default("https://data.alpaca.markets"),
  CRON_SECRET: optionalString,
  APP_ENCRYPTION_KEY: optionalString,
  APP_URL: z.string().url().default("http://localhost:3000"),
  RESEND_API_KEY: optionalString,
  ALERT_EMAIL_TO: optionalString,
  ALERT_EMAIL_FROM: optionalString,
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (!cached) {
    cached = envSchema.parse({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || "claude-fable-5",
      ALPACA_PAPER_API_KEY: process.env.ALPACA_PAPER_API_KEY,
      ALPACA_PAPER_API_SECRET: process.env.ALPACA_PAPER_API_SECRET,
      ALPACA_LIVE_API_KEY: process.env.ALPACA_LIVE_API_KEY,
      ALPACA_LIVE_API_SECRET: process.env.ALPACA_LIVE_API_SECRET,
      ALPACA_PAPER_BASE_URL:
        process.env.ALPACA_PAPER_BASE_URL || "https://paper-api.alpaca.markets",
      ALPACA_LIVE_BASE_URL: process.env.ALPACA_LIVE_BASE_URL || "https://api.alpaca.markets",
      ALPACA_DATA_BASE_URL: process.env.ALPACA_DATA_BASE_URL || "https://data.alpaca.markets",
      CRON_SECRET: process.env.CRON_SECRET,
      APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
      APP_URL: process.env.APP_URL || "http://localhost:3000",
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      ALERT_EMAIL_TO: process.env.ALERT_EMAIL_TO,
      ALERT_EMAIL_FROM: process.env.ALERT_EMAIL_FROM,
    });
  }
  return cached;
}

export interface ConfigStatus {
  supabase: boolean;
  supabaseServiceRole: boolean;
  anthropic: boolean;
  alpacaPaper: boolean;
  alpacaLive: boolean;
  cronSecret: boolean;
  encryptionKey: boolean;
  resend: boolean;
}

/** Safe to surface in the diagnostics UI: booleans only, never values. */
export function getConfigStatus(): ConfigStatus {
  const env = getEnv();
  return {
    supabase: Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
    supabaseServiceRole: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    alpacaPaper: Boolean(env.ALPACA_PAPER_API_KEY && env.ALPACA_PAPER_API_SECRET),
    alpacaLive: Boolean(env.ALPACA_LIVE_API_KEY && env.ALPACA_LIVE_API_SECRET),
    cronSecret: Boolean(env.CRON_SECRET),
    encryptionKey: Boolean(env.APP_ENCRYPTION_KEY),
    resend: Boolean(env.RESEND_API_KEY && env.ALERT_EMAIL_TO && env.ALERT_EMAIL_FROM),
  };
}

export function isSupabaseConfigured(): boolean {
  return getConfigStatus().supabase && getConfigStatus().supabaseServiceRole;
}

/** Throw if a credential required for the given purpose is missing. Fail safe, fail loud. */
export function requireEnv<K extends keyof Env>(key: K, purpose: string): NonNullable<Env[K]> {
  const value = getEnv()[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required environment variable ${key} (needed for: ${purpose})`);
  }
  return value as NonNullable<Env[K]>;
}
