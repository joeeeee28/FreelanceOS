/**
 * Reviews one company's own public pages for people.
 *
 * Uses the existing same-site page collector. A refused, private, or missing
 * site stores nothing. This function does not create leads or CRM contacts.
 */

import { db } from "@/lib/db-client";
import { companyOrigin } from "@/lib/research/aspects";
import { collectSitePages } from "@/lib/discovery/providers/website";
import { checkTarget } from "@/lib/discovery/net-guard";
import type { Fetcher } from "@/lib/discovery/provider";

import { extractPeopleFromHtml } from "./extract";
import { storeDiscoveredPeople, type StorePeopleResult } from "./store";

export interface PeopleReview {
  companyId: string;
  outcome: "stored" | "empty" | "refused" | "missing" | "no_website";
  pagesRead: number;
  pagesBlocked: number;
  people: number;
  store: StorePeopleResult | null;
}

const MAX_PAGES = 4;

export async function reviewCompanyPeople(input: {
  workspaceId: string;
  companyId: string;
  fetcher: Fetcher;
  now?: Date;
  signal?: AbortSignal;
}): Promise<PeopleReview> {
  const company = await db.company.findFirst({
    where: { id: input.companyId, workspaceId: input.workspaceId, archivedAt: null },
    select: { id: true, website: true, canonicalDomain: true },
  });
  if (company === null) {
    return {
      companyId: input.companyId,
      outcome: "missing",
      pagesRead: 0,
      pagesBlocked: 0,
      people: 0,
      store: null,
    };
  }

  const origin = companyOrigin(company);
  if (origin === null) {
    return {
      companyId: company.id,
      outcome: "no_website",
      pagesRead: 0,
      pagesBlocked: 0,
      people: 0,
      store: null,
    };
  }

  const guard = checkTarget(origin);
  if (!guard.allowed) {
    return {
      companyId: company.id,
      outcome: "refused",
      pagesRead: 0,
      pagesBlocked: 0,
      people: 0,
      store: null,
    };
  }

  const collection = await collectSitePages({
    origin,
    fetcher: input.fetcher,
    maxPages: MAX_PAGES,
    signal: input.signal,
  });

  const people = collection.pages.flatMap((page) => {
    if (page.document.outcome !== "SUCCESS" || typeof page.document.body !== "string") return [];
    if (checkTarget(page.document.url).allowed !== true) return [];
    return extractPeopleFromHtml(page.document.body, page.document.url);
  });

  if (people.length === 0) {
    return {
      companyId: company.id,
      outcome: "empty",
      pagesRead: collection.pages.length,
      pagesBlocked: collection.pagesBlocked,
      people: 0,
      store: null,
    };
  }

  const store = await storeDiscoveredPeople({
    workspaceId: input.workspaceId,
    companyId: company.id,
    people,
    now: input.now,
  });

  return {
    companyId: company.id,
    outcome: "stored",
    pagesRead: collection.pages.length,
    pagesBlocked: collection.pagesBlocked,
    people: people.length,
    store,
  };
}
