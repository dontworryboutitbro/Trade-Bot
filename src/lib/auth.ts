import "server-only";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface SessionUser {
  id: string;
  email: string;
  isDemo: boolean;
}

/**
 * Returns the authenticated admin, or null.
 * When Supabase is NOT configured the app runs entirely on mock data, so a
 * demo admin session is granted — nothing real can be reached in that state
 * (no brokerage keys, no AI key, no database). Once Supabase env vars exist,
 * real authentication is required everywhere.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (!isSupabaseConfigured()) {
    return { id: "demo-admin", email: "demo@local", isDemo: true };
  }
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return { id: user.id, email: user.email ?? "", isDemo: false };
}

/** Throws when unauthenticated. Use at the top of every admin server route. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}
