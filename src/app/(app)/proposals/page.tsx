import { ModulePlaceholder } from "@/components/shell/module-placeholder";

export default function ProposalsPage() {
  return (
    <ModulePlaceholder
      title="Proposals"
      icon="proposals"
      summary="Proposal documents with line items, pricing and accept/decline tracking. The pipeline already has Proposal and Negotiation stages, so a lead can reach proposal readiness today — the document itself is not yet modelled."
      planned={[
        "Build a proposal from a lead's service interest and pain point",
        "Line items, pricing and totals",
        "Sent, viewed, accepted and declined tracking",
        "Accepted proposal moves the lead to Won",
      ]}
      availableNow={{ label: "View proposal-stage leads", href: "/leads?status=PROPOSAL" }}
    />
  );
}
