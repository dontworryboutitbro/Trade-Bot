-- Step 20 — dynamic asset universe + always-on scanner telemetry.
-- (Spec named this 0006, but 0006_live_pilot.sql already exists — numbered 0007.)
-- Same uniform generic shape as the learning tables: indexed key columns +
-- jsonb payload. Service-role writes (app + worker); authenticated read-only.
-- Retention: scanner telemetry can be pruned by created_at (no FKs depend on it).

do $$
declare t text;
begin
  foreach t in array array[
    'asset_universe','scanner_runs','scanner_candidates','asset_rejections',
    'execution_universe_changes','worker_heartbeats','worker_stream_health'
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
    execute format('alter table %I enable row level security', t);
    if not exists (
      select 1 from pg_policies where tablename = t and policyname = 'authenticated read'
    ) then
      execute format(
        'create policy "authenticated read" on %I for select to authenticated using (true)', t);
    end if;
  end loop;
end $$;

-- Suggested retention (run manually or via pg_cron later):
--   delete from worker_heartbeats where created_at < now() - interval '7 days';
--   delete from scanner_candidates where created_at < now() - interval '30 days';
-- Rollback:
--   drop table if exists asset_universe, scanner_runs, scanner_candidates,
--     asset_rejections, execution_universe_changes, worker_heartbeats,
--     worker_stream_health cascade;
