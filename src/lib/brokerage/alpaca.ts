import "server-only";
// Alpaca REST adapter. Server-only: credentials never reach the browser or the AI.

import type {
  AccountSnapshot,
  AssetInfo,
  Bar,
  BrokerageOrder,
  MarketClock,
  OrderRequest,
  OrderStatus,
  Position,
  Quote,
} from "@/lib/types";
import type { BrokerageClient, MarketDataClient } from "./types";

interface AlpacaCredentials {
  key: string;
  secret: string;
  baseUrl: string;
  dataBaseUrl: string;
}

function mapStatus(alpacaStatus: string): OrderStatus {
  switch (alpacaStatus) {
    case "new":
    case "pending_new":
      return "SUBMITTED";
    case "accepted":
      return "ACCEPTED";
    case "partially_filled":
      return "PARTIALLY_FILLED";
    case "filled":
      return "FILLED";
    case "canceled":
    case "pending_cancel":
      return "CANCELED";
    case "rejected":
      return "REJECTED";
    case "expired":
      return "EXPIRED";
    default:
      return "UNKNOWN";
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapOrder(raw: any): BrokerageOrder {
  return {
    brokerageOrderId: raw.id,
    clientOrderId: raw.client_order_id,
    symbol: raw.symbol,
    side: raw.side,
    type: raw.type === "limit" ? "LIMIT" : "MARKET",
    quantity: Number(raw.qty ?? 0),
    filledQuantity: Number(raw.filled_qty ?? 0),
    filledAvgPrice: raw.filled_avg_price ? Number(raw.filled_avg_price) : null,
    limitPrice: raw.limit_price ? Number(raw.limit_price) : null,
    status: mapStatus(raw.status),
    submittedAt: raw.submitted_at ?? raw.created_at,
    updatedAt: raw.updated_at ?? raw.submitted_at ?? raw.created_at,
    raw,
  };
}

export class AlpacaBrokerageClient implements BrokerageClient {
  constructor(
    private readonly creds: AlpacaCredentials,
    public readonly label: string,
    public readonly readOnly: boolean,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}, base?: string): Promise<T> {
    const url = `${base ?? this.creds.baseUrl}${path}`;
    const response = await fetch(url, {
      ...init,
      headers: {
        "APCA-API-KEY-ID": this.creds.key,
        "APCA-API-SECRET-KEY": this.creds.secret,
        "Content-Type": "application/json",
        ...init.headers,
      },
      cache: "no-store",
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // Never echo credentials; body is Alpaca's error JSON.
      throw new Error(`Alpaca ${init.method ?? "GET"} ${path} failed (${response.status}): ${body.slice(0, 300)}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async getAccount(): Promise<AccountSnapshot> {
    const raw = await this.request<any>("/v2/account");
    return {
      equity: Number(raw.equity),
      cash: Number(raw.cash),
      buyingPower: Number(raw.buying_power),
      totalMarketValue: Number(raw.long_market_value ?? 0),
      currency: "USD",
      accountBlocked: Boolean(raw.account_blocked),
      tradingBlocked: Boolean(raw.trading_blocked),
      patternDayTrader: Boolean(raw.pattern_day_trader),
      asOf: new Date().toISOString(),
    };
  }

  async getPositions(): Promise<Position[]> {
    const raw = await this.request<any[]>("/v2/positions");
    return raw.map((p) => ({
      symbol: p.symbol,
      quantity: Number(p.qty),
      averageEntryPrice: Number(p.avg_entry_price),
      currentPrice: Number(p.current_price),
      marketValue: Number(p.market_value),
      unrealizedPl: Number(p.unrealized_pl),
      unrealizedPlPct: Number(p.unrealized_plpc) * 100,
    }));
  }

  async getOpenOrders(): Promise<BrokerageOrder[]> {
    const raw = await this.request<any[]>("/v2/orders?status=open&limit=100");
    return raw.map(mapOrder);
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerageOrder | null> {
    try {
      const raw = await this.request<any>(
        `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
      );
      return mapOrder(raw);
    } catch (error) {
      if (error instanceof Error && error.message.includes("(404)")) return null;
      throw error;
    }
  }

  async submitOrder(request: OrderRequest): Promise<BrokerageOrder> {
    if (this.readOnly) {
      throw new Error(`${this.label} is read-only (LIVE_LOCKED). Order submission is forbidden.`);
    }
    const body: Record<string, unknown> = {
      symbol: request.symbol,
      qty: String(request.quantity),
      side: request.side,
      type: request.type.toLowerCase(),
      time_in_force: request.timeInForce,
      client_order_id: request.clientOrderId,
    };
    if (request.type === "LIMIT") body.limit_price = String(request.limitPrice);
    const raw = await this.request<any>("/v2/orders", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return mapOrder(raw);
  }

  async cancelOrder(brokerageOrderId: string): Promise<void> {
    if (this.readOnly) throw new Error(`${this.label} is read-only.`);
    await this.request(`/v2/orders/${brokerageOrderId}`, { method: "DELETE" });
  }

  async cancelAllOrders(): Promise<number> {
    if (this.readOnly) throw new Error(`${this.label} is read-only.`);
    const result = await this.request<any[]>("/v2/orders", { method: "DELETE" });
    return Array.isArray(result) ? result.length : 0;
  }

  async closeAllPositions(): Promise<number> {
    if (this.readOnly) throw new Error(`${this.label} is read-only.`);
    const result = await this.request<any[]>("/v2/positions?cancel_orders=true", {
      method: "DELETE",
    });
    return Array.isArray(result) ? result.length : 0;
  }

  async getAsset(symbol: string): Promise<AssetInfo | null> {
    try {
      const raw = await this.request<any>(`/v2/assets/${encodeURIComponent(symbol)}`);
      return {
        symbol: raw.symbol,
        name: raw.name,
        tradable: Boolean(raw.tradable),
        assetClass: raw.class,
        exchange: raw.exchange,
        fractionable: Boolean(raw.fractionable),
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("(404)")) return null;
      throw error;
    }
  }

  async checkConnection(): Promise<{ ok: boolean; detail: string }> {
    try {
      const account = await this.request<any>("/v2/account");
      return {
        ok: true,
        detail: `Connected. Account status: ${account.status}. Currency: ${account.currency}.`,
      };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "Unknown error" };
    }
  }
}

export class AlpacaMarketDataClient implements MarketDataClient {
  readonly label = "Alpaca Market Data";

  constructor(private readonly creds: AlpacaCredentials) {}

  private async request<T>(path: string, base?: string): Promise<T> {
    const url = `${base ?? this.creds.dataBaseUrl}${path}`;
    const response = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": this.creds.key,
        "APCA-API-SECRET-KEY": this.creds.secret,
      },
      cache: "no-store",
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Alpaca data GET ${path} failed (${response.status}): ${body.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  async getQuote(symbol: string): Promise<Quote | null> {
    const quotes = await this.getQuotes([symbol]);
    return quotes[0] ?? null;
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];
    // Crypto pairs (e.g. BTC/USD) use a separate data endpoint.
    const stocks = symbols.filter((s) => !s.includes("/"));
    const crypto = symbols.filter((s) => s.includes("/"));
    const out: Quote[] = [];
    if (stocks.length > 0) {
      const raw = await this.request<any>(
        `/v2/stocks/trades/latest?symbols=${encodeURIComponent(stocks.join(","))}&feed=iex`,
      );
      for (const [symbol, trade] of Object.entries<any>(raw.trades ?? {})) {
        out.push({ symbol, price: Number(trade.p), asOf: trade.t });
      }
    }
    if (crypto.length > 0) {
      const raw = await this.request<any>(
        `/v1beta3/crypto/us/latest/trades?symbols=${encodeURIComponent(crypto.join(","))}`,
      );
      for (const [symbol, trade] of Object.entries<any>(raw.trades ?? {})) {
        out.push({ symbol, price: Number(trade.p), asOf: trade.t });
      }
    }
    return out;
  }

  async getDailyBars(symbol: string, days: number): Promise<Bar[]> {
    const start = new Date();
    start.setDate(start.getDate() - Math.ceil(days * 1.6));
    if (symbol.includes("/")) {
      const raw = await this.request<any>(
        `/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(symbol)}&timeframe=1Day&start=${start.toISOString()}&limit=${days + 10}`,
      );
      return (raw.bars?.[symbol] ?? []).map((b: any) => ({
        symbol,
        timestamp: b.t,
        open: Number(b.o),
        high: Number(b.h),
        low: Number(b.l),
        close: Number(b.c),
        volume: Number(b.v),
      }));
    }
    const raw = await this.request<any>(
      `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${start.toISOString()}&limit=${days + 10}&adjustment=split&feed=iex`,
    );
    return (raw.bars ?? []).map((b: any) => ({
      symbol,
      timestamp: b.t,
      open: Number(b.o),
      high: Number(b.h),
      low: Number(b.l),
      close: Number(b.c),
      volume: Number(b.v),
    }));
  }

  async getMarketClock(): Promise<MarketClock> {
    const raw = await this.request<any>("/v2/clock", this.creds.baseUrl);
    return {
      isOpen: Boolean(raw.is_open),
      nextOpen: raw.next_open,
      nextClose: raw.next_close,
      asOf: raw.timestamp,
    };
  }
}

export type { AlpacaCredentials };
