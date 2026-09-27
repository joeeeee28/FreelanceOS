"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/require-user";
import { syncCompanyToLead, type SyncOutcome } from "@/lib/discovery/crm-sync";

const COMPANY_ID = /^c[a-z0-9]{24}$/;

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
