import { ModulePlaceholder } from "@/components/shell/module-placeholder";

export default function PaymentsPage() {
  return (
    <ModulePlaceholder
      title="Payments"
      icon="payments"
      summary="Payment records will reconcile money received against invoices, so revenue figures across FreelanceOS are based on real settled amounts rather than estimates."
      planned={[
        "Record full and partial payments against an invoice",
        "Payment method and reference tracking",
        "Automatic invoice settlement",
        "Received-revenue reporting by period",
      ]}
      availableNow={{ label: "Back to Dashboard", href: "/dashboard" }}
    />
  );
}
