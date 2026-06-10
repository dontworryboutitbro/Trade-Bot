import { z } from "zod";
import { adminRoute } from "@/lib/api";
import { setSymbolActive, validateAndAddSymbol } from "@/lib/trading/admin";

export const POST = adminRoute(
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("ADD"),
      symbol: z.string().min(1).max(10),
      displayName: z.string().max(120).optional(),
    }),
    z.object({
      action: z.literal("SET_ACTIVE"),
      symbol: z.string().min(1).max(10),
      active: z.boolean(),
    }),
  ]),
  async (body, user) => {
    if (body.action === "ADD") {
      return validateAndAddSymbol(user.email, body.symbol, body.displayName);
    }
    await setSymbolActive(user.email, body.symbol, body.active);
    return {};
  },
);
