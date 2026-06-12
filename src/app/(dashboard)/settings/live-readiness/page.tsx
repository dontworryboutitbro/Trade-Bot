import { Badge, Card, Stat } from "@/components/ui";
import { DrillRunner, PilotStageControl } from "@/components/live-readiness-client";
import { getStore } from "@/lib/store";
import { getBrokerageClient } from "@/lib/brokerage/factory";
import { getLatestDrillRun, drillsValidForActivation } from "@/lib/pilot/drills";
import { getPilotConfig, stageCapitalUsd } from "@/lib/pilot/config";
import { fmtDateTime, fmtUsd } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function LiveReadinessPage() {
  const store = await getStore();
  const settings = await store.getSettings();
  const config = getPilotConfig();
  const stage = settings.pilotCapitalStage ?? "CANARY_100";
  const enabledCapital = stageCapitalUsd(stage, config);
  const latestRun = await getLatestDrillRun();
  const drillStatus = drillsValidForActivation(latestRun);

  let paperEquity: number | null = null;
  try {
    paperEquity = (await getBrokerageClient(settings.tradingMode).getAccount()).equity;
  } catch {
    paperEquity = null;
  }
  const capitalMismatch =
    paperEquity !== null &&
    settings.tradingMode.startsWith("PAPER") &&
    paperEquity > config.targetCapitalUsd * 4;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Live readiness</h1>
        <p className="mt-1 text-sm text-muted">
          The pilot trades real money with tiny, hard-capped limits. Every drill below must pass
          (within {7} days) before LIVE_MANUAL_PILOT can be activated — and activation still
          requires the full live ceremony. Live trading remains disabled until you complete both.
        </p>
      </div>

      {capitalMismatch && (
        <div className="rounded-md border border-warning/50 bg-warning/10 px-4 py-3 text-sm text-warning">
          Paper equity ({fmtUsd(paperEquity)}) materially exceeds the planned live allocation (
          {fmtUsd(config.targetCapitalUsd)}). Paper results at this scale will NOT transfer to a{" "}
          {fmtUsd(config.targetCapitalUsd)} pilot — position sizing, fills, and psychology all
          differ. Consider resetting the paper account to pilot-sized capital at Alpaca.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Drill status"
          value={drillStatus.ok ? "READY" : "NOT READY"}
          tone={drillStatus.ok ? "positive" : "negative"}
          sub={latestRun ? `Last run ${fmtDateTime(latestRun.ranAt)}` : "Never run"}
        />
        <Stat label="Capital stage" value={stage.replace(/_/g, " ")} sub={`Enabled: ${fmtUsd(enabledCapital)}`} />
        <Stat label="Pilot position cap" value={fmtUsd(config.maxPositionUsd)} sub={`${config.maxPositions} positions max`} />
        <Stat label="Daily / weekly halt" value={`${fmtUsd(config.maxDailyLossUsd)} / ${config.maxWeeklyLossPct}%`} />
      </div>

      <Card title="Market-data feed">
        <div className="flex items-center gap-3">
          <Badge tone="amber">IEX — LIMITED COVERAGE</Badge>
          <span className="text-sm text-muted">
            This app uses Alpaca&apos;s IEX feed (free tier). Limited market-data coverage —
            restrict strategies accordingly. Full-market SIP coverage requires an Alpaca data
            subscription and is never silently assumed.
          </span>
        </div>
      </Card>

      <Card title="Failure drills">
        <DrillRunner
          initialRun={latestRun}
          gateReason={drillStatus.ok ? null : drillStatus.reason}
        />
      </Card>

      <Card title="Capital expansion gates">
        <PilotStageControl currentStage={stage} />
        <p className="mt-3 text-xs text-faint">
          Live allocation changes require manual approval. Historical performance does not
          guarantee future profit. Stages: CANARY_100 ($100) → PILOT_250 ($250) → PILOT_500 ($500)
          → REVIEW_REQUIRED ($0, halts new entries). Expansion is never automatic; every change is
          audited. The hard env-var ceiling ({fmtUsd(config.maxCapitalUsd)}) applies regardless of
          stage.
        </p>
      </Card>

      <Card title="How the pilot stays safe">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>Every order: manual approval + the full 30-check risk engine run twice on fresh data.</li>
          <li>Limit orders only; long-only; cash-only; allowlist-only; no crypto; regular hours only.</li>
          <li>Fail-closed: stale quotes, stale account data, missing snapshots, degraded streaming, or unhealthy reconciliation block new entries (exits always allowed).</li>
          <li>Kill switch halts everything instantly and persists across restarts.</li>
          <li>To revoke live access entirely: remove the live API keys from Vercel env vars and redeploy, or regenerate keys at Alpaca.</li>
        </ul>
      </Card>

      <p className="text-xs text-faint">Research, risk controls, and execution analysis in one workspace.</p>
    </div>
  );
}
