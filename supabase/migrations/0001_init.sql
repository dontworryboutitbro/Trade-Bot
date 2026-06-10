-- Fable Fund Lab — initial schema
-- Run via Supabase CLI (supabase db push) or paste into the Supabase SQL Editor.

create extension if not exists "pgcrypto";

-- ===== enums =====
create type trading_mode as enum (
  'MOCK','PAPER_MANUAL','PAPER_AUTONOMOUS','LIVE_LOCKED','LIVE_MANUAL','LIVE_AUTONOMOUS'
);
create type environment as enum ('MOCK','PAPER','LIVE');
create type trade_action as enum ('BUY','SELL','REDUCE','EXIT','HOLD','NO_ACTION');
create type order_type as enum ('MARKET','LIMIT');
create type proposal_status as enum (
  'PENDING_RISK','BLOCKED','AWAITING_APPROVAL','APPROVED','REJECTED',
  'QUEUED','EXECUTING','EXECUTED','EXPIRED','FAILED'
);
create type severity as enum ('INFO','WARNING','CRITICAL');
create type actor_type as enum ('USER','SYSTEM','AI','CRON');

-- ===== profiles =====
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'ADMIN' check (role in ('ADMIN')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auto-create a profile when a user signs up. Single-owner app: every
-- authenticated user is the admin (signups must stay disabled in Supabase).
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ===== app settings (single row) =====
create table app_settings (
  id int primary key default 1 check (id = 1),
  trading_mode trading_mode not null default 'MOCK',
  global_kill_switch boolean not null default false,
  stop_new_orders boolean not null default false,
  maximum_live_funded_balance numeric not null default 1000,
  ai_evaluation_frequency text not null default 'DAILY'
    check (ai_evaluation_frequency in ('DAILY','TWICE_DAILY','WEEKLY','MANUAL_ONLY')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into app_settings (id) values (1);

-- ===== risk profiles =====
create table risk_profiles (
  id uuid primary key default gen_random_uuid(),
  environment environment not null,
  max_positions int not null,
  max_total_exposure_pct numeric not null,
  max_symbol_exposure_pct numeric not null,
  max_order_notional numeric not null,
  max_order_notional_is_pct boolean not null default false,
  max_trades_per_day int not null,
  max_daily_loss_pct numeric not null,
  max_drawdown_pct numeric not null,
  min_share_price numeric not null,
  max_live_funded_balance numeric,
  market_hours_only boolean not null default true,
  allow_margin boolean not null default false,
  allow_options boolean not null default false,
  allow_shorting boolean not null default false,
  allow_crypto boolean not null default false,
  allow_leveraged_etfs boolean not null default false,
  allow_inverse_etfs boolean not null default false,
  allow_otc boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index risk_profiles_one_active_per_env on risk_profiles (environment) where active;

insert into risk_profiles (
  environment, max_positions, max_total_exposure_pct, max_symbol_exposure_pct,
  max_order_notional, max_order_notional_is_pct, max_trades_per_day,
  max_daily_loss_pct, max_drawdown_pct, min_share_price, max_live_funded_balance
) values
  ('MOCK', 5, 60, 10, 10, true, 3, 2, 8, 10, null),
  ('PAPER', 5, 60, 10, 10, true, 3, 2, 8, 10, null),
  ('LIVE', 5, 60, 10, 100, false, 3, 2, 8, 10, 1000);

create table risk_profile_change_log (
  id uuid primary key default gen_random_uuid(),
  risk_profile_id uuid not null references risk_profiles(id),
  changed_by text not null,
  previous_values jsonb not null,
  updated_values jsonb not null,
  reason text,
  created_at timestamptz not null default now()
);

-- ===== approved symbols =====
create table approved_symbols (
  id uuid primary key default gen_random_uuid(),
  symbol text not null unique,
  display_name text not null,
  asset_class text not null default 'us_equity',
  tradable boolean not null default false,
  leveraged boolean not null default false,
  inverse boolean not null default false,
  otc boolean not null default false,
  validation_status text not null default 'PENDING'
    check (validation_status in ('PENDING','VALIDATED','REJECTED')),
  validation_details jsonb,
  activated_by text,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into approved_symbols (symbol, display_name, tradable, validation_status, active) values
  ('SPY','SPDR S&P 500 ETF Trust', true, 'VALIDATED', true),
  ('VOO','Vanguard S&P 500 ETF', true, 'VALIDATED', true),
  ('IVV','iShares Core S&P 500 ETF', true, 'VALIDATED', true),
  ('QQQ','Invesco QQQ Trust', true, 'VALIDATED', true),
  ('DIA','SPDR Dow Jones Industrial Average ETF', true, 'VALIDATED', true),
  ('IWM','iShares Russell 2000 ETF', true, 'VALIDATED', true),
  ('VTI','Vanguard Total Stock Market ETF', true, 'VALIDATED', true),
  ('SCHD','Schwab U.S. Dividend Equity ETF', true, 'VALIDATED', true),
  ('XLK','Technology Select Sector SPDR', true, 'VALIDATED', true),
  ('XLF','Financial Select Sector SPDR', true, 'VALIDATED', true),
  ('XLE','Energy Select Sector SPDR', true, 'VALIDATED', true),
  ('XLV','Health Care Select Sector SPDR', true, 'VALIDATED', true),
  ('XLI','Industrial Select Sector SPDR', true, 'VALIDATED', true),
  ('XLP','Consumer Staples Select Sector SPDR', true, 'VALIDATED', true),
  ('XLY','Consumer Discretionary Select Sector SPDR', true, 'VALIDATED', true),
  ('XLU','Utilities Select Sector SPDR', true, 'VALIDATED', true);

-- ===== portfolio snapshots =====
create table portfolio_snapshots (
  id uuid primary key default gen_random_uuid(),
  environment environment not null,
  captured_at timestamptz not null default now(),
  equity numeric not null,
  cash numeric not null,
  buying_power numeric not null,
  total_market_value numeric not null,
  daily_return_pct numeric not null default 0,
  total_return_pct numeric not null default 0,
  drawdown_pct numeric not null default 0,
  benchmark_value numeric,
  benchmark_return_pct numeric
);
create index portfolio_snapshots_env_time on portfolio_snapshots (environment, captured_at);

-- ===== positions (latest sync) =====
create table positions (
  id uuid primary key default gen_random_uuid(),
  environment environment not null,
  symbol text not null,
  quantity numeric not null,
  average_entry_price numeric not null,
  current_price numeric not null,
  market_value numeric not null,
  allocation_pct numeric not null default 0,
  unrealized_pl numeric not null default 0,
  unrealized_pl_pct numeric not null default 0,
  last_synced_at timestamptz not null default now(),
  raw_brokerage_payload jsonb,
  unique (environment, symbol)
);

-- ===== trade proposals =====
create table trade_proposals (
  id uuid primary key default gen_random_uuid(),
  environment environment not null,
  symbol text not null,
  action trade_action not null,
  quantity numeric not null,
  proposed_notional numeric not null,
  order_type order_type not null default 'MARKET',
  limit_price numeric,
  confidence numeric not null check (confidence >= 0 and confidence <= 100),
  concise_reasoning text not null check (char_length(concise_reasoning) <= 500),
  key_risk text not null check (char_length(key_risk) <= 250),
  expires_at timestamptz not null,
  status proposal_status not null default 'PENDING_RISK',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index trade_proposals_env_status on trade_proposals (environment, status);
create index trade_proposals_created on trade_proposals (created_at desc);

-- ===== risk evaluations =====
create table risk_evaluations (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references trade_proposals(id),
  evaluated_at timestamptz not null default now(),
  overall_result text not null check (overall_result in ('PASS','BLOCK')),
  account_snapshot jsonb,
  market_snapshot jsonb,
  risk_profile_snapshot jsonb,
  checks jsonb not null,
  block_reasons jsonb not null default '[]'
);
create index risk_evaluations_proposal on risk_evaluations (proposal_id);

-- ===== trade approvals =====
create table trade_approvals (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references trade_proposals(id),
  decision text not null check (decision in ('APPROVED','REJECTED')),
  decided_by text not null,
  reason text,
  decided_at timestamptz not null default now()
);

-- ===== brokerage orders =====
create table brokerage_orders (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid references trade_proposals(id),
  environment environment not null,
  client_order_id text not null unique, -- idempotency anchor
  brokerage_order_id text,
  symbol text not null,
  side text not null check (side in ('buy','sell')),
  order_type order_type not null,
  quantity numeric not null,
  notional numeric,
  limit_price numeric,
  status text not null default 'NEW',
  filled_quantity numeric not null default 0,
  filled_avg_price numeric,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  raw_brokerage_payload jsonb
);
create index brokerage_orders_env_status on brokerage_orders (environment, status);
create index brokerage_orders_submitted on brokerage_orders (submitted_at desc);

-- ===== executions =====
create table executions (
  id uuid primary key default gen_random_uuid(),
  brokerage_order_id uuid not null references brokerage_orders(id),
  execution_price numeric not null,
  execution_quantity numeric not null,
  executed_at timestamptz not null default now(),
  raw_brokerage_payload jsonb
);

-- ===== notifications =====
create table notifications (
  id uuid primary key default gen_random_uuid(),
  notification_type text not null,
  severity severity not null default 'INFO',
  title text not null,
  message text not null,
  delivery_status text not null default 'DELIVERED',
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_created on notifications (created_at desc);

-- ===== audit events (append-only) =====
create table audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_type actor_type not null,
  actor_id text,
  action text not null,
  entity_type text,
  entity_id text,
  severity severity not null default 'INFO',
  summary text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_created on audit_events (created_at desc);

-- ===== cron runs (idempotency) =====
create table cron_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  idempotency_key text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'RUNNING'
    check (status in ('RUNNING','COMPLETED','FAILED','SKIPPED_DUPLICATE')),
  details jsonb,
  unique (job_name, idempotency_key)
);

-- ===== system health checks =====
create table system_health_checks (
  id uuid primary key default gen_random_uuid(),
  check_name text not null,
  environment environment not null,
  status text not null check (status in ('OK','DEGRADED','FAILED')),
  details text not null default '',
  checked_at timestamptz not null default now()
);

-- ===== Row Level Security =====
-- Strategy: the browser uses the publishable (anon/authenticated) key and may
-- only READ dashboard data when authenticated. ALL writes go through
-- server-side routes using the service-role key, which bypasses RLS.
-- No INSERT/UPDATE/DELETE policies exist for regular users on any table.

alter table profiles enable row level security;
alter table app_settings enable row level security;
alter table risk_profiles enable row level security;
alter table risk_profile_change_log enable row level security;
alter table approved_symbols enable row level security;
alter table portfolio_snapshots enable row level security;
alter table positions enable row level security;
alter table trade_proposals enable row level security;
alter table risk_evaluations enable row level security;
alter table trade_approvals enable row level security;
alter table brokerage_orders enable row level security;
alter table executions enable row level security;
alter table notifications enable row level security;
alter table audit_events enable row level security;
alter table cron_runs enable row level security;
alter table system_health_checks enable row level security;

create policy "own profile read" on profiles for select using (auth.uid() = id);
create policy "own profile update name" on profiles for update using (auth.uid() = id);

create policy "authenticated read" on app_settings for select to authenticated using (true);
create policy "authenticated read" on risk_profiles for select to authenticated using (true);
create policy "authenticated read" on risk_profile_change_log for select to authenticated using (true);
create policy "authenticated read" on approved_symbols for select to authenticated using (true);
create policy "authenticated read" on portfolio_snapshots for select to authenticated using (true);
create policy "authenticated read" on positions for select to authenticated using (true);
create policy "authenticated read" on trade_proposals for select to authenticated using (true);
create policy "authenticated read" on risk_evaluations for select to authenticated using (true);
create policy "authenticated read" on trade_approvals for select to authenticated using (true);
create policy "authenticated read" on brokerage_orders for select to authenticated using (true);
create policy "authenticated read" on executions for select to authenticated using (true);
create policy "authenticated read" on notifications for select to authenticated using (true);
create policy "authenticated read" on audit_events for select to authenticated using (true);
create policy "authenticated read" on cron_runs for select to authenticated using (true);
create policy "authenticated read" on system_health_checks for select to authenticated using (true);
