import "server-only";
// Universe refresh orchestrator. Discovery covers the full Alpaca asset list
// (metadata classification). Quote/bar-based research+execution eligibility is
// evaluated over a bounded working pool — the always-on worker extends scanning
// breadth; this server path guarantees a safe baseline every 6 hours.
// Eligible assets are synced into approved_symbols (audited); symbols holding
// open positions are never deactivated (exits must stay possible).

import { getEnv } from "@/lib/env";
import { getBrokerageClient, getMarketDataClient } from "@/lib/brokerage/factory";
import { getQuoteSnapshot } from "@/lib/market-data/snapshots";
import { audit } from "@/lib/services";
import { getStore } from "@/lib/store";
import type { Bar, TradingMode } from "@/lib/types";
import {
  classifyCrypto,
  classifyEquity,
  serverDenylist,
  type CryptoEvidence,
  type EquityEvidence,
} from "./filters";
import { rankCandidates, scoreCandidate } from "./ranking";
import type { CandidateScore, UniverseAsset } from "./types";
import { MAX_AI_CANDIDATES } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Bounded liquid-equity scan pool for the serverless baseline. */
export const EQUITY_SCAN_POOL = [
  "SPY","QQQ","IWM","DIA","VTI","VOO","IVV","SCHD",
  "XLK","XLF","XLE","XLV","XLI","XLP","XLY","XLU","XLB","XLRE","XLC",
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","BRK.B","JPM",
  "V","UNH","XOM","JNJ","PG","HD","COST","ABBV","WMT","NFLX",
  "AMD","CRM","ORCL","BAC","KO","PEP","MRK","DIS","CSCO","ADBE",
  "SMH","GLD","SLV","TLT","HYG","EEM","EFA","ARKK",
];

async function fetchAlpacaAssets(mode: TradingMode): Promise<UniverseAsset[]> {
  const env = getEnv();
  const paper = mode === "PAPER_MANUAL" || mode === "PAPER_AUTONOMOUS" || mode === "MOCK";
  const key = paper ? env.ALPACA_PAPER_API_KEY : env.ALPACA_LIVE_API_KEY;
  const secret = paper ? env.ALPACA_PAPER_API_SECRET : env.ALPACA_LIVE_API_SECRET;
  if (!key || !secret) return [];
  const base = paper ? env.ALPACA_PAPER_BASE_URL : env.ALPACA_LIVE_BASE_URL;
  const headers = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
  const now = new Date().toISOString();
  const out: UniverseAsset[] = [];
  for (const cls of ["us_equity", "crypto"] as const) {
    const res = await fetch(`${base}/v2/assets?status=active&asset_class=${cls}`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) continue;
    const assets = (await res.json()) as any[];
    for (const a of assets) {
      out.push({
        symbol: a.symbol,
        name: a.name ?? a.symbol,
        assetClass: cls,
        exchange: a.exchange ?? "",
        active: a.status === "active",
        tradable: Boolean(a.tradable),
        fractionable: Boolean(a.fractionable),
        shortable: Boolean(a.shortable),
        marginable: Boolean(a.marginable),
        firstSeenAt: now,
        refreshedAt: now,
        source: "alpaca_assets_api",
      });
    }
  }
  return out;
}

/** Mock discovery so the scanner works with zero credentials. */
function mockAssets(): UniverseAsset[] {
  const now = new Date().toISOString();
  const make = (symbol: string, cls: "us_equity" | "crypto"): UniverseAsset => ({
    symbol,
    name: `${symbol} (mock)`,
    assetClass: cls,
    exchange: cls === "crypto" ? "CRYPTO" : "ARCA",
    active: true,
    tradable: true,
    fractionable: true,
    shortable: false,
    marginable: false,
    firstSeenAt: now,
    refreshedAt: now,
    source: "alpaca_assets_api",
  });
  return [
    ...["SPY","VOO","IVV","QQQ","DIA","IWM","VTI","SCHD","XLK","XLF","XLE","XLV","XLI","XLP","XLY","XLU"].map((s) => make(s, "us_equity")),
    ...["BTC/USD","ETH/USD","LTC/USD"].map((s) => make(s, "crypto")),
  ];
}

