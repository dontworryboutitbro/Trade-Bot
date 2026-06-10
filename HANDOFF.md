# Handoff — Fable Fund Lab

_Last updated: 2026-06-10_

## Status

**All 10 implementation phases complete.** The app runs locally in zero-credential MOCK mode
and is ready for Supabase / Anthropic / Alpaca paper credentials and Vercel deployment.

- Current mode: `MOCK` (default)
- Live trading: coded, tested, **locked** (no live credentials exist anywhere)
- Deployment: not yet — needs GitHub repo + Vercel import (manual steps below)

## Verification results (run on this machine)

| Command | Result |
|---|---|
| `npm run lint` | ✅ clean |
| `npm run typecheck` | ✅ clean (strict mode) |
| `npm run test` | ✅ 71/71 (risk engine 37, modes 10, AI schema 10, pipeline integration 14) |
| `npm run test:e2e` | ✅ 8/8 Playwright (dashboard, login, settings, approval flow, kill switch, setup, live-mode safety) |
| `npm run build` | ✅ production build succeeds |
| Manual browser check | ✅ Overview/Settings/Activity verified; AI evaluation → approval → executed fill exercised live |

## Architecture summary

- **Next.js 16 (App Router) + TypeScript strict + Tailwind 4**; Recharts; Zod 4; Vitest; Playwright.
- **AI decides, code enforces**: `AnthropicDecisionClient` (claude-fable-5, no tools, JSON-only,
  `.strict()` Zod schema) → 22-check deterministic `RiskEngine` (run twice) → brokerage adapter.
- **Adapters**: `MockBrokerageClient` (zero network), `AlpacaPaperBrokerageClient`,
  `AlpacaLiveBrokerageClient` (read-only in `LIVE_LOCKED`); selected by a single mode→client factory.
- **Store**: `MemoryStore` (mock, seeded demo data) or `SupabaseStore` (auto-selected when env
  vars exist). Full SQL schema + RLS in `supabase/migrations/0001_init.sql`.
- **Mode state machine**: MOCK → PAPER_MANUAL → PAPER_AUTONOMOUS → LIVE_LOCKED →
  LIVE_MANUAL/LIVE_AUTONOMOUS, with server-enforced activation ceremonies.
- **Idempotency**: deterministic `client_order_id` per proposal + DB unique constraint +
  reconcile-before-retry; cron runs deduplicated by `(job_name, idempotency_key)`.

## Key files

```
src/lib/risk/engine.ts          22 deterministic risk checks (+ engine.test.ts, 37 tests)
src/lib/trading/pipeline.ts     evaluation → risk → execution → reconcile → snapshots
src/lib/trading/admin.ts        kill switch, mode changes, approvals, limits, symbols
src/lib/trading/modes.ts        mode state machine + ceremony validation
src/lib/ai/client.ts            Anthropic integration (claude-fable-5) + mock engine
src/lib/ai/schema.ts            strict Zod schema for AI output
src/lib/brokerage/{mock,alpaca,factory}.ts
src/lib/store/{memory,supabase,types}.ts
src/lib/{env,auth,api,cron,services,dashboard}.ts
src/app/(dashboard)/            overview, positions, activity, performance, settings, setup
src/app/api/admin/*             9 authenticated admin routes
src/app/api/cron/*              4 CRON_SECRET-protected idempotent jobs
supabase/migrations/0001_init.sql
e2e/dashboard.spec.ts           8 Playwright tests
vercel.json                     cron schedules
```

## Manual setup still needed (in order)

1. **Try mock mode now**: `npm run dev` → http://localhost:3000 (no credentials needed).
2. **Supabase**: create project → 3 env values → run the SQL migration in the SQL Editor →
   add your admin user → disable public signups. (README §Setup 1)
3. **Anthropic**: create API key → `ANTHROPIC_API_KEY`. (README §Setup 2)
4. **Alpaca**: create account → paper API keys → 2 env values. (README §Setup 3)
5. **Secrets**: `openssl rand -hex 32` for `CRON_SECRET` and `APP_ENCRYPTION_KEY`.
6. **GitHub**: create empty repo → `git remote add origin … && git push -u origin main`.
7. **Vercel**: import repo → add env vars → deploy → trim crons to 2 if on Hobby plan.
8. **Verify paper**: Diagnostics green → Health check OK → switch to PAPER_MANUAL → approve one
   trade → confirm at Alpaca.

Credentials still needed: Supabase (3), Anthropic (1), Alpaca paper (2), CRON_SECRET,
APP_ENCRYPTION_KEY. Live Alpaca keys: **deliberately not yet** — only after weeks of paper results.

## Next recommended step

Run `npm run dev`, explore mock mode (trigger an AI evaluation from Settings → Automation,
approve the trade, test the kill switch), then start the Supabase setup from the in-app
**Setup** page.
