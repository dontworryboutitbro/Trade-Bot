# Security — Fable Fund Lab

## Threat model

| Threat | Mitigation |
|---|---|
| AI proposes harmful trades (hallucinated symbols, oversized orders, prohibited assets) | Strict Zod schema (`.strict()`, rejects extra fields), then a 22-check deterministic risk engine run twice — at proposal time and on fresh data immediately before execution |
| Prompt injection via market data | The model gets numeric summaries only, is told external data is untrusted, has **no tools and no URLs**, and its output is parsed as data, never executed |
| AI tries to change limits / mode / kill switch | There is **no code path**: the AI client returns JSON to the pipeline; limits, modes, symbols, and emergency controls live behind admin-authenticated routes the AI cannot reach. Schema rejects smuggled fields. Prohibition flags (margin/options/short/crypto/leveraged/inverse/OTC) cannot be loosened through the app by anyone |
| Secret leakage to the browser | All secrets live in server-only modules (`server-only` import guard); only `NEXT_PUBLIC_SUPABASE_URL` and the publishable key are exposed; diagnostics shows booleans, never values |
| Stolen browser session | Supabase Auth + middleware on every page; the browser has SELECT-only RLS policies; every write goes through server routes that re-authenticate |
| Wrong-account trading | Mode → credential mapping is centralized in one factory: paper keys only in paper modes, live keys only in live modes, mock makes zero network calls; `LIVE_LOCKED` client throws on any order method |
| Accidental live activation | Live modes are reachable only from `LIVE_LOCKED`, after a live connectivity check, a kill-switch test, acknowledgments, and an exact typed phrase; enforced server-side (tested) |
| Duplicate / phantom orders | Deterministic `client_order_id` per proposal + DB unique constraint; on timeout the pipeline reconciles by `client_order_id` before any retry; never assumes failure from a network error |
| Runaway automation | Kill switch persists in the DB across restarts; daily-loss and drawdown halts; max 3 trades/day; cron idempotency keys with a unique constraint |
| Cron abuse | `CRON_SECRET` bearer check + per-window idempotency keys |

## Secret handling

- `.env.local` is gitignored (`.env*` pattern, with `!.env.example`).
- Secrets are read only inside `src/lib/env.ts` (guarded by `server-only`) and never logged.
- No secret uses the `NEXT_PUBLIC_` prefix.
- The Supabase service-role key is used only by the server-side store; the browser client uses
  the publishable key under RLS.

## Privilege separation

```
AI            → may return JSON proposals. Nothing else.
Browser       → authenticated SELECT via RLS. No writes.
Server routes → authenticated admin actions; service-role DB access; brokerage adapters.
Cron routes   → CRON_SECRET; same server-side pipeline; idempotent.
```

## Deterministic risk engine

`src/lib/risk/engine.ts` — pure functions, no I/O, 37 unit tests. All checks always run (no
short-circuit) so every evaluation stores the complete check list and exact failure reasons.
Defaults: 5 positions max, 60% max exposure, 10% per symbol, 3 trades/day, 2% daily-loss halt,
8% drawdown halt, $10 min share price, market hours only, long-only, cash-only.
Live adds: $1,000 max funded balance, $100 max order (absolute).

## Kill-switch behavior

Engaging: persists `global_kill_switch=true` and `stop_new_orders=true` in the DB, rejects all
pending/queued proposals, attempts `cancelAllOrders()` at the brokerage (best-effort, never
blocks the switch), writes a CRITICAL audit event and alert. The risk engine independently
blocks anything while the flag is set — even if the UI is compromised.
Resetting requires the typed phrase `RESET KILL SWITCH`; stop-new-orders stays on afterwards.

## Live-activation safeguards

State machine (`src/lib/trading/modes.ts`): `LIVE_MANUAL`/`LIVE_AUTONOMOUS` are only adjacent
to `LIVE_LOCKED`. Server-side validation requires: connectivity verified, kill-switch tested,
all acknowledgments, and the exact phrase. Unit + e2e tests assert no request lacking the full
ceremony can reach a live mode.

## Known limitations

- Single-instance in-memory store in MOCK-without-Supabase mode: state resets on restart (by design).
- The leveraged/inverse/OTC screen for newly added symbols is heuristic (name/exchange based);
  the admin remains responsible for the allowlist. The seeded ETF list is pre-vetted.
- Daily-loss/drawdown figures derive from snapshots; if snapshots are missing, those checks
  degrade conservative-neutral (0%), not fail-closed.
- No 2FA inside the app itself — enable MFA on Supabase, Alpaca, Anthropic, Vercel, GitHub.
- Alpaca paper/live keys grant full account API access; scope risk lives with Alpaca.

## Incident response

1. **Engage the GLOBAL KILL SWITCH** (top bar — works on mobile).
2. Settings → CANCEL OPEN ORDERS, then CLOSE ALL POSITIONS if warranted.
3. If credentials may be compromised: regenerate keys at Alpaca / Supabase / Anthropic,
   update Vercel env vars, redeploy.
4. Review the audit log (Settings) and `risk_evaluations` for the full decision trail.
5. Re-enable deliberately: reset kill switch (typed phrase) → re-disable stop-new-orders →
   start in PAPER_MANUAL regardless of prior mode.

## Strategy Lab v2 additions (2026-06)

- **Startup security validation** (`src/lib/env-guard.ts`): every admin and cron
  route refuses to operate (HTTP 503) when a FATAL finding exists — secrets with
  `NEXT_PUBLIC_` prefixes, identical paper/live Alpaca keys, paper URL pointing
  at the live API, live keys present with incomplete safety config, or a
  service-role key equal to the publishable key. Booleans/masked output only.
- **Market-data quality layer**: typed quote snapshots (bid/ask/spread/age/
  liquidity); stale quotes, wide spreads, missing bids/asks, low liquidity and
  halts deterministically block execution (`data_quality` risk check).
- **Execution-cost model**: bid-ask + impact estimate; trades whose estimated
  cost exceeds 75 bps or consume >1% of daily volume are blocked
  (`execution_cost` check). Wide-spread market orders are converted to
  marketable limit orders.
- **Cooldowns**: deterministic re-entry, post-loss (no averaging down),
  post-rejection, post-kill-switch-reset, and stale-data cooldowns (`cooldown`
  check).
- **Market-regime gating**: strategies declare approved regimes; proposals from
  ineligible strategies are blocked (`regime_eligibility` check).
- **Cross-market research is read-only by construction**: the Polymarket module
  contains no authentication, no wallets, no order types, and no import path to
  any brokerage adapter. It produces research rows, notes, and alerts only.
- **Discord alerts** use a server-only webhook (`DISCORD_WEBHOOK_URL`), send
  notifications only (never orders), and have per-type cooldowns.

### Public-repository checklist

- Review GitHub → Settings → Security → secret scanning alerts; enable **push
  protection**.
- Rotate any credential that has ever appeared in Git history or a chat.
- Secrets live only in `.env.local` (local) and Vercel env vars (production).
- Enable MFA on Alpaca, Supabase, Anthropic, GitHub, and Vercel.
- Never paste credentials into AI chats; never use `NEXT_PUBLIC_` for secrets.
