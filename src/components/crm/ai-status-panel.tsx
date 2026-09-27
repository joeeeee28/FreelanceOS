import { Badge, Card, CardBody, CardHeader } from "@/components/ui/primitives";
import type { AiHealthReport } from "@/lib/ai/health";
import { AI_STATE_LABELS, type AiRuntimeState } from "@/lib/ai/types";

import { relative } from "./automation-panels";

const TONE: Record<AiRuntimeState, "neutral" | "info" | "success" | "warning" | "danger"> = {
  disabled: "neutral",
  configured: "info",
  reachable: "warning",
  model_available: "success",
  unavailable: "warning",
  error: "danger",
};

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

/**
 * Operator view of the local interpreter.
 *
 * Every flag is taken from a health report. "Configured" is shown as its own
 * row and is never rendered as healthy — only a live model check is.
 */
export function AiStatusPanel({ health, now }: { health: AiHealthReport; now: Date }) {
  const rows: Array<[string, string]> = [
    ["Enabled", yesNo(health.checks.enabled)],
    ["Configuration valid", yesNo(health.checks.configurationValid)],
    ["Probed", yesNo(health.checks.probed)],
    ["Reachable", yesNo(health.checks.reachable)],
    ["Model available", yesNo(health.checks.modelAvailable)],
    ["Provider", health.provider ?? "—"],
    ["Model", health.model ?? "—"],
    ["Host", health.endpointHost ?? "—"],
  ];

  return (
    <Card>
      <CardHeader
        title="Local AI"
        description="Optional Ollama interpreter. A saved configuration is not treated as healthy, and nothing it returns is written to the CRM."
        action={<Badge tone={TONE[health.state]}>{AI_STATE_LABELS[health.state]}</Badge>}
      />
      <CardBody>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {rows.map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-surface px-3.5 py-3">
              <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
              <dd className="mt-1.5 truncate text-sm font-medium text-foreground">{value}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-3 text-xs text-subtle-foreground">
          {health.healthy
            ? "Healthy: the configured model is installed and the server answered a live check."
            : "Not healthy. Configuration alone does not count, and a stopped Ollama does not affect scoring, discovery, or the worker."}
          {health.probed
            ? ` Checked ${relative(new Date(health.checkedAt), now)}.`
            : " Not probed."}
          {health.version ? ` Server version ${health.version}.` : ""}
        </p>

        {health.error ? (
          <p className="mt-2 text-xs text-muted-foreground">{health.error.message}</p>
        ) : null}
      </CardBody>
    </Card>
  );
}
