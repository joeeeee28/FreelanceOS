import { ModulePlaceholder } from "@/components/shell/module-placeholder";

export default function OutreachPage() {
  return (
    <ModulePlaceholder
      title="Outreach"
      icon="outreach"
      summary="Outreach sequencing will let you compose, send and track messages across the channels already modelled on follow-ups — email, LinkedIn, Instagram, WhatsApp and the rest — without leaving FreelanceOS."
      planned={[
        "Message templates per channel and sequence step",
        "Send and log outreach directly against a lead",
        "Reply detection that advances the pipeline stage",
        "Per-channel response-rate reporting",
      ]}
      availableNow={{ label: "Go to Follow-ups", href: "/follow-ups" }}
    />
  );
}
