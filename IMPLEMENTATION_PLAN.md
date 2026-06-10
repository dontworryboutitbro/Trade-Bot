# Fable Fund Lab — Implementation Plan

A private, single-owner AI-assisted investment dashboard. The AI (Claude `claude-fable-5`)
proposes trades; deterministic TypeScript code enforces every boundary.

## Architecture

```
Browser (minimal permissions, no secrets)
   │
   ▼
Next.js App Router (Vercel)
   ├─ UI pages: Overview / Positions / Activity / Performance / Settings / Setup
   ├─ Protected server routes (admin actions, approvals, emergency controls)
   └─ Cron routes (CRON_SECRET-protected, idempotent)
        │
        ├─ AiDecisionClient ──► Anthropic API (claude-fable-5, strict Zod-validated JSON)
        ├─ RiskEngine (deterministic TypeScript, runs twice: at proposal + before execution)
        ├─ BrokerageClient ──► Mock | Alpaca Paper | Alpaca Live (locked)
        ├─ MarketDataClient ──► Mock | Alpaca Data API
        ├─ AuditLogger / NotificationClient ──► Supabase
        └─ Supabase Postgres (RLS) — settings, proposals, orders, snapshots, audit
```

## Core rule

AI decides, code enforces. AI output is untrusted input. Every proposal passes:
schema validation → approved-symbol check → deterministic risk checks → fresh-data
checks → cash check → duplicate protection → mode check → audit log → final re-check
immediately before execution.

## Trading modes (server-side state machine)

MOCK → PAPER_MANUAL → PAPER_AUTONOMOUS → LIVE_LOCKED → LIVE_MANUAL → LIVE_AUTONOMOUS

Live modes require an activation ceremony (typed phrase, checkboxes, kill-switch test).
The AI can never change mode, limits, or symbols.

## Phases

1. ✅ Scaffold Next.js + tooling, dashboard shell
2. Supabase schema, migrations, seed, auth, RLS
3. Brokerage interfaces: Mock / Alpaca Paper / Alpaca Live (locked), env validation, diagnostics
4. Deterministic risk engine + tests, audit logging, mode state machine, emergency controls
5. Anthropic integration (claude-fable-5), Zod schema, proposal persistence
6. Approval flow, autonomous paper flow, execution pipeline, idempotency, reconciliation, snapshots, SPY benchmark
7. Finish all six pages, responsive polish
8. Cron routes + idempotency, in-app alerts, optional Resend email, Vercel config
9. LIVE_LOCKED, live onboarding checklist, LIVE_MANUAL / LIVE_AUTONOMOUS ceremonies (locked by default)
10. Full test suite, lint, typecheck, build, HANDOFF.md

## Key decisions

- MOCK mode works with **zero credentials**: an in-memory mock store backs the whole UI,
  and a demo-admin session is used when Supabase is not configured. Once Supabase env
  vars exist, real auth is required.
- All secrets are server-only (`src/lib/env.ts` is imported with `server-only`).
- Orders use unique `client_order_id` + DB uniqueness constraints for idempotency.
- Mock implementation lives in its own module and can never reach Alpaca.
