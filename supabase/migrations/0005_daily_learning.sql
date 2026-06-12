-- Daily adaptive learning engine — idempotent migration. Preserves all data.
-- Learning tables share a uniform shape: up to 4 indexed key columns + a jsonb
-- payload. Writes happen only through the service role; the browser reads only.
-- Idempotency for the learning crons reuses the existing cron_runs unique
-- (job_name, idempotency_key) constraint — no separate key tables required.

do $$
declare t text;
begin
  foreach t in array array[
    'learning_runs','feature_observations','outcome_labels',
    'confidence_calibration_buckets','strategy_versions','shadow_proposals',
    'shadow_trade_results','promotion_reviews','rollback_events','stream_health_events'
  ] loop
    execute format($f$
      create table if not exists %I (
        id uuid primary key default gen_random_uuid(),
        k1_name text, k1 text,
        k2_name text, k2 text,
        k3_name text, k3 text,
        k4_name text, k4 text,
        payload jsonb not null default '{}',
        created_at timestamptz not null default now()
      )$f$, t);
    execute format('create index if not exists %I on %I (k1, created_at desc)', t || '_k1_idx', t);
    execute format('create index if not exists %I on %I (k2)', t || '_k2_idx', t);
    execute format('alter table %I enable row level security', t);
    if not exists (
      select 1 from pg_policies where tablename = t and policyname = 'authenticated read'
    ) then
      execute format(
        'create policy "authenticated read" on %I for select to authenticated using (true)', t);
    end if;
  end loop;
end $$;

-- Immutability guard: strategy_versions rows may change status keys/payload via
-- the service role, but version identity columns are protected by trigger.
create or replace function protect_strategy_version_identity()
returns trigger language plpgsql as $$
begin
  if old.k1 is distinct from new.k1 then -- k1 = version_id
    raise exception 'strategy version identity (version_id) is immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists strategy_versions_immutable on strategy_versions;
create trigger strategy_versions_immutable
  before update on strategy_versions
  for each row execute function protect_strategy_version_identity();

-- Rollback (manual):
--   drop table if exists learning_runs, feature_observations, outcome_labels,
--     confidence_calibration_buckets, strategy_versions, shadow_proposals,
--     shadow_trade_results, promotion_reviews, rollback_events,
--     stream_health_events cascade;
--   drop function if exists protect_strategy_version_identity();
