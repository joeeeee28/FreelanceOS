import { ModulePlaceholder } from "@/components/shell/module-placeholder";

export default function ClientsPage() {
  return (
    <ModulePlaceholder
      title="Clients"
      icon="clients"
      summary="Won leads will graduate into clients with their own retainer terms, delivery history and billing profile. Today a won deal stays on the pipeline as a lead with status Won."
      planned={[
        "Convert a won lead into a client record",
        "Retainer and engagement terms",
        "Delivery and communication history per client",
        "Client-level revenue reporting",
      ]}
      availableNow={{ label: "View won leads", href: "/leads?status=WON" }}
    />
  );
}
