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


# Step 18 — Daily Adaptive Learning Engine (2026-06-12)

## Built

| Piece | Where | Notes |
|---|---|---|
| Nightly learner | `src/lib/learning/daily-review.ts` + `/api/cron/learn-daily` (22:45 UTC wkdays) | snapshot check, reconcile, outcome labels (1/3/5/10/20d, MFE/MAE, SPY-relative, abstain-was-better), calibration, challenger generation, shadow tick, daily report, alerts |
| Weekly validator | `src/lib/learning/weekly-validation.ts` + `/api/cron/validate-weekly` (Sat 14:30 UTC) | walk-forward per version, doubled-cost sensitivity, promotion gates → promotion_reviews (manual approval), rollback checks, weekly report |
| Feature store | `feature_observations` via generic learning store (whitelisted tables, k1–k4 + jsonb payload) | captures EXECUTED / RISK_REJECTED / NO_TRADE decisions with full market+portfolio context |
| Calibration | `src/lib/learning/calibration.ts` | 6 buckets, OVER/UNDER-confident verdicts, tighten-only autonomous min-confidence penalty (capped 95) |
| Champion/challenger | `src/lib/learning/challengers.ts`, `promotion.ts` | immutable versions (DB trigger), hardcoded param ranges, ≤3 challengers/week, deterministic systematic variants |
| Shadow mode | inside daily-review | unit-quantity hypothetical trades, stress-tested P/L, zero orders (integration-tested) |
| Rollback | `evaluateRollback` | disables entries (exits preserved), alert + audit, triggers: negative stressed expectancy, drawdown, regime exit, calibration decay, one-trade reliance |
| Fail-closed | risk engine `data_quality` / `execution_cost` / new `learning_inputs` checks (engine now 27 checks) | MOCK/PAPER_MANUAL warn; PAPER_AUTONOMOUS + LIVE block on missing snapshot/cost/portfolio-snapshot/regime/calibration |
| Realism penalties | `src/lib/learning/realism.ts` | spread/slippage/impact bps + partial-fill haircut + stale/liquidity/vol adders; promotion uses stressed P/L only |
| Streaming | `src/lib/streaming/market-stream.ts` | opportunistic Alpaca WS (long-lived runtimes only — Vercel functions are request-scoped, documented); REST authoritative; freshness-unverifiable → fail-closed block |
| Dashboard | `/learning` | reports, calibration table, version table, promotion reviews, rollbacks, streaming health + manual run buttons |
| Migration | `supabase/migrations/0005_daily_learning.sql` | 10 learning tables, RLS, immutability trigger, rollback SQL in comments. Cron idempotency reuses cron_runs unique constraint (documented design choice vs separate key tables) |

## Verification

- lint ✅ · typecheck ✅ · **150/150 unit+integration tests** · **14/14 Playwright e2e** · build ✅
- Integration-proven: daily learner places zero orders and changes zero settings;
  weekly validator never auto-promotes (champions stay @1 without manual approval);
  cron idempotency keys dedupe; challenger params outside hardcoded ranges rejected.
- Cron plan: existing hourly crons already deploy on this Vercel account; the two
  new schedules (daily + weekly) are lower-frequency than what is already accepted.

## Doc cleanup performed
- README/SECURITY/UPGRADE_HANDOFF updated; stale "0004 pending"/"deploy pending"
  statements were already corrected in the deployment record above; test counts
  updated to 150/14.


## Step 18 production verification (2026-06-12)

- Migration 0005 applied via SQL Editor; all 10 learning tables verified present.
- First production `learn-daily` run: ok=true. Regime SIDEWAYS_LOW_VOL; account
  $100,122.51 equity; 4 proposals / 3 executed / 26 passive decisions today;
  0 labeled samples yet (expected on day one — autonomous min confidence 55);
  3 challengers generated into shadow mode (trend-pullback@2,
  relative-momentum@2, mean-reversion@2).
- First production `validate-weekly` run: ok=true. 5 baseline champions
  recorded; challengers ranked (0 shadow trades yet — promotion correctly
  reports requirements not met).
