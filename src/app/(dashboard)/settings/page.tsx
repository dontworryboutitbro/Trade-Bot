import { EmergencyControls } from "@/components/emergency-controls";
import {
  AutomationCard,
  RiskLimitsCard,
  SymbolsCard,
  TradingModeCard,
} from "@/components/settings-client";
import { Badge, Card, Empty } from "@/components/ui";
import { getSettingsData } from "@/lib/dashboard";
import { fmtDateTime } from "@/lib/utils";
import { modeToEnvironment } from "@/lib/types";

export const dynamic = "force-dynamic";

function ConfigRow({ label, configured }: { label: string; configured: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-edge/50 py-2 text-sm last:border-0">
      <span>{label}</span>
      <Badge tone={configured ? "green" : "muted"}>{configured ? "Configured" : "Missing"}</Badge>
    </div>
  );
}

export default async function SettingsPage() {
  const data = await getSettingsData();
  const env = modeToEnvironment(data.settings.tradingMode);
  const activeLimits =
    env === "LIVE" ? data.limits.live : env === "PAPER" ? data.limits.paper : data.limits.mock;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-lg font-semibold">Settings</h1>

      <Card title="Emergency controls">
        <EmergencyControls
          killSwitch={data.settings.globalKillSwitch}
          stopNewOrders={data.settings.stopNewOrders}
        />
      </Card>

      <Card title="Trading mode">
        <TradingModeCard settings={data.settings} />
      </Card>

      <Card title={`Risk limits — ${env}`}>
        <RiskLimitsCard limits={activeLimits} />
      </Card>

      <Card title="Approved symbols">
        <SymbolsCard symbols={data.symbols} />
      </Card>

      <Card title="Automation">
        <AutomationCard settings={data.settings} />
      </Card>

      <Card title="Diagnostics — connections">
        <ConfigRow label="Supabase (database + auth)" configured={data.config.supabase && data.config.supabaseServiceRole} />
        <ConfigRow label="Anthropic API (claude-fable-5)" configured={data.config.anthropic} />
        <ConfigRow label="Alpaca paper trading" configured={data.config.alpacaPaper} />
        <ConfigRow label="Alpaca live trading" configured={data.config.alpacaLive} />
        <ConfigRow label="Cron secret" configured={data.config.cronSecret} />
        <ConfigRow label="Email alerts (Resend, optional)" configured={data.config.resend} />
        <p className="mt-2 text-xs text-faint">
          Values are never displayed — only whether each credential is present on the server.
        </p>
      </Card>

      <Card title="Recent cron runs">
        {data.cronRuns.length === 0 ? (
          <Empty>No cron runs recorded yet.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {data.cronRuns.map((run) => (
              <li key={run.id} className="flex items-center gap-2">
                <Badge tone={run.status === "COMPLETED" ? "green" : run.status === "FAILED" ? "red" : "muted"}>
                  {run.status}
                </Badge>
                <span>{run.jobName}</span>
                <span className="ml-auto text-xs text-faint">{fmtDateTime(run.startedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Audit log">
        {data.auditEvents.length === 0 ? (
          <Empty>No audit events.</Empty>
        ) : (
          <ul className="max-h-96 space-y-2 overflow-y-auto text-sm">
            {data.auditEvents.map((event) => (
              <li key={event.id} className="border-b border-edge/40 pb-2 last:border-0">
                <div className="flex items-center gap-2">
                  <Badge
                    tone={
                      event.severity === "CRITICAL"
                        ? "red"
                        : event.severity === "WARNING"
                          ? "amber"
                          : "muted"
                    }
                  >
                    {event.actorType}
                  </Badge>
                  <span className="font-mono text-xs text-muted">{event.action}</span>
                  <span className="ml-auto text-xs text-faint">{fmtDateTime(event.createdAt)}</span>
                </div>
                <p className="mt-1 text-xs text-muted">{event.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
