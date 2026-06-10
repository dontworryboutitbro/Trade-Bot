import { z } from "zod";
import { adminRoute } from "@/lib/api";
import { cancelOpenOrders } from "@/lib/trading/admin";

export const POST = adminRoute(z.object({}), async (_body, user) => {
  const canceled = await cancelOpenOrders(user.email);
  return { canceled };
});
