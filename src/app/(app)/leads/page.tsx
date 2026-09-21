import Link from "next/link";
import { listLeads } from "@/lib/crm/leads";
import { getWorkspaceTimeFormatters } from "@/lib/time/workspace-time";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const params = await searchParams;
  const leads = await listLeads(params.q);
  const { formatDate } = await getWorkspaceTimeFormatters();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            Leads
          </h1>
          <p className="text-muted-foreground">
            Manage real prospects and opportunities.
          </p>
        </div>

        <Link
          href="/leads/new"
          className="rounded-md bg-primary px-4 py-2 text-primary-foreground"
        >
          Add Lead
        </Link>
      </header>

      <form>
        <input
          name="q"
          defaultValue={params.q}
          placeholder="Search leads..."
          className="w-full max-w-md rounded-md border bg-background px-3 py-2"
        />
      </form>

      {leads.length === 0 ? (
        <div className="rounded-xl border p-10 text-center">
          <h2 className="font-semibold">
            No leads yet
          </h2>
          <p className="mt-2 text-muted-foreground">
            Add your first lead to start building your
            freelance pipeline.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40">
              <tr>
                {[
                  "Company",
                  "Contact",
                  "Status",
                  "Score",
                  "Service",
                  "Source",
                  "Next Follow-up",
                ].map((heading) => (
                  <th
                    key={heading}
                    className="p-3 text-left font-medium"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {leads.map((lead) => (
                <tr
                  key={lead.id}
                  className="border-b last:border-0"
                >
                  <td className="p-3">
                    <Link
                      href={`/leads/${lead.id}`}
                      className="font-medium hover:underline"
                    >
                      {lead.companyName}
                    </Link>
                  </td>
                  <td className="p-3">
                    {lead.contactName ?? "—"}
                  </td>
                  <td className="p-3">
                    {lead.status.replaceAll("_", " ")}
                  </td>
                  <td className="p-3">{lead.score}</td>
                  <td className="p-3">
                    {lead.serviceInterest ?? "—"}
                  </td>
                  <td className="p-3">
                    {lead.source ?? "—"}
                  </td>
                  <td className="p-3">
                    {lead.followUps[0]
                      ? formatDate(lead.followUps[0].scheduledAt)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
