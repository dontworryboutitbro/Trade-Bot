# Upgrade Handoff — Strategy Lab v2

Branch: `feature/strategy-lab-v2`
Started: 2026-06-12

## Baseline (before changes)

- Repo state: main @ Positions-tabs commit; working tree clean.
- `npm run lint` ✅ · `npm run typecheck` ✅ · `npm run test` ✅ 82/82 · `npm run build` ✅
- Existing capabilities verified: risk engine (24 checks incl. crypto + stop rules),
  mode state machine, mock/paper/live(locked) adapters, kill switch, reconciliation,
  SPY benchmarking, cron idempotency, Supabase RLS, audit log, Playwright e2e.
- Default mode in production DB: PAPER (autonomous enabled by owner). Spec default
  remains PAPER_MANUAL; no mode change is made by this upgrade.

## Status log

- [x] Step 0 — audit + baseline + branch
- [ ] Step 1 — security hardening (env guard, docs)
- [ ] Step 2 — market-data quality layer
- [ ] Step 3 — execution-cost model + cooldowns
- [ ] Step 4 — Strategy Lab
- [ ] Step 5 — backtesting + walk-forward
- [ ] Step 6 — market-regime engine
- [ ] Step 7 — Claude research packet + NO_TRADE
- [ ] Step 8 — promotion gates
- [ ] Step 9 — Polymarket cross-market research (read-only)
- [ ] Step 10 — paper journal
- [ ] Step 11 — Discord alerts (optional)
- [ ] Step 12 — Supabase migration
- [ ] Step 13 — visual redesign
- [ ] Step 14 — GitHub Actions CI
- [ ] Step 15 — docs
- [ ] Step 16 — Vercel deploy
- [ ] Step 17 — final verification

(Entries below are appended as steps complete.)
