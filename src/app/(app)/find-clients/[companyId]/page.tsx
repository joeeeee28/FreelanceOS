import Link from "next/link";
import { notFound } from "next/navigation";

import { requireUser } from "@/lib/auth/require-user";
import {
  DECISION_MAKER_INTERPRETATION_UNAVAILABLE,
  contactLine,
  interpretDecisionMakers,
  listDecisionMakers,
  personDisplayState,
  personHistory,
} from "@/lib/decision-makers";
import {
  FIND_CLIENT_INTERPRETATION_UNAVAILABLE,
  getFindClientDetail,
  interpretFindClient,
} from "@/lib/find-clients";
import { isServiceKey } from "@/lib/taxonomy/services";
import { relativeLabel } from "@/lib/time/relative";
import { Icon, ScorePill } from "@/components/ui/domain";
import { PageHeader } from "@/components/ui/page";
import { Badge, Card, LinkButton } from "@/components/ui/primitives";

import { addPersonToCrmForm, createLeadFromFindClientsForm, reviewPublicPeopleForm } from "../actions";

export default async function FindClientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await requireUser();
  const { companyId } = await params;
  const query = await searchParams;
  const service = Array.isArray(query.service) ? query.service[0] : query.service;
  if (service !== undefined && !isServiceKey(service)) notFound();

  const detail = await getFindClientDetail(workspaceId, companyId, service);
  if (detail === null) notFound();

  const people = await listDecisionMakers(workspaceId, detail.company.id);
  const [interpretation, peopleInterpretation, histories] = await Promise.all([
    interpretFindClient(detail),
    people.length > 0 ? interpretDecisionMakers(people) : Promise.resolve(null),
    Promise.all(people.map(async (person) => ({ id: person.id, rows: await personHistory(workspaceId, detail.company.id, person.id) }))),
  ]);
  const historyById = new Map(histories.map((entry) => [entry.id, entry.rows]));
  const companyObservations = detail.observations.filter((item) => !item.label.startsWith("person."));
  const place = [detail.company.city, detail.company.region, detail.company.country]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="space-y-6">
      <PageHeader
        title={detail.company.name}
        description="Stored company, opportunity and evidence. The interpretation, when present, is not a CRM fact and is not saved."
        actions={
          <>
            <LinkButton href="/find-clients" variant="ghost" size="sm">
              Back
            </LinkButton>
            {detail.lead ? (
              <LinkButton href={`/leads/${detail.lead.id}`} size="sm">
                View lead
              </LinkButton>
            ) : (
              <form action={createLeadFromFindClientsForm}>
                <input type="hidden" name="companyId" value={detail.company.id} />
                <button
                  type="submit"
                  className="inline-flex h-8 items-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground"
                >
                  Create lead
                </button>
              </form>
            )}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground">Opportunity</p>
              <h2 className="mt-1 text-lg font-semibold">{detail.opportunity.serviceLabel}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {detail.opportunity.summary ?? "No stored summary."}
              </p>
            </div>
            <ScorePill score={detail.opportunity.score} size="lg" />
          </div>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Recommended action</dt>
              <dd>{detail.opportunity.recommendedAction ?? "None stored"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Status</dt>
              <dd>{detail.opportunity.status.toLowerCase()}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Confidence</dt>
              <dd>{detail.confidence === null ? "Unknown" : detail.confidence}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last researched</dt>
              <dd>
                {detail.company.lastResearchAt
                  ? relativeLabel(detail.company.lastResearchAt)
                  : detail.company.researchStatus.toLowerCase()}
              </dd>
            </div>
          </dl>
          <div className="mt-4">
            <p className="text-xs font-medium text-muted-foreground">Why this score</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {detail.scoreExplanation.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </Card>

        <Card className="p-4">
          <p className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground">Company</p>
          <dl className="mt-3 space-y-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Industry</dt>
              <dd>{detail.company.industry ?? "Unknown"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Location</dt>
              <dd>{place || "Unknown"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Website</dt>
              <dd className="break-all">{detail.company.website ?? "Unknown"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Lead</dt>
              <dd>
                {detail.lead ? (
                  <Link href={`/leads/${detail.lead.id}`} className="hover:underline">
                    {detail.lead.status.toLowerCase()} · score {detail.lead.score}
                  </Link>
                ) : (
                  "None"
                )}
              </dd>
            </div>
          </dl>
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex items-center gap-2">
          <Icon name="search" size={16} />
          <h2 className="text-sm font-semibold">AI interpretation</h2>
          {interpretation.message === FIND_CLIENT_INTERPRETATION_UNAVAILABLE ? (
            <Badge tone="warning">{FIND_CLIENT_INTERPRETATION_UNAVAILABLE}</Badge>
          ) : null}
        </div>
        <p className="mt-2 text-sm">{interpretation.message}</p>
        {interpretation.summary ? <p className="mt-2 text-sm text-foreground">{interpretation.summary}</p> : null}
        <p className="mt-2 text-xs text-muted-foreground">
          Score remains {interpretation.score}. Rejected claims: {interpretation.rejectedCount}.
        </p>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Evidence</h2>
        {detail.evidence.length === 0 && companyObservations.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No evidence is stored for this opportunity.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {[...detail.evidence, ...companyObservations].map((item) => (
              <li key={`${item.kind}:${item.id}`} className="rounded-md border border-border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{item.kind}</Badge>
                  <span className="font-medium">{item.label}</span>
                  {item.confidence !== null ? (
                    <span className="text-xs text-muted-foreground">confidence {item.confidence}</span>
                  ) : null}
                </div>
                {item.text ? <p className="mt-1 text-muted-foreground">{item.text}</p> : null}
                <p className="mt-1 text-xs text-subtle-foreground">
                  {item.sourceName ? `${item.sourceName} · ` : ""}
                  {item.sourceUrl ?? "No source URL"}
                  {item.observedAt ? ` · ${item.observedAt}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Decision makers</h2>
          <form action={reviewPublicPeopleForm}>
            <input type="hidden" name="companyId" value={detail.company.id} />
            <button
              type="submit"
              className="inline-flex h-8 items-center rounded-md border border-border bg-surface px-2.5 text-xs font-medium"
            >
              Review public pages
            </button>
          </form>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          People published on this company&apos;s own pages. A likely role is not a verified fact. Nothing here is emailed.
        </p>
        {peopleInterpretation ? (
          <p className="mt-2 text-sm">
            {peopleInterpretation.message === DECISION_MAKER_INTERPRETATION_UNAVAILABLE
              ? DECISION_MAKER_INTERPRETATION_UNAVAILABLE
              : peopleInterpretation.message}
            {peopleInterpretation.summary ? ` ${peopleInterpretation.summary}` : ""}
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">No publicly evidenced people are stored.</p>
        )}
        <ul className="mt-4 space-y-4">
          {people.map((person) => {
            const state = personDisplayState(person);
            const previousTitles = (historyById.get(person.id) ?? []).filter(
              (row) => row.field === "person.jobTitle" && !row.current,
            );
            return (
              <li key={person.id} className="rounded-md border border-border px-3 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{person.fullName}</span>
                  <Badge tone={state === "VERIFIED" ? "success" : state === "LIKELY" ? "warning" : "neutral"}>
                    {state === "NO_CONTACT_DATA" ? "No contact data" : state.toLowerCase()}
                  </Badge>
                  {person.isDecisionMaker ? <Badge>Relevant role</Badge> : null}
                </div>
                <p className="mt-1">{person.jobTitle ?? "Title not publicly verified"}</p>
                <dl className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                  <div>Email: {contactLine(person.email)}</div>
                  <div>Phone: {contactLine(person.phone)}</div>
                  <div className="sm:col-span-2">LinkedIn: {contactLine(person.linkedinUrl)}</div>
                  <div>Confidence: {person.confidence}</div>
                  <div>Last seen: {relativeLabel(person.lastSeenAt)}</div>
                  <div className="sm:col-span-2 break-all">Source: {person.sourceUrl ?? "No source URL"}</div>
                </dl>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  {person.roleReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                  <li>{person.evidence ?? "No evidence quote is stored."}</li>
                  {detail.opportunity.serviceLabel ? (
                    <li>Stored company opportunity: {detail.opportunity.serviceLabel}.</li>
                  ) : null}
                </ul>
                {previousTitles.length > 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Earlier title: {previousTitles.map((row) => row.value).filter(Boolean).join("; ")}
                  </p>
                ) : null}
                <div className="mt-3">
                  {person.promotedContactId && detail.lead ? (
                    <LinkButton href={`/leads/${detail.lead.id}`} size="sm" variant="ghost">
                      In CRM
                    </LinkButton>
                  ) : detail.lead ? (
                    <form action={addPersonToCrmForm}>
                      <input type="hidden" name="discoveredContactId" value={person.id} />
                      <button
                        type="submit"
                        className="inline-flex h-8 items-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground"
                      >
                        Add to CRM
                      </button>
                    </form>
                  ) : (
                    <p className="text-xs text-muted-foreground">Create a lead before adding this person to the CRM.</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {detail.research.length > 0 ? (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Research runs</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {detail.research.map((run) => (
              <li key={run.id} className="flex flex-wrap gap-2 text-muted-foreground">
                <span className="text-foreground">{run.aspect.toLowerCase()}</span>
                <span>{run.status.toLowerCase()}</span>
                <span>{run.factsFound} facts</span>
                <span className="break-all">{run.sourceUrl ?? "No source URL"}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
