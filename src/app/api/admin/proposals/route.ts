import { z } from "zod";
import { adminRoute } from "@/lib/api";
import { decideProposal } from "@/lib/trading/admin";

export const POST = adminRoute(
  z.object({
    proposalId: z.string().min(1),
    decision: z.enum(["APPROVED", "REJECTED"]),
    reason: z.string().max(500).nullable().optional().default(null),
  }),
  async (body, user) => {
    const result = await decideProposal(user.email, body.proposalId, body.decision, body.reason);
    return result;
  },
);
