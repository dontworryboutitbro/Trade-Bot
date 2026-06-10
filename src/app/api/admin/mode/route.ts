import { z } from "zod";
import { adminRoute } from "@/lib/api";
import { changeTradingMode } from "@/lib/trading/admin";
import { ALL_MODES } from "@/lib/trading/modes";

const modeEnum = z.enum(ALL_MODES as [string, ...string[]]);

export const POST = adminRoute(
  z.object({
    from: modeEnum,
    to: modeEnum,
    confirmationPhrase: z.string().max(100).optional(),
    acknowledgmentsComplete: z.boolean().optional(),
    killSwitchTested: z.boolean().optional(),
    liveConnectivityVerified: z.boolean().optional(),
    autonomousAcknowledged: z.boolean().optional(),
  }),
  async (body, user) => {
    await changeTradingMode(user.email, {
      from: body.from as never,
      to: body.to as never,
      confirmationPhrase: body.confirmationPhrase,
      acknowledgmentsComplete: body.acknowledgmentsComplete,
      killSwitchTested: body.killSwitchTested,
      liveConnectivityVerified: body.liveConnectivityVerified,
      autonomousAcknowledged: body.autonomousAcknowledged,
    });
    return { mode: body.to };
  },
);
