import "server-only";
// The single place that maps trading mode → brokerage/data clients.
// Guarantees: paper credentials only in paper modes, live credentials only in
// live modes, mock never touches the network, LIVE_LOCKED is read-only.

import type { TradingMode } from "@/lib/types";
import { getEnv, requireEnv } from "@/lib/env";
import { AlpacaBrokerageClient, AlpacaMarketDataClient } from "./alpaca";
import { MockBrokerageClient, MockMarketDataClient } from "./mock";
import type { BrokerageClient, MarketDataClient } from "./types";

function paperCredentials() {
  const env = getEnv();
  return {
    key: requireEnv("ALPACA_PAPER_API_KEY", "paper trading"),
    secret: requireEnv("ALPACA_PAPER_API_SECRET", "paper trading"),
    baseUrl: env.ALPACA_PAPER_BASE_URL,
    dataBaseUrl: env.ALPACA_DATA_BASE_URL,
  };
}

function liveCredentials() {
  const env = getEnv();
  return {
    key: requireEnv("ALPACA_LIVE_API_KEY", "live trading"),
    secret: requireEnv("ALPACA_LIVE_API_SECRET", "live trading"),
    baseUrl: env.ALPACA_LIVE_BASE_URL,
    dataBaseUrl: env.ALPACA_DATA_BASE_URL,
  };
}

export class AlpacaPaperBrokerageClient extends AlpacaBrokerageClient {
  constructor() {
    super(paperCredentials(), "Alpaca Paper", false);
  }
}

export class AlpacaLiveBrokerageClient extends AlpacaBrokerageClient {
  constructor(readOnly: boolean) {
    super(liveCredentials(), readOnly ? "Alpaca Live (locked)" : "Alpaca Live", readOnly);
  }
}

export function getBrokerageClient(mode: TradingMode): BrokerageClient {
  switch (mode) {
    case "MOCK":
      return new MockBrokerageClient();
    case "PAPER_MANUAL":
    case "PAPER_AUTONOMOUS":
      return new AlpacaPaperBrokerageClient();
    case "LIVE_LOCKED":
      return new AlpacaLiveBrokerageClient(true);
    case "LIVE_MANUAL":
    case "LIVE_AUTONOMOUS":
      return new AlpacaLiveBrokerageClient(false);
  }
}

export function getMarketDataClient(mode: TradingMode): MarketDataClient {
  if (mode === "MOCK") return new MockMarketDataClient();
  // Market data uses paper credentials for paper modes and live for live modes.
  if (mode === "PAPER_MANUAL" || mode === "PAPER_AUTONOMOUS") {
    return new AlpacaMarketDataClient(paperCredentials());
  }
  return new AlpacaMarketDataClient(liveCredentials());
}
