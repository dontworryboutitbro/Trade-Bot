import "server-only";
// Alpaca WebSocket streaming for fresher quotes + trade updates.
//
// Honest constraint: Vercel serverless functions are request-scoped, so a
// persistent socket only lives in long-running processes (local dev server,
// the open Autopilot session, or a future worker). The architecture therefore
// treats streaming as an OPPORTUNISTIC freshness layer: when a live socket
// has a fresher quote we use it; otherwise REST snapshots remain authoritative
// and reconciliation remains the source of truth. When freshness cannot be
// verified at all, autonomous/live entries are blocked by the fail-closed
// data_quality check — never silently allowed.

import { getEnv } from "@/lib/env";
import type { TradingMode } from "@/lib/types";

export interface StreamHealth {
  status: "CONNECTED" | "CONNECTING" | "DISCONNECTED" | "DEGRADED" | "UNSUPPORTED_RUNTIME";
  reconnectAttempts: number;
  lastMessageAt: string | null;
  lastError: string | null;
  subscribedSymbols: string[];
  usingFallback: boolean;
}

interface StreamState {
  socket: WebSocket | null;
  health: StreamHealth;
  quotes: Map<string, { bid: number; ask: number; at: number }>;
  tradeUpdates: { at: number; event: string; orderId: string }[];
}

declare global {
  var __fableStream: StreamState | undefined;
}

function state(): StreamState {
  if (!globalThis.__fableStream) {
    globalThis.__fableStream = {
      socket: null,
      health: {
        status: "DISCONNECTED",
        reconnectAttempts: 0,
        lastMessageAt: null,
        lastError: null,
        subscribedSymbols: [],
        usingFallback: true,
      },
      quotes: new Map(),
      tradeUpdates: [],
    };
  }
  return globalThis.__fableStream;
}

const STALE_STREAM_MS = 30_000;
const MAX_RECONNECTS = 5;

export function getStreamHealth(): StreamHealth {
  const s = state();
  const last = s.health.lastMessageAt ? new Date(s.health.lastMessageAt).getTime() : 0;
  if (s.health.status === "CONNECTED" && Date.now() - last > STALE_STREAM_MS) {
    return { ...s.health, status: "DEGRADED", usingFallback: true };
  }
  return { ...s.health };
}

/** Fresh streamed quote if available and younger than 10s; otherwise null (use REST). */
export function getStreamQuote(symbol: string): { bid: number; ask: number; ageMs: number } | null {
  const entry = state().quotes.get(symbol);
  if (!entry) return null;
  const ageMs = Date.now() - entry.at;
  if (ageMs > 10_000) return null;
  return { bid: entry.bid, ask: entry.ask, ageMs };
}

/**
 * Connect (or reuse) the market-data stream for the given symbols. Safe to call
 * repeatedly; no-ops on unsupported runtimes or missing credentials.
 */
export function ensureMarketStream(mode: TradingMode, symbols: string[]): StreamHealth {
  const s = state();
  if (mode === "MOCK") {
    s.health = { ...s.health, status: "UNSUPPORTED_RUNTIME", usingFallback: true, lastError: "Mock mode has no stream." };
    return getStreamHealth();
  }
  if (typeof WebSocket === "undefined") {
    s.health = { ...s.health, status: "UNSUPPORTED_RUNTIME", usingFallback: true, lastError: "No WebSocket in this runtime." };
    return getStreamHealth();
  }
  const env = getEnv();
  const paper = mode === "PAPER_MANUAL" || mode === "PAPER_AUTONOMOUS";
  const key = paper ? env.ALPACA_PAPER_API_KEY : env.ALPACA_LIVE_API_KEY;
  const secret = paper ? env.ALPACA_PAPER_API_SECRET : env.ALPACA_LIVE_API_SECRET;
  if (!key || !secret) {
    s.health = { ...s.health, status: "DISCONNECTED", usingFallback: true, lastError: "Credentials missing." };
    return getStreamHealth();
  }
  const stocks = symbols.filter((x) => !x.includes("/")).slice(0, 30);
  const sameSubs =
    s.socket &&
    s.health.status === "CONNECTED" &&
    stocks.every((x) => s.health.subscribedSymbols.includes(x));
  if (sameSubs) return getStreamHealth();
  if (s.health.reconnectAttempts >= MAX_RECONNECTS) return getStreamHealth();

  try {
    s.socket?.close();
  } catch {
    // old socket may already be dead
  }
  s.health.status = "CONNECTING";
  const socket = new WebSocket("wss://stream.data.alpaca.markets/v2/iex");
  s.socket = socket;

  socket.onopen = () => {
    socket.send(JSON.stringify({ action: "auth", key, secret }));
  };
  socket.onmessage = (event) => {
    const st = state();
    st.health.lastMessageAt = new Date().toISOString();
    try {
      const messages = JSON.parse(String(event.data));
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        if (message.T === "success" && message.msg === "authenticated") {
          st.health.status = "CONNECTED";
          st.health.usingFallback = false;
          st.health.reconnectAttempts = 0;
          st.health.subscribedSymbols = stocks;
          socket.send(JSON.stringify({ action: "subscribe", quotes: stocks }));
        } else if (message.T === "q" && message.S) {
          st.quotes.set(message.S, {
            bid: Number(message.bp),
            ask: Number(message.ap),
            at: Date.now(),
          });
        } else if (message.T === "error") {
          st.health.lastError = String(message.msg ?? "stream error");
        }
      }
    } catch {
      // non-JSON frames ignored
    }
  };
  socket.onclose = () => {
    const st = state();
    st.health.status = "DISCONNECTED";
    st.health.usingFallback = true;
    st.health.reconnectAttempts += 1;
  };
  socket.onerror = () => {
    const st = state();
    st.health.status = "DEGRADED";
    st.health.usingFallback = true;
    st.health.lastError = "WebSocket error";
  };
  return getStreamHealth();
}

/** Classify stream health for gating decisions. Pure. */
export function streamFreshnessVerifiable(health: StreamHealth, restSnapshotOk: boolean): boolean {
  // REST snapshot remains sufficient on its own; the stream only adds margin.
  if (restSnapshotOk) return true;
  return health.status === "CONNECTED" && !health.usingFallback;
}
