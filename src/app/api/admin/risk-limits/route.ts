import { z } from "zod";
import { adminRoute } from "@/lib/api";
import { updateRiskLimits } from "@/lib/trading/admin";
import { getStore } from "@/lib/store";

const limitsSchema = z.object({
  environment: z.enum(["MOCK", "PAPER", "LIVE"]),
  maxPositions: z.number().int().min(1).max(50),
  maxTotalExposurePct: z.number().min(1).max(100),
  maxSymbolExposurePct: z.number().min(1).max(100),
  maxOrderNotional: z.number().min(1),
  maxTradesPerDay: z.number().int().min(0).max(20),
  maxDailyLossPct: z.number().min(0.1).max(50),
  maxDrawdownPct: z.number().min(0.5).max(80),
  minSharePrice: z.number().min(0),
  maxLiveFundedBalance: z.number().min(0).nullable(),
  marketHoursOnly: z.boolean(),
  allowCrypto: z.boolean().optional(),
  confirmation: z.string().max(100).nullable().optional().default(null),
  reason: z.string().min(1).max(500),
});

export const POST = adminRoute(limitsSchema, async (body, user) => {
  const store = await getStore();
  const current = await store.getRiskLimits(body.environment);
  await updateRiskLimits(
    user.email,
    body.environment,
    {
      ...current, // prohibition flags + notional unit come from the stored profile, never the client
      maxPositions: body.maxPositions,
      maxTotalExposurePct: body.maxTotalExposurePct,
      maxSymbolExposurePct: body.maxSymbolExposurePct,
      maxOrderNotional: body.maxOrderNotional,
      maxTradesPerDay: body.maxTradesPerDay,
      maxDailyLossPct: body.maxDailyLossPct,
      maxDrawdownPct: body.maxDrawdownPct,
      minSharePrice: body.minSharePrice,
      maxLiveFundedBalance: body.maxLiveFundedBalance,
      marketHoursOnly: body.marketHoursOnly,
      allowCrypto: body.allowCrypto ?? current.allowCrypto,
    },
    body.confirmation,
    body.reason,
  );
  return {};
});
