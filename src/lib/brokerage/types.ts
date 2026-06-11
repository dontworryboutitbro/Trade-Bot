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

/**
 * The only path to a brokerage. The AI never receives one of these —
 * it only ever sees read-only summaries assembled by server code.
 */
export interface BrokerageClient {
  readonly label: string;
  /** True only for the locked live adapter: balances/positions visible, orders forbidden. */
  readonly readOnly: boolean;
  getAccount(): Promise<AccountSnapshot>;
  getPositions(): Promise<Position[]>;
  getOpenOrders(): Promise<BrokerageOrder[]>;
  getOrderByClientId(clientOrderId: string): Promise<BrokerageOrder | null>;
  submitOrder(request: OrderRequest): Promise<BrokerageOrder>;
  cancelOrder(brokerageOrderId: string): Promise<void>;
  cancelAllOrders(): Promise<number>;
  closeAllPositions(): Promise<number>;
  getAsset(symbol: string): Promise<AssetInfo | null>;
  checkConnection(): Promise<{ ok: boolean; detail: string }>;
}

export interface MarketDataClient {
  readonly label: string;
  getQuote(symbol: string): Promise<Quote | null>;
  getQuotes(symbols: string[]): Promise<Quote[]>;
  getDailyBars(symbol: string, days: number): Promise<Bar[]>;
  getHourlyBars(symbol: string, hours: number): Promise<Bar[]>;
  getMarketClock(): Promise<MarketClock>;
}
