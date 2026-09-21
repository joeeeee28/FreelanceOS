import Link from "next/link";
import { notFound } from "next/navigation";

import { getLead } from "@/lib/crm/leads";
import { nextStatuses } from "@/lib/crm/pipeline";
import { scoreLead } from "@/lib/crm/scoring";
import { getWorkspaceTimeFormatters } from "@/lib/time/workspace-time";
import { zonedParts } from "@/lib/time/zoned";
import {
  AddNotePanel,
  ArchiveControl,
  ContactsPanel,
  EditLeadPanel,
  FollowUpsPanel,
  QualificationPanel,
  StatusControl,
  TasksPanel,
} from "@/components/crm/lead-detail-panels";

function humanise(value: string) {
  const lower = value.replaceAll("_", " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Pre-fills the datetime-local control with tomorrow 09:00 workspace time. */
function defaultSchedule(timeZone: string): string {
  const now = new Date();
  const { year, month, day } = zonedParts(now, timeZone);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(
    next.getUTCDate(),
  )}T09:00`;
}

export default async function LeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const lead = await getLead(id);

  if (!lead) notFound();

  const { formatDateTime, timeZone } = await getWorkspaceTimeFormatters();

  // Recomputed for display so the breakdown always matches the stored score.
  const scored = scoreLead(lead);
  const allowed = [...nextStatuses(lead.status)];

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <Link href="/leads" className="text-sm text-muted-foreground hover:underline">
          ← Back to leads
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold sm:text-3xl">{lead.companyName}</h1>
            <p className="mt-1 text-muted-foreground">
              {lead.contactName ?? "No primary contact"} · {humanise(lead.status)}
              {lead.deletedAt ? " · Archived" : ""}
            </p>
          </div>

          <div className="text-right">
            <p className="text-xs uppercase text-muted-foreground">Score</p>
            <p className="text-3xl font-semibold">{lead.score}</p>
          </div>
        </div>

        {lead.deletedAt ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            This lead is archived and hidden from active lists.
          </p>
        ) : null}
      </header>

      {!lead.deletedAt ? (
        <section className="rounded-xl border p-4 sm:p-6">
          <h2 className="mb-3 text-lg font-semibold">Pipeline stage</h2>
          <StatusControl leadId={lead.id} current={lead.status} allowed={allowed} />
        </section>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Info label="Email" value={lead.email} />
        <Info label="Phone" value={lead.phone} />
        <Info label="Website" value={lead.website} />
        <Info
          label="Location"
          value={[lead.city, lead.country].filter(Boolean).join(", ")}
        />
        <Info label="Industry" value={lead.industry} />
        <Info label="Company size" value={lead.companySize} />
        <Info label="Source" value={lead.source} />
        <Info label="Service interest" value={lead.serviceInterest} />
      </section>

      {!lead.deletedAt ? (
        <>
          <EditLeadPanel
            leadId={lead.id}
            lead={{
              companyName: lead.companyName,
              contactName: lead.contactName,
              email: lead.email,
              phone: lead.phone,
              website: lead.website,
              source: lead.source,
              country: lead.country,
              city: lead.city,
              industry: lead.industry,
              companySize: lead.companySize,
              linkedinUrl: lead.linkedinUrl,
              instagramUrl: lead.instagramUrl,
              facebookUrl: lead.facebookUrl,
              serviceInterest: lead.serviceInterest,
              painPoint: lead.painPoint,
            }}
          />

          <QualificationPanel
            leadId={lead.id}
            score={lead.score}
            scoreReasons={scored.reasons}
            lead={{
              decisionMakerIdentified: lead.decisionMakerIdentified,
              websitePresent: lead.websitePresent,
              websiteQuality: lead.websiteQuality,
              advertisingActivity: lead.advertisingActivity,
              contentActivity: lead.contentActivity,
              serviceInterest: lead.serviceInterest,
              painPoint: lead.painPoint,
              qualificationNotes: lead.qualificationNotes,
            }}
          />

          <ContactsPanel leadId={lead.id} contacts={lead.contacts} />

          <FollowUpsPanel
            leadId={lead.id}
            followUps={lead.followUps}
            contacts={lead.contacts.map((contact) => ({
              id: contact.id,
              fullName: contact.fullName,
            }))}
            formatDateTime={formatDateTime}
            defaultScheduledAt={defaultSchedule(timeZone)}
          />

          <TasksPanel
            leadId={lead.id}
            tasks={lead.tasks}
            contacts={lead.contacts.map((contact) => ({
              id: contact.id,
              fullName: contact.fullName,
            }))}
            formatDateTime={formatDateTime}
          />
        </>
      ) : null}

      <section className="rounded-xl border p-4 sm:p-6">
        <h2 className="mb-4 text-lg font-semibold">Activity timeline</h2>

        {!lead.deletedAt ? (
          <div className="mb-6">
            <AddNotePanel leadId={lead.id} />
          </div>
        ) : null}

        {lead.activities.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
        ) : (
          <ol className="space-y-4">
            {lead.activities.map((activity) => (
              <li key={activity.id} className="border-l-2 pl-4">
                <p className="font-medium">{activity.title}</p>
                <p className="text-sm text-muted-foreground">
                  {formatDateTime(activity.createdAt)}
                  {activity.contact ? ` · ${activity.contact.fullName}` : ""}
                </p>
                {activity.description ? (
                  <p className="mt-1 whitespace-pre-line text-sm">{activity.description}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="rounded-xl border p-4 sm:p-6">
        <h2 className="mb-3 text-lg font-semibold">
          {lead.deletedAt ? "Restore" : "Danger zone"}
        </h2>
        <ArchiveControl leadId={lead.id} archived={Boolean(lead.deletedAt)} />
      </section>
    </div>
  );
}

function Info({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-sm">{value || "—"}</p>
    </div>
  );
}
