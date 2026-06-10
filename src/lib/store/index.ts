import "server-only";
import { isSupabaseConfigured } from "@/lib/env";
import { MemoryStore } from "./memory";
import type { Store } from "./types";

let supabaseStore: Store | null = null;
const memoryStore = new MemoryStore();

/**
 * Returns the Supabase-backed store when configured, otherwise the in-memory
 * mock store so the app is fully usable with zero credentials.
 */
export async function getStore(): Promise<Store> {
  if (isSupabaseConfigured()) {
    if (!supabaseStore) {
      const { SupabaseStore } = await import("./supabase");
      supabaseStore = new SupabaseStore();
    }
    return supabaseStore;
  }
  return memoryStore;
}
