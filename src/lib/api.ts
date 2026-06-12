import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin, UnauthorizedError, type SessionUser } from "@/lib/auth";
import { assertSecureBoot, SecurityBootError } from "@/lib/env-guard";

/** Wrapper for admin POST routes: auth + Zod body validation + uniform errors. */
export function adminRoute<S extends z.ZodTypeAny>(
  schema: S,
  handler: (body: z.infer<S>, user: SessionUser, request: NextRequest) => Promise<unknown>,
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    try {
      assertSecureBoot();
      const user = await requireAdmin();
      const json = await request.json().catch(() => ({}));
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        return NextResponse.json(
          { error: `Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}` },
          { status: 400 },
        );
      }
      const result = await handler(parsed.data, user, request);
      return NextResponse.json({ ok: true, ...(result as object) });
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (error instanceof SecurityBootError) {
        return NextResponse.json(
          { error: "Security validation failed; protected routes are disabled. Check Settings → Diagnostics." },
          { status: 503 },
        );
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  };
}
