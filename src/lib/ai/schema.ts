import { z } from "zod";

// Strict schema for AI output. Anything that doesn't parse is rejected and
// logged — AI output is untrusted input, never partially salvaged.

export const aiActionSchema = z
  .object({
    symbol: z
      .string()
      .min(1)
      .max(11)
      .toUpperCase()
      .regex(/^[A-Z]{1,6}(\/[A-Z]{3,4})?$/, "equity ticker or crypto pair like BTC/USD"),
    action: z.enum(["BUY", "SELL", "REDUCE", "EXIT", "HOLD", "NO_ACTION"]),
    quantity: z.number().min(0).finite(),
    proposed_notional: z.number().min(0).finite(),
    order_type: z.enum(["MARKET", "LIMIT"]),
    limit_price: z.number().positive().finite().nullable(),
    confidence: z.number().min(0).max(100),
    concise_reasoning: z.string().min(1).max(500),
    key_risk: z.string().min(1).max(250),
    expiration_timestamp: z.string().datetime({ offset: true }).or(z.string().datetime()),
  })
  .strict();

export const aiDecisionSchema = z
  .object({
    evaluated_at: z.string(),
    actions: z.array(aiActionSchema).max(10),
  })
  .strict();

export type AiAction = z.infer<typeof aiActionSchema>;
export type AiDecision = z.infer<typeof aiDecisionSchema>;
