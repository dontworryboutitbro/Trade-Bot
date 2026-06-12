"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LearningRunButtons() {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const router = useRouter();

  async function run(job: "LEARN_DAILY" | "VALIDATE_WEEKLY") {
    setBusy(job);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job }),
      });
      const json = await res.json().catch(() => ({}));
      setIsError(!res.ok);
      setMessage(res.ok ? "Learning run complete." : (json.error ?? "Run failed"));
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <button
          disabled={busy !== null}
          onClick={() => run("LEARN_DAILY")}
          className="rounded border border-edge-strong px-3 py-1.5 text-xs font-medium text-muted hover:border-accent hover:text-foreground disabled:opacity-40"
        >
          {busy === "LEARN_DAILY" ? "Running…" : "Run daily learning now"}
        </button>
        <button
          disabled={busy !== null}
          onClick={() => run("VALIDATE_WEEKLY")}
          className="rounded border border-edge-strong px-3 py-1.5 text-xs font-medium text-muted hover:border-accent hover:text-foreground disabled:opacity-40"
        >
          {busy === "VALIDATE_WEEKLY" ? "Running…" : "Run weekly validation now"}
        </button>
        <span className="text-xs text-faint">
          Scheduled automatically: nightly 22:45 UTC weekdays, weekly Saturday 14:30 UTC.
        </span>
      </div>
      {message && (
        <p className={`mt-2 text-xs ${isError ? "text-critical" : "text-positive"}`}>{message}</p>
      )}
    </div>
  );
}
