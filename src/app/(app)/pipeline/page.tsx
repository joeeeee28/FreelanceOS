import Link from "next/link";

import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { PIPELINE_STAGES, STATUS_STAGE, nextStatuses } from "@/lib/crm/pipeline";
import { StatusControl } from "@/components/crm/lead-detail-panels";
import { formatInZone } from "@/lib/time/zoned";

function humanise(value: string) {
  const lower = value.replaceAll("_", " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export default async function PipelinePage() {
  const { workspaceId, workspace } = await requireUser();

  // Archived leads are excluded; the board is scoped to the caller's
  // workspace and joins only the single next scheduled follow-up per lead.
  const leads = await db.lead.findMany({
    where: { workspaceId, deletedAt: null },
    include: {
      followUps: {
        where: { status: "SCHEDULED" },
        orderBy: { scheduledAt: "asc" },
        take: 1,
      },
      contacts: {
        where: { isPrimary: true },
        select: { fullName: true },
        take: 1,
      },
    },
    orderBy: [{ score: "desc" }, { updatedAt: "desc" }],
  });

  const byStage = new Map(PIPELINE_STAGES.map((stage) => [stage, [] as typeof leads]));

  for (const lead of leads) {
    byStage.get(STATUS_STAGE[lead.status])!.push(lead);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Pipeline</h1>
        <p className="text-muted-foreground">
          {leads.length === 0
            ? "No active opportunities yet."
            : `${leads.length} active lead${leads.length === 1 ? "" : "s"}`}
        </p>
      </header>

      {leads.length === 0 ? (
        <div className="rounded-xl border p-8 text-center">
          <p className="font-medium">Your pipeline is empty.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Add and qualify a lead to see it move through the pipeline.
          </p>
          <Link
            href="/leads/new"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
          >
            Add Lead
          </Link>
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {PIPELINE_STAGES.map((stage) => {
            const items = byStage.get(stage)!;

            return (
              <section key={stage} className="w-80 shrink-0 rounded-xl bg-muted/40 p-3">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">{humanise(stage)}</h2>
                  <span className="rounded-full bg-background px-2 py-0.5 text-xs">
                    {items.length}
                  </span>
                </div>

                <div className="space-y-3">
                  {items.length === 0 ? (
                    <p className="px-1 py-4 text-xs text-muted-foreground">Nothing here.</p>
                  ) : (
                    items.map((lead) => (
                      <article key={lead.id} className="rounded-lg border bg-background p-3">
                        <Link href={`/leads/${lead.id}`} className="font-medium hover:underline">
                          {lead.companyName}
                        </Link>

                        <p className="mt-1 text-xs text-muted-foreground">
                          Score {lead.score}
                          {lead.contacts[0] ? ` · ${lead.contacts[0].fullName}` : ""}
                        </p>

                        {lead.status !== stage ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {humanise(lead.status)}
                          </p>
                        ) : null}

                        {lead.followUps[0] ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Next:{" "}
                            {formatInZone(lead.followUps[0].scheduledAt, workspace.timezone)}
                          </p>
                        ) : null}

                        <div className="mt-3">
                          <StatusControl
                            leadId={lead.id}
                            current={lead.status}
                            allowed={[...nextStatuses(lead.status)]}
                          />
                        </div>
                      </article>
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
