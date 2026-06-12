import { z } from "zod";
import { adminRoute } from "@/lib/api";
import { audit } from "@/lib/services";
import { runReadinessDrills } from "@/lib/pilot/drills";

export const maxDuration = 120;

export const POST = adminRoute(z.object({}), async (_body, user) => {
  const run = await runReadinessDrills();
  await audit({
    actorType: "USER",
    actorId: user.email,
    action: "READINESS_DRILLS_RUN",
    entityType: "learning_runs",
    entityId: run.ranAt,
    severity: run.allMandatoryPassed ? "INFO" : "WARNING",
    summary: `${user.email} ran live-readiness drills: ${run.results.filter((r) => r.status === "PASS").length}/${run.results.length} passed; mandatory ${run.allMandatoryPassed ? "ALL PASS" : "FAILING"}.`,
    metadata: {},
  });
  return { run };
});