- Crons scheduled in vercel.json: learn-daily 22:45 UTC weekdays,
  validate-weekly Saturday 14:30 UTC.


# Alpaca intraday-margin update (2026-06-12)

Alpaca deprecated legacy PDT protection (2026-06-04). Audit confirmed this app
never enforced a PDT day-trade-count rejection; the change is therefore purely
additive safety:

- New risk checks (engine now 29): `account_freshness` (buying power/equity
  must be <5 min old before execution; fail-closed in autonomous/live, warning
  in manual/mock) and `intraday_margin` (effective buying power =
  min(cash, broker BP) → hard 1× cash cap in every mode; maintenance-margin
  cushion enforced when reported; sells exempt).
- `patternDayTrader` / `dayTradeCount` / `maintenanceMargin` now captured from
  the Alpaca account — analytics only, never a rejection input.
- Daily learning report tracks same-day round trips; ≥5/day raises an
  overtrading review item.
- Internal max-trades/day limits documented as risk management, not compliance.
- 10 new engine tests (unlimited day-trades pass, buying-power rejection, 1×
  cash cap vs offered leverage, sub-$2k account at 1×, maintenance-margin
  deficit rejection, stale/missing account data, margin+short defaults,
  autonomous 1× cap, sell exemption).
- Totals: 160 unit/integration tests, 14 e2e — all passing; deployed to
  production.


# Step 19 — Controlled Live-Money Pilot Readiness (2026-06-12)

## Built
- **LIVE_MANUAL_PILOT mode**: reachable only from LIVE_LOCKED, full ceremony +
  dedicated phrase `ENABLE LIVE PILOT TRADING` + ALL mandatory readiness drills
  passing within 7 days (server-enforced in changeTradingMode). Manual approval
  per order; limit-orders-only (market plans converted to marketable limits);
  long-only, cash-only, allowlist-only, no crypto, regular hours; fractional
  shares (4 dp) so a $50 cap works on $700 ETFs.
- **Pilot hard caps** (`pilot_limits` — engine now 30 checks): $250 max capital
  via env ceiling, $50/position, 2 positions, 2 entries/day, $10 daily-loss
  halt, 3% weekly-loss halt, 25 bps spread cap, 60s quote-age cap, 30 bps
  slippage cap. All env-var configurable (server-only); capital stage stored in
  app_settings and changed only via the audited typed-confirmation route.
  Pilot caps LAYER ON TOP of existing limits (10%/60% concentration etc. still
  apply — nothing was loosened).
- **Readiness drills** (`/settings/live-readiness` + `/api/admin/drills`):
  14 automated drills (kill switch, duplicate-order idempotency, WS-disconnect/
  REST fallback, stale-quote/wide-spread/low-liquidity rejection, missing
  account/portfolio/quote snapshots, invalid AI response, DB write guard,
  Discord (optional), live-key separation, browser secret scan, audit round
  trip). Results persisted; activation gate checks the latest run.
- **Capital stages**: CANARY_100 / PILOT_250 / PILOT_500 / REVIEW_REQUIRED($0);
  manual + typed confirmation + CRITICAL audit + alert; never automatic.
- **Feed visibility**: IEX — LIMITED COVERAGE warning displayed; SIP never
  assumed.
- **Daily live-pilot report**: emitted by the nightly learner whenever a live
  mode is active (capital, deployment, fills, rejections, P/L, costs,
  drawdown, approvals, streaming, kill-switch state, review items).
- **Paper-capital realism**: TARGET_LIVE_PILOT_CAPITAL=250; warning when paper
  equity exceeds 4× the target.
- Migration `0006_live_pilot.sql`: trading_mode enum value + pilot_capital_stage
  column (idempotent; rollback notes inline).

## Verification
- lint ✅ typecheck ✅ **178/178 unit** ✅ **17/17 e2e** ✅ build ✅
- e2e proves: pilot unreachable without ceremony; drills run green in mock;
  stage changes need the typed phrase; readiness page renders.

