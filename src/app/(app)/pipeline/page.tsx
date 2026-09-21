import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import {
  PIPELINE_STAGES,
  stageStatus,
} from "@/lib/crm/pipeline";

export default async function PipelinePage() {
  const { workspaceId } = await requireUser();

  const leads = await db.lead.findMany({
    where: {
      workspaceId,
      deletedAt: null,
    },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold">
        Pipeline
      </h1>

      {leads.length === 0 ? (
        <div className="mt-6 rounded-xl border p-8">
          No opportunities in your pipeline yet.
        </div>
      ) : (
        <div className="mt-6 flex gap-4 overflow-x-auto pb-4">
          {PIPELINE_STAGES.map((stage) => {
            const status = stageStatus[stage];

            const items = leads.filter((lead) => {
              if (
                stage === "NEW" &&
                ["NEW", "RESEARCHING", "OUTREACH_READY", "NURTURE"].includes(
                  lead.status,
                )
              ) {
                return true;
              }

              return lead.status === status;
            });

            return (
              <section
                key={stage}
                className="w-72 shrink-0 rounded-xl bg-muted/50 p-3"
              >
                <div className="mb-3 flex justify-between">
                  <h2 className="font-medium">
                    {stage}
                  </h2>
                  <span>{items.length}</span>
                </div>

                <div className="space-y-3">
                  {items.map((lead) => (
                    <Link
                      key={lead.id}
                      href={`/leads/${lead.id}`}
                      className="block rounded-lg border bg-background p-4"
                    >
                      <p className="font-medium">
                        {lead.companyName}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Score {lead.score}
                      </p>
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
