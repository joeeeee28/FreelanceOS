import Link from "next/link";
import { notFound } from "next/navigation";

import { requireUser } from "@/lib/auth/require-user";
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

import { createLeadFromFindClientsForm } from "../actions";

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

  const interpretation = await interpretFindClient(detail);
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
        {detail.evidence.length === 0 && detail.observations.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No evidence is stored for this opportunity.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {[...detail.evidence, ...detail.observations].map((item) => (
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
