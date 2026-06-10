"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const supabaseConfigured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
        return;
      }
      router.push("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-edge bg-surface p-6">
        <h1 className="text-lg font-semibold">Fable Fund Lab</h1>
        <p className="mt-1 text-sm text-muted">Private dashboard — administrator sign in.</p>
        {!supabaseConfigured ? (
          <p className="mt-4 rounded-md border border-edge bg-raised p-3 text-sm text-muted">
            Supabase is not configured, so the app is running in open mock mode.{" "}
            <Link href="/" className="text-accent underline">
              Open the dashboard
            </Link>
            .
          </p>
        ) : (
          <form onSubmit={signIn} className="mt-5 space-y-3">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              className="w-full rounded border border-edge-strong bg-raised px-3 py-2 text-sm"
            />
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full rounded border border-edge-strong bg-raised px-3 py-2 text-sm"
            />
            {error && <p className="text-xs text-critical">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded bg-accent/90 px-3 py-2 text-sm font-bold text-background hover:bg-accent disabled:opacity-50"
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <p className="text-xs text-faint">
              The admin user is created in the Supabase dashboard (Authentication → Users). Public
              signup stays disabled.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
