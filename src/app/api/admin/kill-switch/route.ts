import { z } from "zod";
import { adminRoute } from "@/lib/api";
import { engageKillSwitch, resetKillSwitch } from "@/lib/trading/admin";

export const POST = adminRoute(
  z.object({
    action: z.enum(["ENGAGE", "RESET"]),
    reason: z.string().max(500).optional().default(""),
    acknowledgment: z.string().max(100).optional().default(""),
  }),
  async (body, user) => {
    if (body.action === "ENGAGE") {
      await engageKillSwitch(user.email, body.reason);
      return { killSwitch: true };
    }
    await resetKillSwitch(user.email, body.acknowledgment);
    return { killSwitch: false };
  },
);
