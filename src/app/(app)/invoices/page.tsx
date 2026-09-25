import { ModulePlaceholder } from "@/components/shell/module-placeholder";

export default function InvoicesPage() {
  return (
    <ModulePlaceholder
      title="Invoices"
      icon="invoices"
      summary="Invoicing will issue and track bills against accepted proposals, in your workspace currency. No invoice, amount or tax data exists in the system yet."
      planned={[
        "Generate an invoice from an accepted proposal",
        "Draft, sent, paid and overdue states",
        "Due dates and payment reminders",
        "Outstanding balance by client",
      ]}
      availableNow={{ label: "Back to Dashboard", href: "/dashboard" }}
    />
  );
}
