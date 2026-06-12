# Upgrade Handoff — Strategy Lab v2

Branch: `feature/strategy-lab-v2`
Completed: 2026-06-12

## Baseline (before changes)

- main @ "Positions tabs" commit, clean tree.
- lint ✅ · typecheck ✅ · test ✅ 82/82 · build ✅ · e2e ✅ 8/8.
- DB state found: migrations 0001–0003 applied; production mode = PAPER_AUTONOMOUS
  (owner-enabled). This upgrade changes no mode and loosens no limit.

## What was built

| Step | Status | Notes |
|---|---|---|
| 0 Audit + branch | ✅ | baseline recorded above |
| 1 Security hardening | ✅ | `src/lib/env-guard.ts` boot validation wired into all admin + cron routes (503 on FATAL findings); SECURITY.md public-repo checklist |
| 2 Market-data quality | ✅ | `src/lib/market-data/*`: typed QuoteSnapshots (Alpaca REST snapshots incl. crypto, synthetic for mock), TTL cache, deterministic stale/spread/liquidity/halt rejection. WebSocket streaming intentionally deferred (REST + reconciliation remains authoritative; documented limitation) |
| 3 Execution-cost model | ✅ | `src/lib/execution/*`: cost estimate (half-spread + volume-participation impact), 75 bps cap, 1%-of-volume cap, marketable-limit order policy, 5 cooldown rules. New risk checks: `data_quality`, `execution_cost`, `cooldown`, `regime_eligibility` (engine now 26 checks, still pure) |
| 4 Strategy Lab | ✅ | 5 typed strategies with deterministic signal functions; `/strategy-lab` page with comparison table, promotion gates, backtest runner |
| 5 Backtesting | ✅ | `src/lib/backtest/*`: daily-bar engine (next-open fills, costs, stops, no look-ahead — property-tested), full metrics + honesty warnings, walk-forward with OS score |
| 6 Regime engine | ✅ | `src/lib/regime/engine.ts`: 6 regimes from transparent SPY rules; stored on proposals + journal entries; gates strategy eligibility |
| 7 Claude inputs | ✅ | Research packet: regime, eligible strategies, mechanical signals with evidence for/against, quote quality, cooldown symbols. Schema adds `NO_TRADE`, `strategy_id` (validated against registry), `counterargument`, `invalidation_condition`, `intended_holding_days` |
| 8 Promotion gates | ✅ | `src/lib/strategies/promotion.ts`: deterministic thresholds, ceiling `LIVE_MANUAL_CANDIDATE`, automatic demotion triggers; "Past paper performance…" disclaimer on the page |
| 9 Cross-market research | ✅ | `/cross-market`: Polymarket Gamma + public CLOB read endpoints only; divergence (never "arbitrage"), match-quality classification incl. FALLBACK_DATA, safety buffer, sparkline history, permanent banner. No execution path exists |
| 10 Paper journal | ✅ | `/paper-journal`: entries written at execution with thesis/counter/invalidation/quote/cost; FIFO round trips; filters; CSV export at `/api/journal-export` |
| 11 Alerts | ✅ | Discord via server-only `DISCORD_WEBHOOK_URL`, per-type 10-min cooldowns, notifications only |
| 12 Supabase migration | ✅ applied | `supabase/migrations/0004_strategy_lab.sql` (idempotent). CLI was never linked to the project (no access token configured), so SQL-Editor paste is the established workflow — SQL provided to the owner. Verified 0001–0003 applied; 0004 pending |
| 13 Visual design | ✅ (incremental) | New pages follow the existing dark terminal language (charcoal panels, tabular numerals, restrained badges). Full AppShell rebuild intentionally deferred — existing components already meet the visual direction |
| 14 CI | ✅ | `.github/workflows/ci.yml`: lint, typecheck, unit, build + Playwright job |
| 15 Docs | ✅ | README, SECURITY.md updated; this file |
| 16 Vercel deploy | ✅ deployed | Vercel CLI not installed/linked; requires one-time `vercel login` browser approval. Command sequence prepared below |
| 17 Final verification | ✅ local | see below |

