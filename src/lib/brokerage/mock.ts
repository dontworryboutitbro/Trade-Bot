// Fully isolated mock brokerage + market data. Makes ZERO network requests.
// State lives in-process (persisted on globalThis to survive dev HMR) so the
// entire dashboard works with no credentials configured.

import type {
  AccountSnapshot,
  AssetInfo,
  Bar,
  BrokerageOrder,
  MarketClock,
  OrderRequest,
  Position,
  Quote,
} from "@/lib/types";
import type { BrokerageClient, MarketDataClient } from "./types";

interface MockPosition {
  symbol: string;
  quantity: number;
  averageEntryPrice: number;
}

interface MockState {
  cash: number;
  positions: MockPosition[];
  orders: BrokerageOrder[];
  prices: Record<string, number>;
  priceSeedDay: string;
}

const BASE_PRICES: Record<string, number> = {
  SPY: 612.4,
  VOO: 562.1,
  IVV: 614.8,
  QQQ: 532.7,
  DIA: 442.3,
  IWM: 228.9,
  VTI: 302.5,
  SCHD: 28.4,
  XLK: 245.6,
  XLF: 51.2,
  XLE: 92.8,
  XLV: 152.3,
  XLI: 142.7,
  XLP: 82.1,
  XLY: 218.4,
  XLU: 80.6,
  "BTC/USD": 101250.0,
  "ETH/USD": 3865.0,
  "LTC/USD": 118.4,
};

function freshState(): MockState {
  return {
    cash: 7093.4,
    positions: [
      { symbol: "SPY", quantity: 1, averageEntryPrice: 596.2 },
      { symbol: "QQQ", quantity: 1, averageEntryPrice: 518.4 },
      { symbol: "SCHD", quantity: 28, averageEntryPrice: 27.9 },
      { symbol: "XLV", quantity: 6, averageEntryPrice: 149.8 },
    ],
    orders: [],
    prices: { ...BASE_PRICES },
    priceSeedDay: "",
  };
}

declare global {
  var __fableMockState: MockState | undefined;
}

function getState(): MockState {
  if (!globalThis.__fableMockState) {
    globalThis.__fableMockState = freshState();
  }
  return globalThis.__fableMockState;
}

export function resetMockState(): void {
  globalThis.__fableMockState = freshState();
}

// Deterministic pseudo-random walk seeded by day+symbol so mock prices move
// realistically between sessions but stay stable within a request.
function seededDrift(symbol: string, daySeed: string): number {
  let hash = 0;
  const input = `${symbol}:${daySeed}`;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return (((hash % 1000) / 1000) * 2 - 1) * 0.01; // ±1%
}

function refreshPrices(state: MockState): void {
  const day = new Date().toISOString().slice(0, 10);
  if (state.priceSeedDay === day) return;
  state.priceSeedDay = day;
  for (const symbol of Object.keys(BASE_PRICES)) {
    state.prices[symbol] = BASE_PRICES[symbol] * (1 + seededDrift(symbol, day));
  }
}

function priceOf(symbol: string): number {
  const state = getState();
  refreshPrices(state);
  return state.prices[symbol] ?? 0;
}

function computePositions(): Position[] {
  return getState().positions.map((p) => {
    const currentPrice = priceOf(p.symbol);
    const marketValue = currentPrice * p.quantity;
    const cost = p.averageEntryPrice * p.quantity;
    return {
      symbol: p.symbol,
      quantity: p.quantity,
      averageEntryPrice: p.averageEntryPrice,
      currentPrice,
      marketValue,
      unrealizedPl: marketValue - cost,
      unrealizedPlPct: cost > 0 ? ((marketValue - cost) / cost) * 100 : 0,
    };
  });
}

let orderCounter = 0;

export class MockBrokerageClient implements BrokerageClient {
  readonly label = "Mock Brokerage";
  readonly readOnly = false;

  async getAccount(): Promise<AccountSnapshot> {
    const state = getState();
    const positions = computePositions();
    const totalMarketValue = positions.reduce((sum, p) => sum + p.marketValue, 0);
    return {
      equity: state.cash + totalMarketValue,
      cash: state.cash,
      buyingPower: state.cash,
      totalMarketValue,
      currency: "USD",
      accountBlocked: false,
      tradingBlocked: false,
      patternDayTrader: false, // analytics only — legacy PDT deprecated by Alpaca
      dayTradeCount: 0,
      maintenanceMargin: 0,
      asOf: new Date().toISOString(),
    };
  }

  async getPositions(): Promise<Position[]> {
    return computePositions();
  }

