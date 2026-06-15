// Fable Fund Lab — always-on scanner worker.
//
// Runs OUTSIDE Vercel (Railway / Fly / Render / any Node host). Provides what
// request-scoped serverless functions cannot: persistent Alpaca WebSocket
// subscriptions (stock + crypto quotes), a 60-second heartbeat, continuous
// freshness tracking with REST fallback, and a scanning cadence that triggers
// the dashboard's authenticated cron endpoints.
//
// SAFETY: this worker holds NO order-placement code. It observes markets and
// writes telemetry. All execution flows through the dashboard's risk engine;
// the worker cannot bypass modes, limits, or the kill switch — it never calls
// any order endpoint.
//
// Required env vars (server-side only — never exposed to a browser):
//   APP_URL                      e.g. https://fable-fund-lab.vercel.app
//   CRON_SECRET                  same value as the dashboard
//   NEXT_PUBLIC_SUPABASE_URL     Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY    service-role key (telemetry writes)
//   ALPACA_PAPER_API_KEY / ALPACA_PAPER_API_SECRET
// Optional:
//   WORKER_EQUITY_SYMBOLS        comma list (default: liquid ETF set)
//   WORKER_CRYPTO_SYMBOLS        comma list (default: BTC/USD,ETH/USD,SOL/USD)
//   PORT                         health endpoint port (default 8080)

import http from "node:http";

const APP_URL = process.env.APP_URL ?? "";
const CRON_SECRET = process.env.CRON_SECRET ?? "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ALPACA_KEY = process.env.ALPACA_PAPER_API_KEY ?? "";
const ALPACA_SECRET = process.env.ALPACA_PAPER_API_SECRET ?? "";

const EQUITY_SYMBOLS = (process.env.WORKER_EQUITY_SYMBOLS ?? "SPY,QQQ,IWM,DIA,VTI,XLK,XLF,XLE,XLV,AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA")
  .split(",").map((s) => s.trim()).filter(Boolean);
const CRYPTO_SYMBOLS = (process.env.WORKER_CRYPTO_SYMBOLS ?? "BTC/USD,ETH/USD,SOL/USD,XRP/USD,DOGE/USD,LTC/USD")
  .split(",").map((s) => s.trim()).filter(Boolean);

interface StreamState {
  status: "CONNECTED" | "CONNECTING" | "DISCONNECTED" | "DEGRADED";
  reconnects: number;
  lastMessageAt: number;
  lastQuoteAt: Map<string, number>;
  fallbackActive: boolean;
}

const equity: StreamState = { status: "DISCONNECTED", reconnects: 0, lastMessageAt: 0, lastQuoteAt: new Map(), fallbackActive: false };
const crypto: StreamState = { status: "DISCONNECTED", reconnects: 0, lastMessageAt: 0, lastQuoteAt: new Map(), fallbackActive: false };
const startedAt = Date.now();
let lastUniverseTrigger = 0;
let lastScanTrigger = 0;
let fatal: string | null = null;

function log(message: string): void {
  console.log(`[worker ${new Date().toISOString()}] ${message}`);
}

/* ===== Supabase telemetry (generic key/payload tables) ===== */
async function writeRecord(table: string, keys: Record<string, string>, payload: unknown): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_KEY) return;
  const row: Record<string, unknown> = { payload };
  Object.entries(keys).slice(0, 4).forEach(([k, v], i) => {
    row[`k${i + 1}_name`] = k;
    row[`k${i + 1}`] = v;
  });
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  }).catch((error) => log(`telemetry write failed: ${error?.message ?? error}`));
}

/* ===== WebSocket streams (observation only) ===== */
function connectStream(
  url: string,
  subscribe: Record<string, unknown>,
  state: StreamState,
  label: string,
): void {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    state.status = "DEGRADED";
    state.fallbackActive = true;
    log(`${label}: no credentials; REST fallback only`);
    return;
  }
  state.status = "CONNECTING";
  const socket = new WebSocket(url);
  socket.onopen = () => socket.send(JSON.stringify({ action: "auth", key: ALPACA_KEY, secret: ALPACA_SECRET }));
  socket.onmessage = (event) => {
    state.lastMessageAt = Date.now();
    try {
      const messages = JSON.parse(String(event.data));
      for (const m of Array.isArray(messages) ? messages : [messages]) {
        if (m.T === "success" && m.msg === "authenticated") {
          state.status = "CONNECTED";
          state.fallbackActive = false;
          socket.send(JSON.stringify({ action: "subscribe", ...subscribe }));
          log(`${label}: connected + subscribed`);
        } else if (m.T === "q" && m.S) {
          state.lastQuoteAt.set(m.S, Date.now());
        } else if (m.T === "error") {
          log(`${label}: stream error ${m.msg}`);
        }
      }
    } catch {
      /* ignore non-JSON frames */
    }
  };
  const reconnect = () => {
    state.status = "DISCONNECTED";
    state.fallbackActive = true;
    state.reconnects += 1;
    const delay = Math.min(60_000, 2_000 * state.reconnects);
    log(`${label}: disconnected; reconnect #${state.reconnects} in ${delay / 1000}s (REST fallback active)`);
    void writeRecord("worker_stream_health", { stream: label, event: "DISCONNECT" }, { reconnects: state.reconnects });
    setTimeout(() => connectStream(url, subscribe, state, label), delay);
  };
  socket.onclose = reconnect;
  socket.onerror = () => socket.close();
}