export interface UniverseRefreshResult {
  discovered: { equities: number; crypto: number };
  researchEligible: number;
  paperExecutionEligible: number;
  rejected: number;
  activated: string[];
  deactivated: string[];
  candidates: CandidateScore[];
}

export async function refreshUniverse(trigger: string): Promise<UniverseRefreshResult> {
  const store = await getStore();
  const settings = await store.getSettings();
  const mode = settings.tradingMode;
  const now = new Date();
  const marketData = getMarketDataClient(mode);
  const denylist = serverDenylist();

  // 1. Discovery (full metadata sweep).
  const allAssets = mode === "MOCK" ? mockAssets() : await fetchAlpacaAssets(mode);
  const equities = allAssets.filter((a) => a.assetClass === "us_equity");
  const cryptos = allAssets.filter((a) => a.assetClass === "crypto" && /\/USD$/.test(a.symbol));

  // 2. Working pool for quote/bar evaluation (bounded).
  const approved = await store.getApprovedSymbols();
  // Alpaca reports crypto positions without the slash ("BTCUSD") — normalize
  // both sides so held-position protection covers crypto pairs.
  const normalize = (s: string) => s.replace("/", "").toUpperCase();
  const held = new Set(
    (await getBrokerageClient(mode).getPositions().catch(() => [])).map((p) =>
      normalize(p.symbol),
    ),
  );
  const poolSymbols = Array.from(
    new Set([
      ...EQUITY_SCAN_POOL,
      ...approved.filter((s) => s.assetClass !== "crypto").map((s) => s.symbol),
    ]),
  ).filter((s) => equities.some((a) => a.symbol === s));
  const cryptoPool = cryptos.slice(0, 40);

  // Crypto account eligibility (from the trading account).
  let cryptoEligible: boolean | null = null;
  try {
    const account = await getBrokerageClient(mode).getAccount();
    cryptoEligible = mode === "MOCK" ? true : account ? true : null;
  } catch {
    cryptoEligible = null;
  }
  const allowCrypto = (await store.getRiskLimits(mode === "MOCK" ? "MOCK" : "PAPER")).allowCrypto;

  const marketClock = await marketData.getMarketClock().catch(() => null);
  const spyBars = await marketData.getDailyBars("SPY", 90).catch(() => [] as Bar[]);

  const results: { symbol: string; layer: string; reasons: string[] }[] = [];
  const scores: CandidateScore[] = [];

  const evaluate = async (asset: UniverseAsset) => {
    const snapshot = await getQuoteSnapshot(mode, asset.symbol, marketClock?.isOpen ?? null).catch(
      () => null,
    );
    const bars = await marketData.getDailyBars(asset.symbol, 90).catch(() => [] as Bar[]);
    const eligibility =
      asset.assetClass === "crypto"
        ? classifyCrypto(
            {
              asset,
              snapshot,
              bars,
              accountCryptoEligible: allowCrypto ? cryptoEligible : false,
              unresolvedDataQualityIncident: false,
            } satisfies CryptoEvidence,
            undefined,
            denylist,
          )
        : classifyEquity(
            { asset, snapshot, bars, unresolvedDataQualityIncident: false } satisfies EquityEvidence,
            undefined,
            denylist,
          );
    results.push({ symbol: asset.symbol, layer: eligibility.layer, reasons: eligibility.reasons });
    if (snapshot && bars.length >= 20) {
      scores.push(
        scoreCandidate({
          symbol: asset.symbol,
          assetClass: asset.assetClass,
          snapshot,
          bars,
          spyBars,
          eligibleLayer: eligibility.layer as never,
          now,
        }),
      );
    }
  };

  // Evaluate sequentially in small batches to respect rate limits.
  const pool = [
    ...poolSymbols.map((s) => equities.find((a) => a.symbol === s)!).filter(Boolean),
    ...cryptoPool,
  ];
  for (let i = 0; i < pool.length; i += 8) {
    await Promise.all(pool.slice(i, i + 8).map(evaluate));
  }

  // 3. Sync approved_symbols with execution eligibility.
  const activated: string[] = [];
  const deactivated: string[] = [];
  for (const r of results) {
    const entry = approved.find((s) => s.symbol === r.symbol);
    const asset = pool.find((a) => a.symbol === r.symbol)!;
    const eligible = r.layer === "PAPER_EXECUTION_UNIVERSE";
    if (eligible && (!entry || !entry.active)) {
      await store.upsertApprovedSymbol({
        symbol: r.symbol,
        displayName: asset.name,
        assetClass: asset.assetClass,
        tradable: true,
        leveraged: false,
        inverse: false,
        otc: false,
        active: true,
        validationDetails: { source: "universe-refresh", trigger, at: now.toISOString() },
      });
      activated.push(r.symbol);
    } else if (!eligible && entry?.active && !held.has(normalize(r.symbol))) {
      await store.setSymbolActive(r.symbol, false);
      deactivated.push(r.symbol);
    }
    if (r.layer === "REJECTED" || r.reasons.length > 0) {
      await store
        .putLearningRecord(
          "asset_rejections",
          { symbol: r.symbol, layer: r.layer },
          { reasons: r.reasons, at: now.toISOString() },
        )
        .catch(() => undefined);
    }
  }

  // 4. Persist candidates + run summary.
  const ranked = rankCandidates(scores, MAX_AI_CANDIDATES * 3);
  await store
    .putLearningRecord(
      "scanner_candidates",
      { date: now.toISOString().slice(0, 10) },
      { ranked, scoredCount: scores.length, rankedAt: now.toISOString() },
    )
    .catch(() => undefined);

  const summary: UniverseRefreshResult = {
    discovered: { equities: equities.length, crypto: cryptos.length },
    researchEligible: results.filter((r) =>
      ["RESEARCH_UNIVERSE", "PAPER_EXECUTION_UNIVERSE"].includes(r.layer),
    ).length,
    paperExecutionEligible: results.filter((r) => r.layer === "PAPER_EXECUTION_UNIVERSE").length,
    rejected: results.filter((r) => r.layer === "REJECTED").length,
    activated,
    deactivated,
    candidates: ranked.slice(0, MAX_AI_CANDIDATES),
  };
  await store
    .putLearningRecord(
      "scanner_runs",
      { trigger, date: now.toISOString().slice(0, 10) },
      { ...summary, candidates: undefined, evaluatedPool: pool.length, at: now.toISOString() },
    )
    .catch(() => undefined);

  if (activated.length > 0 || deactivated.length > 0) {
    await store
      .putLearningRecord(
        "execution_universe_changes",
        { trigger },
        { activated, deactivated, at: now.toISOString() },
      )
      .catch(() => undefined);
    await audit({
      actorType: "SYSTEM",
      actorId: `universe-refresh:${trigger}`,
      action: "EXECUTION_UNIVERSE_CHANGED",
      entityType: "approved_symbols",
      entityId: null,
      severity: "INFO",
      summary: `Universe refresh: +${activated.length} activated (${activated.slice(0, 8).join(", ")}${activated.length > 8 ? "…" : ""}), -${deactivated.length} deactivated. Discovery: ${equities.length} equities / ${cryptos.length} crypto pairs.`,
      metadata: { activated, deactivated },
    });
  }
  return summary;
}

/** Latest ranked candidates for the AI evaluation (hard-capped). */
export async function getTopCandidates(): Promise<CandidateScore[]> {
  try {
    const store = await getStore();
    const rows = await store.listLearningRecords("scanner_candidates", { limit: 1 });
    const ranked = ((rows[0]?.payload as any)?.ranked ?? []) as CandidateScore[];
    return ranked.slice(0, MAX_AI_CANDIDATES);
  } catch {
    return [];
  }
}
