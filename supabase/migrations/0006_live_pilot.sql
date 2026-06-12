-- Live-pilot readiness — idempotent migration.
-- 1. New trading mode value (PG12+: safe outside explicit transaction blocks).
alter type trading_mode add value if not exists 'LIVE_MANUAL_PILOT' after 'LIVE_LOCKED';

-- 2. Capital stage on app_settings (manual + audited changes only).
alter table app_settings add column if not exists pilot_capital_stage text not null default 'CANARY_100'
  check (pilot_capital_stage in ('CANARY_100','PILOT_250','PILOT_500','REVIEW_REQUIRED'));

-- Rollback (manual):
--   alter table app_settings drop column if exists pilot_capital_stage;
--   (enum values cannot be dropped in Postgres; LIVE_MANUAL_PILOT stays defined
--    but unused — the application state machine controls reachability.)
