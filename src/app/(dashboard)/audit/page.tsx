import { Badge, Card, Empty, Td, Th } from "@/components/ui";
import { getStore } from "@/lib/store";
import { fmtDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ actor?: string }>;
}) {
  const { actor } = await searchParams;
  const store = await getStore();
  let events = await store.listAuditEvents(250);
  const actors = Array.from(new Set(events.map((e) => e.actorType)));
  if (actor) events = events.filter((e) => e.actorType === actor);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-base font-semibold tracking-tight">Audit Log</h1>
        <a
          href="/audit"
          className={`rounded-[4px] border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${!actor ? "border-accent/60 bg-accent/10 text-accent" : "border-edge text-faint hover:text-muted"}`}
        >
          All
        </a>
        {actors.map((a) => (
          <a
            key={a}
            href={`/audit?actor=${a}`}
            className={`rounded-[4px] border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${actor === a ? "border-accent/60 bg-accent/10 text-accent" : "border-edge text-faint hover:text-muted"}`}
          >
            {a}
          </a>
        ))}
      </div>

      <Card>
        {events.length === 0 ? (
          <Empty>No audit events</Empty>
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="border-b border-edge">
                  <Th>Time</Th>
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th>Summary</Th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-edge/40 align-top transition-colors last:border-0 hover:bg-raised/50">
                    <Td className="whitespace-nowrap text-[11px] text-faint">{fmtDateTime(e.createdAt)}</Td>
                    <Td>
                      <Badge
                        tone={
                          e.severity === "CRITICAL" ? "red" : e.severity === "WARNING" ? "amber" : e.actorType === "AI" ? "violet" : "muted"
                        }
                      >
                        {e.actorType}
                      </Badge>
                    </Td>
                    <Td className="font-mono text-[10px] uppercase tracking-wide text-muted">{e.action}</Td>
                    <Td className="text-[12px] text-muted">{e.summary}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
