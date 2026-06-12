-- Strategy Lab v2 — idempotent migration. Preserves all existing tables/data.
-- Rollback: drop the new tables and columns listed at the bottom (no existing
-- table is altered destructively).

-- === trade_proposals: strategy attribution columns ===
alter table trade_proposals add column if not exists strategy_id text;
alter table trade_proposals add column if not exists counterargument text
  check (counterargument is null or char_length(counterargument) <= 300);
alter table trade_proposals add column if not exists invalidation_condition text
  check (invalidation_condition is null or char_length(invalidation_condition) <= 200);
alter table trade_proposals add column if not exists intended_holding_days int;
alter table trade_proposals add column if not exists regime_at_creation text;
create index if not exists trade_proposals_strategy on trade_proposals (strategy_id);

-- === strategy definitions + lifecycle ===
create table if not exists strategies (
  id text primary key,
  name text not null,
  version int not null default 1,
  stage text not null default 'RESEARCH_ONLY'
    check (stage in ('RESEARCH_ONLY','BACKTEST_ELIGIBLE','PAPER_MANUAL',
                     'PAPER_AUTONOMOUS_CANDIDATE','PAPER_AUTONOMOUS','LIVE_MANUAL_CANDIDATE')),
  enabled boolean not null default true,
  definition jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into strategies (id, name, stage) values
  ('trend-pullback','Trend-Following Pullback','PAPER_MANUAL'),
  ('relative-momentum','Relative-Strength Momentum','PAPER_MANUAL'),
  ('mean-reversion','Mean-Reversion Watchlist','PAPER_MANUAL'),
  ('defensive-rotation','Defensive Risk-Off Rotation','PAPER_MANUAL'),
  ('ai-discretionary','AI-Assisted Discretionary Research','PAPER_MANUAL')
on conflict (id) do nothing;

create table if not exists strategy_events (
  id uuid primary key default gen_random_uuid(),
  strategy_id text not null references strategies(id),
  event_type text not null check (event_type in ('PROMOTED','DEMOTED','ENABLED','DISABLED','VERSIONED')),
  from_stage text,
  to_stage text,
  reasons jsonb,
  actor text,
  created_at timestamptz not null default now()
);
create index if not exists strategy_events_strategy on strategy_events (strategy_id, created_at desc);

-- === backtests ===
create table if not exists backtest_runs (
  id uuid primary key default gen_random_uuid(),
  strategy_id text not null,
  config jsonb not null,
  start_date date,
  end_date date,
  metrics jsonb,
  walk_forward jsonb,
  warnings jsonb,
  status text not null default 'COMPLETED' check (status in ('RUNNING','COMPLETED','FAILED')),
  created_at timestamptz not null default now()
);
create index if not exists backtest_runs_strategy on backtest_runs (strategy_id, created_at desc);

create table if not exists backtest_trades (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references backtest_runs(id) on delete cascade,
  symbol text not null,
  entry_date date,
  exit_date date,
  entry_price numeric,
  exit_price numeric,
  quantity numeric,
  pl_usd numeric,
  pl_pct numeric,
  holding_days int,
  exit_reason text,
  costs_usd numeric
);
create index if not exists backtest_trades_run on backtest_trades (run_id);

-- === paper-trade journal ===
create table if not exists paper_journal_entries (
  id uuid primary key default gen_random_uuid(),
  environment environment not null,
  proposal_id uuid references trade_proposals(id),
  order_id uuid references brokerage_orders(id),
  symbol text not null,
  side text not null check (side in ('buy','sell')),
  quantity numeric not null,
  strategy_id text,
  regime text,
  confidence numeric,
  thesis text,
  counterargument text,
  invalidation_condition text,
  quote_snapshot jsonb,
  cost_estimate jsonb,
  fill_price numeric,
  data_quality_ok boolean not null default true,
  rules_followed boolean not null default true,
  lessons text,
  created_at timestamptz not null default now()
);
create index if not exists paper_journal_env on paper_journal_entries (environment, created_at desc);
create index if not exists paper_journal_strategy on paper_journal_entries (strategy_id);

-- === market regimes ===
create table if not exists market_regime_snapshots (
  id uuid primary key default gen_random_uuid(),
  regime text not null,
  metrics jsonb,
  rules jsonb,
  captured_at timestamptz not null default now()
);
create index if not exists market_regime_time on market_regime_snapshots (captured_at desc);

-- === quote snapshots + execution estimates (sampled, for audit/analytics) ===
create table if not exists quote_snapshots (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  payload jsonb not null,
  captured_at timestamptz not null default now()
);
create index if not exists quote_snapshots_symbol on quote_snapshots (symbol, captured_at desc);

create table if not exists execution_estimates (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid references trade_proposals(id),
  payload jsonb not null,
  created_at timestamptz not null default now()
);

-- === cross-market research (read-only module) ===
create table if not exists cross_market_snapshots (
  id uuid primary key default gen_random_uuid(),
  event_key text not null,
  midpoint numeric,
  payload jsonb,
  captured_at timestamptz not null default now()
);
create index if not exists cross_market_key on cross_market_snapshots (event_key, captured_at desc);

-- === incidents + verification events ===
create table if not exists data_quality_incidents (
  id uuid primary key default gen_random_uuid(),
  symbol text,
  incident_type text not null,
  details text,
  created_at timestamptz not null default now()
);

create table if not exists deployment_verification_events (
  id uuid primary key default gen_random_uuid(),
  check_name text not null,
  status text not null,
  details text,
  created_at timestamptz not null default now()
);

create table if not exists security_validation_events (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  severity text not null,
  message text,
  created_at timestamptz not null default now()
);

-- === RLS (single-owner: authenticated read; writes via service role only) ===
do $$
declare t text;
begin
  foreach t in array array[
    'strategies','strategy_events','backtest_runs','backtest_trades',
    'paper_journal_entries','market_regime_snapshots','quote_snapshots',
    'execution_estimates','cross_market_snapshots','data_quality_incidents',
    'deployment_verification_events','security_validation_events'
  ] loop
    execute format('alter table %I enable row level security', t);
    if not exists (
      select 1 from pg_policies where tablename = t and policyname = 'authenticated read'
    ) then
      execute format(
        'create policy "authenticated read" on %I for select to authenticated using (true)', t);
    end if;
  end loop;
end $$;

-- Rollback (manual):
--   drop table if exists security_validation_events, deployment_verification_events,
--     data_quality_incidents, cross_market_snapshots, execution_estimates,
--     quote_snapshots, market_regime_snapshots, paper_journal_entries,
--     backtest_trades, backtest_runs, strategy_events, strategies cascade;
--   alter table trade_proposals drop column if exists strategy_id,
--     drop column if exists counterargument, drop column if exists invalidation_condition,
--     drop column if exists intended_holding_days, drop column if exists regime_at_creation;
