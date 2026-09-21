"use server";

import { redirect } from "next/navigation";
import { createLead } from "@/lib/crm/leads";

export async function createLeadAction(
  formData: FormData,
) {
  const lead = await createLead({
    companyName: formData.get("companyName"),
    contactName:
      String(formData.get("contactName") || "") ||
      undefined,
    email:
      String(formData.get("email") || "") ||
      undefined,
    phone:
      String(formData.get("phone") || "") ||
      undefined,
    website:
      String(formData.get("website") || "") ||
      undefined,
    country:
      String(formData.get("country") || "") ||
      undefined,
    city:
      String(formData.get("city") || "") ||
      undefined,
    industry:
      String(formData.get("industry") || "") ||
      undefined,
    companySize:
      String(formData.get("companySize") || "") ||
      undefined,
    linkedinUrl:
      String(formData.get("linkedinUrl") || "") ||
      undefined,
    instagramUrl:
      String(formData.get("instagramUrl") || "") ||
      undefined,
    facebookUrl:
      String(formData.get("facebookUrl") || "") ||
      undefined,
    serviceInterest:
      String(formData.get("serviceInterest") || "") ||
      undefined,
    painPoint:
      String(formData.get("painPoint") || "") ||
      undefined,
    source:
      String(formData.get("source") || "") ||
      undefined,
  });

  redirect(`/leads/${lead.id}`);
}
