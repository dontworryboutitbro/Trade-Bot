// App-wide constants. No secrets.

export const APP_NAME = "Fable Fund Lab";

export const SEED_SYMBOLS: { symbol: string; displayName: string }[] = [
  { symbol: "SPY", displayName: "SPDR S&P 500 ETF Trust" },
  { symbol: "VOO", displayName: "Vanguard S&P 500 ETF" },
  { symbol: "IVV", displayName: "iShares Core S&P 500 ETF" },
  { symbol: "QQQ", displayName: "Invesco QQQ Trust" },
  { symbol: "DIA", displayName: "SPDR Dow Jones Industrial Average ETF" },
  { symbol: "IWM", displayName: "iShares Russell 2000 ETF" },
  { symbol: "VTI", displayName: "Vanguard Total Stock Market ETF" },
  { symbol: "SCHD", displayName: "Schwab U.S. Dividend Equity ETF" },
  { symbol: "XLK", displayName: "Technology Select Sector SPDR" },
  { symbol: "XLF", displayName: "Financial Select Sector SPDR" },
  { symbol: "XLE", displayName: "Energy Select Sector SPDR" },
  { symbol: "XLV", displayName: "Health Care Select Sector SPDR" },
  { symbol: "XLI", displayName: "Industrial Select Sector SPDR" },
  { symbol: "XLP", displayName: "Consumer Staples Select Sector SPDR" },
  { symbol: "XLY", displayName: "Consumer Discretionary Select Sector SPDR" },
  { symbol: "XLU", displayName: "Utilities Select Sector SPDR" },
];

export const BENCHMARK_SYMBOL = "SPY";

export const LIVE_MANUAL_CONFIRMATION_PHRASE = "ENABLE LIVE MANUAL TRADING";
export const LIVE_AUTONOMOUS_CONFIRMATION_PHRASE = "ENABLE LIVE AUTONOMOUS TRADING";

/** Proposals expire this many minutes after creation unless the AI sets an earlier expiry. */
export const PROPOSAL_TTL_MINUTES = 240;
