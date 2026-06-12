# Fable Fund Lab — Always-On Scanner Worker

A standalone Node service providing persistent Alpaca WebSocket streams,
60-second heartbeats, REST fallback, and continuous scanning cadence — things
request-scoped Vercel functions cannot do. **It contains no order-placement
code**: it observes markets, writes telemetry to Supabase, and triggers the
dashboard's authenticated cron endpoints. All execution remains behind the
dashboard's risk engine, modes, and kill switch.

## Run locally

```bash
cd worker
APP_URL=https://fable-fund-lab.vercel.app \
CRON_SECRET=... \
NEXT_PUBLIC_SUPABASE_URL=... \
SUPABASE_SERVICE_ROLE_KEY=... \
ALPACA_PAPER_API_KEY=... \
ALPACA_PAPER_API_SECRET=... \
npm start
# health: http://localhost:8080
```

## Deploy (Railway — recommended)

1. railway.app → New Project → **Deploy from GitHub repo** → select this repo.
2. Settings → Root Directory: `worker` · Start command: `npm start`.
3. Variables: add the six env vars above (copy values from Vercel env / .env.local).
   Never expose these anywhere browser-accessible.
4. Deploy. Settings → Networking → Generate Domain → that URL is the worker
   health endpoint (`{"ok":true,...}`).
5. Verify: Supabase `worker_heartbeats` gains a row per minute; the dashboard
   `/scanner` page shows the heartbeat.

Fly.io / Render work identically (Node ≥22, start `npm start`, port from `$PORT`).

## Verification checklist

- Health URL returns `ok: true` with both stream states.
- `worker_heartbeats` rows appear every 60s (status OK).
- Kill the network briefly → `worker_stream_health` records DISCONNECT,
  reconnects increment, REST fallback flips on, then recovery.
- Secrets: the worker never serves any value — health output is booleans/enums.

## Rollback / stop

Delete the Railway service (or scale to 0). The dashboard continues to function
on its 6-hour serverless universe cron — the worker only adds freshness.
