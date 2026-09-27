"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/require-user";
import { addDiscoveredPersonToCrm } from "@/lib/decision-makers/promote";
import { reviewCompanyPeople } from "@/lib/decision-makers/review";
import { HttpFetcher } from "@/lib/discovery/fetcher";
import { syncCompanyToLead, type SyncOutcome } from "@/lib/discovery/crm-sync";

const COMPANY_ID = /^c[a-z0-9]{24}$/;
const RECORD_ID = /^c[a-z0-9]{24}$/;

/**
 * Creates or fills a lead for a company already in this workspace.
 *
 * The write goes through the existing company-to-lead rules: no overwrite of
 * a human value, no invented field, no delete, and no other workspace.
 */
export async function createLeadFromFindClients(
  companyId: string,
): Promise<{ ok: true; outcome: SyncOutcome } | { ok: false; reason: "invalid" }> {
  if (!COMPANY_ID.test(companyId)) return { ok: false, reason: "invalid" };

  const { workspaceId } = await requireUser();
  const outcome = await syncCompanyToLead({
    workspaceId,
    companyId,
    createIfMissing: true,
    sourceLabel: "Find Clients",
  });

  revalidatePath("/find-clients");
  revalidatePath(`/find-clients/${companyId}`);
  revalidatePath("/leads");
  return { ok: true, outcome };
}

export async function createLeadFromFindClientsForm(formData: FormData): Promise<void> {
  const companyId = formData.get("companyId");
  if (typeof companyId !== "string") return;
  await createLeadFromFindClients(companyId);
}

/**
 * Reads the company's own public pages for people. Does not create a lead
 * or a CRM contact. A private or refused address is not fetched.
 */
export async function reviewPublicPeople(companyId: string): Promise<void> {
  if (!COMPANY_ID.test(companyId)) return;
  const { workspaceId } = await requireUser();
  await reviewCompanyPeople({
    workspaceId,
    companyId,
    fetcher: new HttpFetcher({ minIntervalMs: 1_000 }),
  });
  revalidatePath(`/find-clients/${companyId}`);
}

export async function reviewPublicPeopleForm(formData: FormData): Promise<void> {
  const companyId = formData.get("companyId");
  if (typeof companyId !== "string") return;
  await reviewPublicPeople(companyId);
}

/**
 * Adds one already-stored person to an existing lead. Does not create a lead
 * and does not overwrite a value already on the CRM contact.
 */
export async function addPersonToCrm(discoveredContactId: string): Promise<void> {
  if (!RECORD_ID.test(discoveredContactId)) return;
  const { workspaceId, userId } = await requireUser();
  const outcome = await addDiscoveredPersonToCrm({
    workspaceId,
    userId,
    discoveredContactId,
  });
  if (!outcome.ok) return;
  revalidatePath("/find-clients");
  revalidatePath(`/find-clients/${outcome.companyId}`);
  revalidatePath("/leads");
  revalidatePath(`/leads/${outcome.leadId}`);
}

export async function addPersonToCrmForm(formData: FormData): Promise<void> {
  const discoveredContactId = formData.get("discoveredContactId");
  if (typeof discoveredContactId !== "string") return;
  await addPersonToCrm(discoveredContactId);
}
