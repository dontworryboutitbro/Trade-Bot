-- Stop-loss support: the AI may attach a stop_loss_pct to BUY proposals; after
-- the buy fills, a stop rule is created and monitored server-side. When the
-- price breaches the stop, the app creates and executes an EXIT through the
-- full risk engine.

alter table trade_proposals
  add column if not exists stop_loss_pct numeric check (stop_loss_pct is null or (stop_loss_pct >= 0.2 and stop_loss_pct <= 50));

create table if not exists position_stops (
  id uuid primary key default gen_random_uuid(),
  environment environment not null,
  symbol text not null,
  quantity numeric not null,
  entry_price numeric not null,
  stop_price numeric not null,
  source_proposal_id uuid references trade_proposals(id),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','TRIGGERED','CANCELED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists position_stops_active on position_stops (environment, status);

alter table position_stops enable row level security;
create policy "authenticated read" on position_stops for select to authenticated using (true);
