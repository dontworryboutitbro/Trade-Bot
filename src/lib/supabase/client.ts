"use client";

import { createBrowserClient } from "@supabase/ssr";

// Browser client — publishable key only, RLS enforced. Never receives secrets.
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