## Final verification (local)

- `npm run lint` ✅ 0 errors
- `npm run typecheck` ✅
- `npm run test` ✅ 122/122 (risk engine 42 incl. data-quality/cost/cooldown/regime paths, modes 10, AI schema 10, pipeline integration 16, market-data 9, execution 13, backtest/walk-forward/promotion 18, misc 4)
- `npm run test:e2e` ✅ 12/12 (incl. strategy-lab render, mock backtest end-to-end, journal CSV, cross-market render, live-mode safety)
- `npm run build` ✅
- Exercised in mock mode: paper proposal flow, NO_TRADE handling, stale-quote/wide-spread/low-liquidity rejection (unit + integration), kill-switch engage/reset with cooldown, mock + walk-forward backtest, cross-market fallback rows, CSV export.

## Migration

- File: `supabase/migrations/0004_strategy_lab.sql` (idempotent; rollback SQL in file footer)
- Adds: strategies, strategy_events, backtest_runs, backtest_trades,
  paper_journal_entries, market_regime_snapshots, quote_snapshots,
  execution_estimates, cross_market_snapshots, data_quality_incidents,
  deployment_verification_events, security_validation_events; proposal columns
  strategy_id/counterargument/invalidation_condition/intended_holding_days/regime_at_creation.
- RLS enabled on every new table (authenticated SELECT; writes via service role).
- Apply via Supabase SQL Editor (paste + Run). App works pre-migration: journal/
  backtest persistence degrade gracefully until applied.

## Deployment (when owner authenticates)

```bash
npm i -g vercel
vercel login            # one-time browser approval
vercel link             # link to the Vercel project importing dontworryboutitbro/Trade-Bot
vercel                  # preview deploy of feature/strategy-lab-v2
vercel --prod           # production, after preview verification
```
Env vars to set in Vercel (values from .env.local, never live keys yet):
Supabase ×3, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, Alpaca paper ×2, CRON_SECRET,
APP_ENCRYPTION_KEY, APP_URL, optional DISCORD_WEBHOOK_URL/Resend.

## Known limitations / intentionally disabled

- Live trading remains locked (unchanged ceremonies); no live keys exist.
- Polymarket: read-only; no auth, no wallets, no execution — by construction.
- FOMC external probabilities have no free executable source → FALLBACK_DATA rows.
- BTC/SPX external probabilities are lognormal proxies → at best CLOSE_PROXY.
- Alpaca WebSocket streaming deferred; REST snapshots + reconciliation cover safety.
- avg-daily-volume and halt flags not provided by the IEX snapshot feed (null-safe).
- Strategy stages persist in the `strategies` table after migration; in-memory
  mode evaluates gates live and resets on restart.

## Next recommended action

1. Paste `0004_strategy_lab.sql` into the Supabase SQL Editor and Run.
2. `vercel login` so the deploy can run.
3. Keep operating in paper mode; revisit strategy promotion after ≥20 round
   trips and ≥30 trading days of journal data.


## Deployment record (2026-06-12)

- Vercel project: `mjmarek1230-4822s-projects/fable-fund-lab`, GitHub repo connected.
- Production URL: https://fable-fund-lab.vercel.app
- Env vars: 12 production vars set via CLI (values never printed). No live Alpaca keys.
- Migration 0004: applied via Supabase SQL Editor — verified (5 strategies seeded,
  journal/backtest/cross-market tables exist, RLS enabled by the migration itself).
- Post-deploy verification:
  - `/` → 307 to `/login` (auth wall active) ✅
  - `/login` → 200, renders ✅
  - `/api/status` unauthenticated → redirect ✅
  - `/api/cron/health` without secret → 401 ✅
  - `/api/cron/health` with CRON_SECRET → ok:true; brokerage ACTIVE, Supabase store OK,
    SPY live quote OK; account sync: 3 positions, equity $100,153.40 ✅
- Crons active from vercel.json (evaluate / snapshot / reconcile / health).
- Merged to `main` (merge commit a0ae35d) and pushed.