## What remains DISABLED
- All live trading. Current mode is unchanged. No live keys exist in any env.
- LIVE_AUTONOMOUS remains fully locked. Cross-market and learning systems have
  no execution path. Streaming entry-gating fails closed.

## Runbook
- **Run readiness drills**: Settings → Live readiness → Run all drills (or
  POST /api/admin/drills). Valid 7 days.
- **Enable the pilot** (deliberately long): fund an isolated Alpaca live
  account with ≤$100 (CANARY) → add ALPACA_LIVE_API_KEY/SECRET to Vercel env →
  redeploy → Settings → mode LIVE_LOCKED → verify balances → run drills →
  mode LIVE_MANUAL_PILOT → ceremony (connectivity, kill-switch test,
  acknowledgments, type ENABLE LIVE PILOT TRADING).
- **Stop all trading immediately**: top-bar KILL SWITCH (any page, mobile too);
  it persists across restarts. Then Settings → cancel open orders.
- **Rotate keys**: regenerate at Alpaca/Supabase/Anthropic → update Vercel env
  vars → redeploy → verify Settings → Diagnostics.
- **Revoke live access**: delete ALPACA_LIVE_* from Vercel env + redeploy, or
  regenerate (invalidate) the keys at Alpaca. Mode falls back safely — the
  factory fails loudly without live credentials.
- **Reduce enabled capital**: Settings → Live readiness → stage REVIEW_REQUIRED
  ($0, blocks new entries) or any lower stage; reductions need the same typed
  confirmation but are always allowed.
- **Roll back a deployment**: Vercel dashboard → Deployments → previous build →
  Promote to Production (or `vercel rollback`). DB migrations 0001–0006 are
  additive; rollback SQL is in each migration's comments.


# Step 13 — Terminal Redesign (2026-06-12)

