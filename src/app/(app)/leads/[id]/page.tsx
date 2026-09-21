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
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  LinkButton,
} from "@/components/ui/primitives";
import {
  Icon,
  KnownFlag,
  ScorePill,
  StatusBadge,
  TextOrUnknown,
} from "@/components/ui/domain";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { ActivityTimeline } from "@/components/crm/activity-timeline";

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

const TAB_IDS = [
  "overview",
  "intelligence",
  "contacts",
  "activity",
  "tasks",
  "follow-ups",
] as const;

type TabId = (typeof TAB_IDS)[number];

function parseTab(value?: string): TabId {
  return value && (TAB_IDS as readonly string[]).includes(value)
    ? (value as TabId)
    : "overview";
}

/** Renders a URL as a safe external link, or an explicit Unknown. */
function LinkOrUnknown({ href, label }: { href?: string | null; label?: string }) {
  if (!href || href.trim() === "") {
    return <span className="text-subtle-foreground">Unknown</span>;
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 break-all text-accent hover:underline"
    >
      {label ?? href}
      <Icon name="chevronRight" size={11} className="shrink-0" />
    </a>
  );
}

export default async function LeadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const now = new Date();
  const [{ id }, query] = await Promise.all([params, searchParams]);

  const lead = await getLead(id);

  if (!lead) notFound();

  const { formatDateTime, timeZone } = await getWorkspaceTimeFormatters();

  // Recomputed for display so the breakdown always matches the stored score.
  const scored = scoreLead(lead);
  const allowed = [...nextStatuses(lead.status)];
  const tab = parseTab(query.tab);
  const archived = Boolean(lead.deletedAt);

  const tabHref = (id: TabId) =>
    id === "overview" ? `/leads/${lead.id}` : `/leads/${lead.id}?tab=${id}`;

  const openTasks = lead.tasks.filter(
    (task) => task.status !== "DONE" && task.status !== "CANCELLED",
  ).length;
  const scheduledFollowUps = lead.followUps.filter(
    (followUp) => followUp.status === "SCHEDULED",
  ).length;

  const tabs: TabItem[] = [
    { id: "overview", label: "Overview", href: tabHref("overview") },
    { id: "intelligence", label: "Intelligence", href: tabHref("intelligence") },
    {
      id: "contacts",
      label: "Contacts",
      href: tabHref("contacts"),
      count: lead.contacts.length,
    },
    {
      id: "activity",
      label: "Activity",
      href: tabHref("activity"),
      count: lead.activities.length,
    },
    { id: "tasks", label: "Tasks", href: tabHref("tasks"), count: openTasks },
    {
      id: "follow-ups",
      label: "Follow-ups",
      href: tabHref("follow-ups"),
      count: scheduledFollowUps,
    },
  ];

  const contactOptions = lead.contacts.map((contact) => ({
    id: contact.id,
    fullName: contact.fullName,
  }));

  const location = [lead.city, lead.country].filter(Boolean).join(", ");
  const primaryContact = lead.contacts[0];

  return (
    <div className="space-y-5">
      <Link
        href="/leads"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <Icon name="chevronLeft" size={13} />
        Back to leads
      </Link>

      {/* ----------------------------------------------------------- header */}
      <header className="rounded-xl border border-border bg-surface p-4 shadow-xs sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
                {lead.companyName}
              </h1>
              <StatusBadge status={lead.status} />
              {archived ? <Badge tone="warning">Archived</Badge> : null}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {lead.website ? (
                <span className="inline-flex items-center gap-1">
                  <Icon name="building" size={12} />
                  <LinkOrUnknown href={lead.website} />
                </span>
              ) : (
                <span className="text-subtle-foreground">No website recorded</span>
              )}

              <span aria-hidden className="text-subtle-foreground">·</span>
              <span>{lead.industry ?? <span className="text-subtle-foreground">Industry unknown</span>}</span>

              <span aria-hidden className="text-subtle-foreground">·</span>
              <span>{location || <span className="text-subtle-foreground">Location unknown</span>}</span>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2">
            <ScorePill score={lead.score} size="lg" />
            <span className="text-2xs text-subtle-foreground">
              Lead score out of 100
            </span>
          </div>
        </div>

        {/* Primary actions. Each routes to the tab that owns the work. */}
        {!archived ? (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
            {lead.email ? (
              <LinkButton href={`mailto:${lead.email}`} variant="primary" size="sm">
                <Icon name="outreach" size={14} />
                Contact
              </LinkButton>
            ) : (
              <LinkButton href={tabHref("contacts")} variant="primary" size="sm">
                <Icon name="contacts" size={14} />
                Add a contact
              </LinkButton>
            )}

            <LinkButton href={tabHref("follow-ups")} variant="secondary" size="sm">
              <Icon name="clock" size={14} />
              Schedule follow-up
            </LinkButton>

            <LinkButton href={tabHref("tasks")} variant="secondary" size="sm">
              <Icon name="tasks" size={14} />
              Add task
            </LinkButton>
          </div>
        ) : (
          <p className="mt-4 flex items-start gap-2 rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-sm text-warning">
            <Icon name="archive" size={14} className="mt-0.5 shrink-0" />
            This lead is archived and hidden from active lists. Restore it to
            resume work.
          </p>
        )}
      </header>

      <Tabs items={tabs} active={tab} label="Lead sections" />

      {/* --------------------------------------------------------- overview */}
      {tab === "overview" ? (
        <div className="space-y-5">
          <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <Card>
              <CardHeader
                title="Company"
                description="What you know about this business."
              />
              <CardBody>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <Field label="Primary contact" value={lead.contactName} />
                  <Field
                    label="Email"
                    value={
                      lead.email ? (
                        <a
                          href={`mailto:${lead.email}`}
                          className="break-all text-accent hover:underline"
                        >
                          {lead.email}
                        </a>
                      ) : null
                    }
                  />
                  <Field
                    label="Phone"
                    value={
                      lead.phone ? (
                        <a href={`tel:${lead.phone}`} className="text-accent hover:underline">
                          {lead.phone}
                        </a>
                      ) : null
                    }
                  />
                  <Field label="Website" value={lead.website ? <LinkOrUnknown href={lead.website} /> : null} />
                  <Field label="Location" value={location} />
                  <Field label="Industry" value={lead.industry} />
                  <Field label="Company size" value={lead.companySize} />
                  <Field label="Source" value={lead.source} />
                  <Field label="LinkedIn" value={lead.linkedinUrl ? <LinkOrUnknown href={lead.linkedinUrl} label="Profile" /> : null} />
                  <Field label="Instagram" value={lead.instagramUrl ? <LinkOrUnknown href={lead.instagramUrl} label="Profile" /> : null} />
                  <Field label="Facebook" value={lead.facebookUrl ? <LinkOrUnknown href={lead.facebookUrl} label="Profile" /> : null} />
                  <Field label="Created" value={formatDateTime(lead.createdAt)} />
                </dl>
              </CardBody>
            </Card>

            <div className="space-y-5">
              <Card>
                <CardHeader
                  title="Opportunity"
                  description="Why this lead is worth your time."
                />
                <CardBody>
                  <dl className="space-y-4">
                    <Field
                      label="Service interest"
                      value={lead.serviceInterest}
                      unknownLabel="Not identified yet"
                    />
                    <Field
                      label="Pain point"
                      value={lead.painPoint}
                      unknownLabel="Not identified yet"
                    />
                    <Field
                      label="Decision maker"
                      value={
                        primaryContact?.isDecisionMaker ? (
                          <span>
                            {primaryContact.fullName}
                            {primaryContact.jobTitle
                              ? ` · ${primaryContact.jobTitle}`
                              : ""}
                          </span>
                        ) : lead.decisionMakerIdentified ? (
                          "Identified"
                        ) : null
                      }
                      unknownLabel="Not identified yet"
                    />
                  </dl>
                </CardBody>
              </Card>

              {!archived ? (
                <Card>
                  <CardHeader
                    title="Pipeline stage"
                    description="Only valid transitions are offered."
                  />
                  <CardBody>
                    <StatusControl
                      leadId={lead.id}
                      current={lead.status}
                      allowed={allowed}
                    />
                  </CardBody>
                </Card>
              ) : null}
            </div>
          </div>

          {!archived ? (
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
          ) : null}

          <Card>
            <CardHeader
              title={archived ? "Restore lead" : "Archive lead"}
              description={
                archived
                  ? "Bring this lead back into your active lists."
                  : "Hides the lead from active lists. Nothing is deleted and it can be restored at any time."
              }
            />
            <CardBody>
              <ArchiveControl leadId={lead.id} archived={archived} />
            </CardBody>
          </Card>
        </div>
      ) : null}

      {/* ----------------------------------------------------- intelligence */}
      {tab === "intelligence" ? (
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Digital presence"
              description="Only what has actually been researched. Anything unchecked stays Unknown — it is never inferred."
            />
            <CardBody>
              <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground">
                    Website
                  </dt>
                  <dd className="mt-1.5">
                    <KnownFlag
                      value={lead.websitePresent}
                      trueLabel="Has a website"
                      falseLabel="No website"
                      // No website is an opportunity for a web freelancer, so
                      // it reads as a positive signal, matching the scoring.
                      trueTone="neutral"
                      falseTone="success"
                    />
                  </dd>
                  {lead.website ? (
                    <p className="mt-1.5 text-xs">
                      <LinkOrUnknown href={lead.website} />
                    </p>
                  ) : null}
                </div>

                <Field label="Website quality" value={lead.websiteQuality} />
                <Field
                  label="Advertising activity"
                  value={<TextOrUnknown value={lead.advertisingActivity} />}
                />
                <Field
                  label="Content activity"
                  value={<TextOrUnknown value={lead.contentActivity} />}
                />
              </dl>

              <div className="mt-5 grid gap-5 border-t border-border pt-5 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground">
                    Decision maker
                  </dt>
                  <dd className="mt-1.5">
                    <KnownFlag
                      value={lead.decisionMakerIdentified}
                      trueLabel="Identified"
                      falseLabel="Not identified"
                    />
                  </dd>
                </div>

                <Field label="LinkedIn" value={lead.linkedinUrl ? <LinkOrUnknown href={lead.linkedinUrl} label="Profile" /> : null} />
                <Field label="Instagram" value={lead.instagramUrl ? <LinkOrUnknown href={lead.instagramUrl} label="Profile" /> : null} />
                <Field label="Facebook" value={lead.facebookUrl ? <LinkOrUnknown href={lead.facebookUrl} label="Profile" /> : null} />
              </div>

              <div className="mt-5 border-t border-border pt-5">
                <Field
                  label="Qualification notes"
                  value={
                    lead.qualificationNotes ? (
                      <span className="whitespace-pre-line">
                        {lead.qualificationNotes}
                      </span>
                    ) : null
                  }
                  unknownLabel="No notes recorded"
                />
              </div>
            </CardBody>
          </Card>

          {!archived ? (
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
          ) : null}
        </div>
      ) : null}

      {/* --------------------------------------------------------- contacts */}
      {tab === "contacts" ? (
        archived ? (
          <EmptyState
            icon={<Icon name="contacts" />}
            title="Contacts are read-only while archived"
            description="Restore this lead from the Overview tab to add or edit its contacts."
          />
        ) : (
          <ContactsPanel leadId={lead.id} contacts={lead.contacts} />
        )
      ) : null}

      {/* --------------------------------------------------------- activity */}
      {tab === "activity" ? (
        <div className="space-y-5">
          {!archived ? (
            <Card>
              <CardHeader title="Log a note" />
              <CardBody>
                <AddNotePanel leadId={lead.id} />
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Activity timeline"
              description="Automatically recorded as you work this lead."
            />
            <CardBody>
              {lead.activities.length === 0 ? (
                <EmptyState
                  compact
                  icon={<Icon name="clock" />}
                  title="No activity recorded yet"
                  description="Status changes, notes, contacts, tasks and follow-ups all appear here."
                />
              ) : (
                <ActivityTimeline
                  showLead={false}
                  timezone={timeZone}
                  now={now}
                  entries={lead.activities.map((activity) => ({
                    id: activity.id,
                    type: activity.type,
                    title: activity.title,
                    description: activity.description,
                    createdAt: activity.createdAt,
                    contactName: activity.contact?.fullName ?? null,
                  }))}
                />
              )}
            </CardBody>
          </Card>
        </div>
      ) : null}

      {/* ------------------------------------------------------------ tasks */}
      {tab === "tasks" ? (
        archived ? (
          <EmptyState
            icon={<Icon name="tasks" />}
            title="Tasks are read-only while archived"
            description="Restore this lead from the Overview tab to manage its tasks."
          />
        ) : (
          <TasksPanel
            leadId={lead.id}
            tasks={lead.tasks}
            contacts={contactOptions}
            timeZone={timeZone}
          />
        )
      ) : null}

      {/* ------------------------------------------------------- follow-ups */}
      {tab === "follow-ups" ? (
        archived ? (
          <EmptyState
            icon={<Icon name="followups" />}
            title="Follow-ups are read-only while archived"
            description="Restore this lead from the Overview tab to schedule follow-ups."
          />
        ) : (
          <FollowUpsPanel
            leadId={lead.id}
            followUps={lead.followUps}
            contacts={contactOptions}
            timeZone={timeZone}
            defaultScheduledAt={defaultSchedule(timeZone)}
          />
        )
      ) : null}
    </div>
  );
}
