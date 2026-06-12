import { Badge, Card, Empty, Stat } from "@/components/ui";
import { getStore } from "@/lib/store";
import { fmtDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

const CRITICAL_TYPES = [
  "KILL_SWITCH_ENGAGED",
  "DAILY_LOSS_THRESHOLD",
  "DRAWDOWN_THRESHOLD",
  "STRATEGY_ROLLBACK",
  "RECONCILIATION_FAILURE",
  "CONNECTION_FAILURE",
  "PILOT_CAPITAL_STAGE",
];

type NotificationList = Awaited<
  ReturnType<Awaited<ReturnType<typeof getStore>>["listNotifications"]>
>;

function Section({
  title,
  items,
  tone,
}: {
  title: string;
  items: NotificationList;
  tone: "red" | "amber" | "muted";
}) {
  return (
    <Card title={`${title} (${items.length})`} glow={tone === "red" && items.length > 0 ? "accent" : undefined}>
      {items.length === 0 ? (
        <Empty>None</Empty>
      ) : (
        <ul className="divide-y divide-edge/50">
          {items.slice(0, 40).map((n) => (
            <li key={n.id} className="flex items-start gap-2.5 py-2 text-[13px] first:pt-0 last:pb-0">
              <Badge tone={tone}>{n.severity}</Badge>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="font-medium leading-tight">{n.title}</p>
                  <span className="font-num shrink-0 text-[10px] uppercase text-faint">
                    {fmtDateTime(n.createdAt)}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted">{n.message}</p>
                <p className="mt-0.5 font-mono text-[9px] uppercase tracking-wide text-faint">
                  {n.notificationType}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default async function AlertsPage() {
  const store = await getStore();
  const notifications = await store.listNotifications(200);
  const critical = notifications.filter(
    (n) => n.severity === "CRITICAL" || CRITICAL_TYPES.includes(n.notificationType),
  );
  const review = notifications.filter((n) => n.severity === "WARNING" && !critical.includes(n));
  const informational = notifications.filter(
    (n) => !critical.includes(n) && !review.includes(n),
  );

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <h1 className="text-base font-semibold tracking-tight">Alerts</h1>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Critical" value={critical.length} tone={critical.length ? "negative" : "neutral"} />
        <Stat label="Requires review" value={review.length} />
        <Stat label="Informational" value={informational.length} />
      </div>
      <Section title="Critical" items={critical} tone="red" />
      <Section title="Requires review" items={review} tone="amber" />
      <Section title="Informational" items={informational} tone="muted" />
    </div>
  );
}