/* ===== REST fallback freshness probe ===== */
async function restFallbackProbe(): Promise<void> {
  if (!ALPACA_KEY || !ALPACA_SECRET) return;
  const headers = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };
  if (equity.status !== "CONNECTED") {
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/trades/latest?symbols=SPY&feed=iex`,
      { headers },
    ).catch(() => null);
    if (res?.ok) equity.lastQuoteAt.set("SPY", Date.now());
  }
  if (crypto.status !== "CONNECTED") {
    const res = await fetch(
      `https://data.alpaca.markets/v1beta3/crypto/us/latest/trades?symbols=BTC%2FUSD`,
      { headers },
    ).catch(() => null);
    if (res?.ok) crypto.lastQuoteAt.set("BTC/USD", Date.now());
  }
}

/* ===== Scanning cadence: trigger the dashboard's authenticated pipelines ===== */
async function triggerCron(path: string): Promise<void> {
  if (!APP_URL || !CRON_SECRET) return;
  const res = await fetch(`${APP_URL}${path}`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  }).catch(() => null);
  log(`${path} → ${res?.status ?? "unreachable"}`);
}

/* ===== Heartbeat ===== */
function newestQuoteAgeMs(state: StreamState): number | null {
  const newest = Math.max(0, ...state.lastQuoteAt.values());
  return newest === 0 ? null : Date.now() - newest;
}

async function heartbeat(): Promise<void> {
  const payload = {
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    equity: {
      status: equity.status,
      reconnects: equity.reconnects,
      fallbackActive: equity.fallbackActive,
      symbolsTracked: equity.lastQuoteAt.size,
      newestQuoteAgeMs: newestQuoteAgeMs(equity),
    },
    crypto: {
      status: crypto.status,
      reconnects: crypto.reconnects,
      fallbackActive: crypto.fallbackActive,
      symbolsTracked: crypto.lastQuoteAt.size,
      newestQuoteAgeMs: newestQuoteAgeMs(crypto),
    },
    lastUniverseTrigger: lastUniverseTrigger ? new Date(lastUniverseTrigger).toISOString() : null,
    lastScanTrigger: lastScanTrigger ? new Date(lastScanTrigger).toISOString() : null,
    fatal,
  };
  await writeRecord("worker_heartbeats", { worker: "scanner", status: fatal ? "FATAL" : "OK" }, payload);
}

/* ===== Health endpoint ===== */
http
  .createServer((_req, res) => {
    res.writeHead(fatal ? 500 : 200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: !fatal,
        equity: equity.status,
        crypto: crypto.status,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      }),
    );
  })
  .listen(Number(process.env.PORT ?? 8080), () => log(`health endpoint on :${process.env.PORT ?? 8080}`));

/* ===== Main ===== */
async function main(): Promise<void> {
  log(`starting — ${EQUITY_SYMBOLS.length} equities, ${CRYPTO_SYMBOLS.length} crypto pairs`);
  connectStream("wss://stream.data.alpaca.markets/v2/iex", { quotes: EQUITY_SYMBOLS }, equity, "equity-stream");
  connectStream("wss://stream.data.alpaca.markets/v1beta3/crypto/us", { quotes: CRYPTO_SYMBOLS }, crypto, "crypto-stream");

  // Universe refresh: on startup, then every 6 hours.
  await triggerCron("/api/cron/universe");
  lastUniverseTrigger = Date.now();
  setInterval(() => {
    void triggerCron("/api/cron/universe");
    lastUniverseTrigger = Date.now();
  }, 6 * 3600_000);

  // Reconcile/scan cadence: every 5 minutes (well below HFT; ranking only).
  setInterval(() => {
    void triggerCron("/api/cron/reconcile");
    lastScanTrigger = Date.now();
  }, 5 * 60_000);

  // Daily post-close tasks. Vercel's cron plan is unreliable for sub-daily jobs,
  // so the worker is the dependable scheduler. After 21:00 UTC (post US close)
  // each weekday, trigger snapshot → health → learn-daily ONCE. Every endpoint
  // is idempotent per day, so this is safe even if Vercel also fires them.
  let lastDailyTasksDate = "";
  setInterval(() => {
    void (async () => {
      const now = new Date();
      const utcDate = now.toISOString().slice(0, 10);
      const utcDay = now.getUTCDay(); // 0 Sun … 6 Sat
      const weekday = utcDay >= 1 && utcDay <= 5;
      if (!weekday || now.getUTCHours() < 21 || lastDailyTasksDate === utcDate) return;
      lastDailyTasksDate = utcDate;
      log("running daily post-close tasks (snapshot → health → learn-daily)");
      await triggerCron("/api/cron/snapshot");
      await triggerCron("/api/cron/health");
      await triggerCron("/api/cron/learn-daily");
    })();
  }, 5 * 60_000);

  // Intraday AI evaluations during US market hours (13:30–20:00 UTC, Mon–Fri),
  // every 30 minutes — so the bot trades and accumulates learning samples even
  // when no dashboard tab is open. Spend stays bounded by the daily AI-call
  // budget + actionable preflight + per-day trade caps inside the pipeline.
  setInterval(() => {
    void (async () => {
      const now = new Date();
      const day = now.getUTCDay();
      const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
      const marketHours = day >= 1 && day <= 5 && minutes >= 13 * 60 + 30 && minutes <= 20 * 60;
      if (marketHours) await triggerCron("/api/cron/evaluate");
    })();
  }, 30 * 60_000);

  // REST fallback probe every 30s when a stream is down.
  setInterval(() => void restFallbackProbe(), 30_000);

  // Heartbeat every 60s.
  setInterval(() => void heartbeat(), 60_000);
  await heartbeat();
}

process.on("uncaughtException", (error) => {
  fatal = error.message.slice(0, 200);
  log(`FATAL: ${fatal}`);
  void heartbeat();
});

void main();
