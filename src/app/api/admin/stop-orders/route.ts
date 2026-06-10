import { z } from "zod";
import { adminRoute } from "@/lib/api";
import { setStopNewOrders } from "@/lib/trading/admin";

export const POST = adminRoute(
  z.object({ stop: z.boolean() }),
  async (body, user) => {
    await setStopNewOrders(user.email, body.stop);
    return { stopNewOrders: body.stop };
  },
);
