import { z } from "zod";
import { adminRoute } from "@/lib/api";
import { closeAllPositions } from "@/lib/trading/admin";

export const POST = adminRoute(
  z.object({ confirmation: z.string().max(100) }),
  async (body, user) => {
    const closed = await closeAllPositions(user.email, body.confirmation);
    return { closed };
  },
);
