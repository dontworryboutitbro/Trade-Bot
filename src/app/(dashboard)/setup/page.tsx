import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { getSettingsData } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

function Step({
  done,
  title,
  children,
}: {
  done: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 border-b border-edge/50 py-3 last:border-0">
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${
          done ? "border-positive bg-positive/15 text-positive" : "border-edge-strong text-faint"
        }`}
      >
        {done ? "✓" : "○"}
      </span>
      <div className="min-w-0">
        <p className={`text-sm font-medium ${done ? "text-muted line-through" : ""}`}>{title}</p>
        {!done && <div className="mt-1 text-xs text-muted">{children}</div>}
      </div>
    </div>
  );
}

export default async function SetupPage() {
  const { config, settings, symbols } = await getSettingsData();
  const supabaseReady = config.supabase && config.supabaseServiceRole;
  const mockVerified = symbols.length > 0; // store reachable + seeded
  const paperReady = supabaseReady && config.anthropic && config.alpacaPaper && config.cronSecret;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Setup</h1>
        <p className="mt-1 text-sm text-muted">
          The app runs fully in mock mode with no credentials. Work down this list to reach paper
          trading; live trading stays locked until you deliberately enable it much later.
        </p>
      </div>

      <Card title="1 · Mock mode" action={<Badge tone={mockVerified ? "green" : "muted"}>{mockVerified ? "Working" : "Check"}</Badge>}>
        <Step done={mockVerified} title="Mock dashboard is working">
          The Overview page should show a simulated ~$10,000 portfolio.
        </Step>
        <Step done={settings.tradingMode === "MOCK" || paperReady} title="Explore in MOCK mode first">
          Try the AI evaluation (Settings → Automation → Run AI evaluation), approve a mock trade,
          and test the kill switch before adding any real credentials.
        </Step>
      </Card>

      <Card title="2 · Supabase (database + login)" action={<Badge tone={supabaseReady ? "green" : "amber"}>{supabaseReady ? "Configured" : "Required"}</Badge>}>
        <Step done={config.supabase} title="Create a Supabase project and add its URL + publishable key">
          supabase.com → New project → Project Settings → API Keys. Put{" "}
          <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>{" "}
          in <code>.env.local</code>.
        </Step>
        <Step done={config.supabaseServiceRole} title="Add the service-role key (server only)">
          Same page → <code>SUPABASE_SERVICE_ROLE_KEY</code>. Never expose this to the browser.
        </Step>
        <Step done={false} title="Run the SQL migration & create your admin login">
          Paste <code>supabase/migrations/0001_init.sql</code> into the Supabase SQL Editor and run
          it. Then Authentication → Users → Add user (your email + password), and disable public
          signups under Authentication → Sign In / Up.
        </Step>
      </Card>

      <Card title="3 · Anthropic (AI decisions)" action={<Badge tone={config.anthropic ? "green" : "amber"}>{config.anthropic ? "Configured" : "Required"}</Badge>}>
        <Step done={config.anthropic} title="Create an API key and add it locally">
          console.anthropic.com → API Keys → Create key. Put it in <code>ANTHROPIC_API_KEY</code> in{" "}
          <code>.env.local</code>. The model is <code>claude-fable-5</code>.
        </Step>
      </Card>

      <Card title="4 · Alpaca paper trading" action={<Badge tone={config.alpacaPaper ? "green" : "amber"}>{config.alpacaPaper ? "Configured" : "Required"}</Badge>}>
        <Step done={config.alpacaPaper} title="Create an Alpaca account and paper API keys">
          alpaca.markets → sign up → dashboard → switch to Paper Trading (top-left) → generate API
          keys. Put them in <code>ALPACA_PAPER_API_KEY</code> / <code>ALPACA_PAPER_API_SECRET</code>.
        </Step>
      </Card>

      <Card title="5 · Automation & alerts">
        <Step done={config.cronSecret} title="Set CRON_SECRET">
          Generate with <code>openssl rand -hex 32</code>; used by Vercel Cron to authenticate.
        </Step>
        <Step done={config.resend} title="Optional: Resend email alerts">
          resend.com → API key → set <code>RESEND_API_KEY</code>, <code>ALERT_EMAIL_TO</code>,{" "}
          <code>ALERT_EMAIL_FROM</code>. In-app alerts work without this.
        </Step>
      </Card>

      <Card title="Paper readiness checklist" action={<Badge tone={paperReady ? "green" : "muted"}>{paperReady ? "Ready" : "Not yet"}</Badge>}>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>All steps 2–5 above complete and the app restarted.</li>
          <li>Sign in with your Supabase admin user.</li>
          <li>Settings → Diagnostics all green.</li>
          <li>Settings → Run Health check — brokerage shows connected.</li>
          <li>Switch mode to PAPER_MANUAL and run an AI evaluation.</li>
          <li>Approve one paper trade and verify it on the Alpaca paper dashboard.</li>
          <li>Only after several good sessions, consider PAPER_AUTONOMOUS.</li>
        </ol>
      </Card>

      <Card title="Future live-readiness checklist" action={<Badge tone="red">Locked</Badge>}>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>Weeks of satisfactory paper trading, reviewed on the Performance page.</li>
          <li>Open a separate, isolated Alpaca live account funded with ≤ $1,000.</li>
          <li>Add live keys to the environment (never earlier).</li>
          <li>Switch to LIVE_LOCKED — read-only — and verify balances.</li>
          <li>Complete the activation ceremony (connectivity check, kill-switch test, acknowledgments, typed phrase).</li>
        </ol>
        <p className="mt-2 text-xs text-faint">
          The activation flow lives in <Link href="/settings" className="text-accent underline">Settings → Trading mode</Link>. It cannot be triggered accidentally.
        </p>
      </Card>
    </div>
  );
}
