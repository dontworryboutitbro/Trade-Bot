import { Badge } from "@/components/ui";
import type { TradingMode } from "@/lib/types";

export function ModeBadge({ mode }: { mode: TradingMode }) {
  if (mode === "MOCK") return <Badge tone="muted">Mock Mode</Badge>;
  if (mode === "PAPER_MANUAL") return <Badge tone="amber">Paper Trading · Manual</Badge>;
  if (mode === "PAPER_AUTONOMOUS") return <Badge tone="amber">Paper Trading · Autonomous</Badge>;
  if (mode === "LIVE_LOCKED") return <Badge tone="red">Live · Locked</Badge>;
  if (mode === "LIVE_MANUAL_PILOT") return <Badge tone="red">Live Money · Pilot</Badge>;
  if (mode === "LIVE_MANUAL") return <Badge tone="red">Live Money · Manual</Badge>;
  return <Badge tone="red">Live Money · Autonomous</Badge>;
}