  async getOpenOrders(): Promise<BrokerageOrder[]> {
    return getState().orders.filter((o) =>
      ["NEW", "SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED"].includes(o.status),
    );
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerageOrder | null> {
    return getState().orders.find((o) => o.clientOrderId === clientOrderId) ?? null;
  }

  async submitOrder(request: OrderRequest): Promise<BrokerageOrder> {
    const state = getState();
    const existing = state.orders.find((o) => o.clientOrderId === request.clientOrderId);
    if (existing) return existing; // idempotent, like Alpaca

    const price = priceOf(request.symbol);
    if (price <= 0) throw new Error(`Mock: unknown symbol ${request.symbol}`);
    const now = new Date().toISOString();
    orderCounter += 1;

    // Mock fills market orders instantly at the current mock price.
    const fillPrice = request.type === "LIMIT" && request.limitPrice ? request.limitPrice : price;
    const notional = fillPrice * request.quantity;

    if (request.side === "buy") {
      if (notional > state.cash) throw new Error("Mock: insufficient cash");
      state.cash -= notional;
      const pos = state.positions.find((p) => p.symbol === request.symbol);
      if (pos) {
        const totalCost = pos.averageEntryPrice * pos.quantity + notional;
        pos.quantity += request.quantity;
        pos.averageEntryPrice = totalCost / pos.quantity;
      } else {
        state.positions.push({
          symbol: request.symbol,
          quantity: request.quantity,
          averageEntryPrice: fillPrice,
        });
      }
    } else {
      const pos = state.positions.find((p) => p.symbol === request.symbol);
      if (!pos || pos.quantity < request.quantity) {
        throw new Error("Mock: cannot sell more than held");
      }
      pos.quantity -= request.quantity;
      state.cash += notional;
      if (pos.quantity === 0) {
        state.positions = state.positions.filter((p) => p.symbol !== request.symbol);
      }
    }

    const order: BrokerageOrder = {
      brokerageOrderId: `mock-${orderCounter}-${request.clientOrderId.slice(0, 8)}`,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      quantity: request.quantity,
      filledQuantity: request.quantity,
      filledAvgPrice: fillPrice,
      limitPrice: request.limitPrice ?? null,
      status: "FILLED",
      submittedAt: now,
      updatedAt: now,
      raw: { mock: true },
    };
    state.orders.push(order);
    return order;
  }

  async cancelOrder(brokerageOrderId: string): Promise<void> {
    const order = getState().orders.find((o) => o.brokerageOrderId === brokerageOrderId);
    if (order && order.status !== "FILLED") {
      order.status = "CANCELED";
      order.updatedAt = new Date().toISOString();
    }
  }

  async cancelAllOrders(): Promise<number> {
    const open = await this.getOpenOrders();
    for (const order of open) await this.cancelOrder(order.brokerageOrderId);
    return open.length;
  }

  async closeAllPositions(): Promise<number> {
    const state = getState();
    const count = state.positions.length;
    for (const pos of [...state.positions]) {
      state.cash += priceOf(pos.symbol) * pos.quantity;
    }
    state.positions = [];
    return count;
  }

  async getAsset(symbol: string): Promise<AssetInfo | null> {
    if (!(symbol in BASE_PRICES)) return null;
    const crypto = symbol.includes("/");
    return {
      symbol,
      name: `${symbol} (mock)`,
      tradable: true,
      assetClass: crypto ? "crypto" : "us_equity",
      exchange: crypto ? "CRYPTO" : "ARCA",
      fractionable: true,
    };
  }

  async checkConnection(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "Mock brokerage is always available." };
  }
}

export class MockMarketDataClient implements MarketDataClient {
  readonly label = "Mock Market Data";

  async getQuote(symbol: string): Promise<Quote | null> {
    const price = priceOf(symbol);
    if (price <= 0) return null;
    return { symbol, price, asOf: new Date().toISOString() };
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    const quotes = await Promise.all(symbols.map((s) => this.getQuote(s)));
    return quotes.filter((q): q is Quote => q !== null);
  }

  async getDailyBars(symbol: string, days: number): Promise<Bar[]> {
    const base = BASE_PRICES[symbol];
    if (!base) return [];
    const bars: Bar[] = [];
    let price = base * 0.92;
    for (let i = days; i >= 1; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      if (date.getDay() === 0 || date.getDay() === 6) continue;
      const drift = seededDrift(symbol, date.toISOString().slice(0, 10));
      const open = price;
      price = price * (1 + drift + 0.0007); // gentle upward bias
      bars.push({
        symbol,
        timestamp: date.toISOString(),
        open,
        high: Math.max(open, price) * 1.004,
        low: Math.min(open, price) * 0.996,
        close: price,
        volume: 40_000_000 + Math.abs(Math.round(drift * 1e9)),
      });
    }
    return bars;
  }

  async getHourlyBars(symbol: string, hours: number): Promise<Bar[]> {
    const base = BASE_PRICES[symbol];
    if (!base) return [];
    const bars: Bar[] = [];
    let price = base * 0.99;
    for (let i = hours; i >= 1; i--) {
      const date = new Date(Date.now() - i * 3600_000);
      const drift = seededDrift(symbol, `${date.toISOString().slice(0, 13)}h`);
      const open = price;
      price = price * (1 + drift * 0.3);
      bars.push({
        symbol,
        timestamp: date.toISOString(),
        open,
        high: Math.max(open, price) * 1.002,
        low: Math.min(open, price) * 0.998,
        close: price,
        volume: 1_000_000,
      });
    }
    return bars;
  }

  async getMarketClock(): Promise<MarketClock> {
    // Approximate US regular hours: 9:30–16:00 ET, Mon–Fri.
    const now = new Date();
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const day = et.getDay();
    const minutes = et.getHours() * 60 + et.getMinutes();
    const isWeekday = day >= 1 && day <= 5;
    const isOpen = isWeekday && minutes >= 9 * 60 + 30 && minutes < 16 * 60;
    const nextOpen = new Date(now.getTime() + 16 * 60 * 60 * 1000);
    const nextClose = new Date(now.getTime() + 4 * 60 * 60 * 1000);
    return {
      isOpen,
      nextOpen: nextOpen.toISOString(),
      nextClose: nextClose.toISOString(),
      asOf: now.toISOString(),
    };
  }
}