## Implemented (no trading logic touched)
- **Design system** (`globals.css`): near-black cool-undertone background
  (#0a0b10), graphite surfaces, electric-magenta (#e0409a) + muted-violet
  (#8b6cd9) accents, faint background grid + scanline texture (desktop only,
  disabled under prefers-reduced-motion), edge-glow utilities, live-pulse
  keyframe, chart radial aura, monospaced numeral utility (.font-num).
- **Primitives** (`ui.tsx`): terminal panels (6px radius, uppercase
  micro-labels, hover border-lift), terminal badges/chips, monospaced Stat
  values, sticky table headers, LivePulse, StatusRow (LABEL → STATE rows).
- **Shell**: redesigned sidebar (geometric 3-stroke logo mark, magenta
  left-border active nav, bottom system-status stack: mode/feed/Supabase/
  Alpaca/learner/kill-switch); top bar with SPY price + daily move, market
  regime chip, sync clock, connection pulses, kill switch.
- **Overview command center**: 12-column grid — left metric stack (8 compact
  panels), central chart module with PORTFOLIO / VS SPY / DRAWDOWN toggles and
  5D/1M/3M/YTD/ALL ranges (`command-chart.tsx`), right column AI RESEARCH
  ENGINE panel (live learner stats, champions/challengers) + SYSTEM STATUS
  stack, lower strip (positions, trades, risk rejections, alerts), emergency
  controls, terminal footer line.
- **New pages**: `/alerts` (grouped console: critical / requires review /
  informational) and `/audit` (filterable audit-event terminal table).
- **Charts** retinted: magenta primary, violet benchmark, muted gray axes,
  graphite tooltips (equity, autopilot, cross-market sparkline).
- All numerals monospaced; status copy in terminal voice (ARMED / LOCKED /
  IEX LIMITED / SHADOW / ACTIVE).

## Validation
- lint ✅ typecheck ✅ 178/178 unit ✅ 17/17 e2e ✅ build ✅
- Reviewed at 1600px (command-center grid) and 390px (stacked cards,
  scrollable nav, kill switch visible). Magenta usage restrained to the
  primary line, active nav, AI states, and approvals glow.

## Remaining visual ideas (optional, later)
- Per-page terminal tabs on the lower overview strip; keyboard shortcuts;
  drawdown overlay on the Strategy Lab equity chart; sortable column headers.


# Step 20 — Always-On Scanner + Dynamic Universe (2026-06-12)

## Built
- Universe layers (DISCOVERY ⊇ RESEARCH ⊇ PAPER_EXECUTION ⊇ LIVE_MANUAL;
  LIVE_AUTONOMOUS intentionally not implemented) with deterministic equity and
  crypto filters (`src/lib/universe/*`), server `UNIVERSE_DENYLIST`, and a
  mandatory crypto fee model (25 bps base taker + half-spread + impact).
- Deterministic candidate ranking; MAX_AI_CANDIDATES=8 hard cap — the whole
  market is never prompted.
- Auto-managed allowlist sync with `EXECUTION_UNIVERSE_CHANGED` audits;
  held positions never deactivated (crypto symbols normalized BTCUSD↔BTC/USD);
  **exits are always allowed for known symbols even after deactivation**
  (engine `symbol_approved` rule, tested).
- `/scanner` page (counts, ranked candidates with score components, rejection
  reasons with filters, worker health, universe-change history); explicit
  system states replace "LEARNER IDLE" (sidebar: SCANNER ACTIVE / MONITORING /
  LEARNING SCHEDULED).
- Serverless baseline cron `/api/cron/universe` every 6h (+15m offset);
  manual UNIVERSE_REFRESH admin job.
- Always-on worker (`worker/`, self-contained Node ≥22, no order code):
  equity + crypto WebSocket streams, auto-reconnect with backoff, REST
  fallback probe, 60s heartbeats → `worker_heartbeats`, stream-health events,
  health HTTP endpoint, 5-min scan cadence, 6h universe trigger. Deploy via
  Railway/Fly per `worker/README.md` (needs owner account — pending).
- Migration `0007_dynamic_universe_and_scanner.sql` (spec said 0006; taken) —
  applied + verified.

## Production verification
- First live refresh: **13,852 equities + 36 crypto pairs discovered**,
  89 research-eligible, 40 paper-execution eligible from the bounded pool,
  24 liquid symbols auto-activated (AAPL, MSFT, NVDA, GOOGL, …); top-ranked
  candidate IWM (87.9). Rejection reasons recorded per symbol.
- Found+fixed in first run: crypto volume floor was global-scaled while
  Alpaca venue volume is small → venue-scaled $50k floor; exit-trap on
  deactivated symbols → exits now always allowed; crypto held-position
  symbol normalization. Crypto pairs re-qualify automatically on the next
  6-hour refresh.
- Tests: **192 unit + 18 e2e**, lint/typecheck/build clean. Deployed.

## Intentionally disabled / pending
- LIVE_AUTONOMOUS universe: not implemented by design.
- Crypto live execution: disabled (paper research/execution only).
- Worker deployment: requires owner's Railway/Fly account (steps in
  worker/README.md). Without it the 6h cron baseline still scans.

## Next recommended action
Deploy the worker to Railway for 24/7 streaming freshness, then watch
/scanner over a week of refresh cycles before widening any thresholds.


## Worker deployment record (2026-06-12)

- Host: Railway — project `fable-fund-worker` (workspace: dontworryboutitbro's Projects)
- Health URL: https://fable-fund-worker-production.up.railway.app
  → `{"ok":true,"equity":"CONNECTED","crypto":"CONNECTED",...}`
- Env vars set via CLI (values never printed): APP_URL, CRON_SECRET,
  Supabase URL + service key, Alpaca paper key/secret.
- Verified: equity + crypto WebSocket streams CONNECTED (16 equities, 6 crypto
  pairs subscribed; quotes ticking); 60s heartbeats landing in Supabase
  `worker_heartbeats` (status OK); worker triggered `/api/cron/universe` → 200;
  REST fallback + reconnect logic in place (first deploy ran credential-less in
  fallback mode, proving the degraded path works).
- Dashboard now shows SCANNER ACTIVE while heartbeats are fresh (<3 min).
- Stop/rollback: Railway → fable-fund-worker → remove service (dashboard falls
  back to the 6-hour serverless cron automatically).
