import { notFound } from "next/navigation";
import { getLead } from "@/lib/crm/leads";

export default async function LeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const lead = await getLead(id);

  if (!lead) notFound();

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-semibold">
          {lead.companyName}
        </h1>
        <p className="text-muted-foreground">
          {lead.contactName ?? "No primary contact"} ·{" "}
          {lead.status.replaceAll("_", " ")}
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Info label="Score" value={String(lead.score)} />
        <Info
          label="Service"
          value={lead.serviceInterest}
        />
        <Info label="Source" value={lead.source} />
        <Info label="Industry" value={lead.industry} />
      </section>

      <Section title="Overview">
        <Info label="Email" value={lead.email} />
        <Info label="Phone" value={lead.phone} />
        <Info label="Website" value={lead.website} />
        <Info
          label="Location"
          value={[lead.city, lead.country]
            .filter(Boolean)
            .join(", ")}
        />
      </Section>

      <Section title="Contacts">
        {lead.contacts.length === 0 ? (
          <p className="text-muted-foreground">
            No contacts added.
          </p>
        ) : (
          lead.contacts.map((contact) => (
            <div key={contact.id}>
              {contact.fullName}
              {contact.jobTitle
                ? ` — ${contact.jobTitle}`
                : ""}
            </div>
          ))
        )}
      </Section>

      <Section title="Qualification">
        <Info
          label="Pain Point"
          value={lead.painPoint}
        />
        <Info
          label="Notes"
          value={lead.qualificationNotes}
        />
      </Section>

      <Section title="Activities">
        {lead.activities.length === 0 ? (
          <p>No activity yet.</p>
        ) : (
          <div className="space-y-4">
            {lead.activities.map((activity) => (
              <article
                key={activity.id}
                className="border-l-2 pl-4"
              >
                <p className="font-medium">
                  {activity.title}
                </p>
                <p className="text-sm text-muted-foreground">
                  {activity.createdAt.toLocaleString()}
                </p>
                {activity.description && (
                  <p className="mt-1">
                    {activity.description}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border p-6">
      <h2 className="mb-4 text-lg font-semibold">
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Info({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div>
      <p className="text-xs uppercase text-muted-foreground">
        {label}
      </p>
      <p>{value || "—"}</p>
    </div>
  );
}
