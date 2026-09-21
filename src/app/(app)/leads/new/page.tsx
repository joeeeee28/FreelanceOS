import Link from "next/link";

import { Icon } from "@/components/ui/domain";
import { PageHeader } from "@/components/ui/page";
import { LeadForm } from "./lead-form";

export default function NewLeadPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/leads"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <Icon name="chevronLeft" size={13} />
        Back to leads
      </Link>

      <div className="mt-4">
        <PageHeader
          title="Add a lead"
          description="Record a real company you could earn revenue from. Anything you have not researched can be left blank and filled in later."
        />
      </div>

      <LeadForm />
    </div>
  );
}
