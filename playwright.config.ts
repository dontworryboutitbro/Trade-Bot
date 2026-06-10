import { defineConfig } from "@playwright/test";

// E2E tests run against zero-credential MOCK mode — no external APIs.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 1,
  workers: 1, // shared in-memory store: keep tests sequential
  use: {
    baseURL: "http://localhost:3199",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev -- --port 3199",
    url: "http://localhost:3199",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      // Force mock mode regardless of local .env.local contents.
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      ANTHROPIC_API_KEY: "",
      ALPACA_PAPER_API_KEY: "",
      ALPACA_PAPER_API_SECRET: "",
      ALPACA_LIVE_API_KEY: "",
      ALPACA_LIVE_API_SECRET: "",
    },
  },
});
