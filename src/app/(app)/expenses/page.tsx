import { ModulePlaceholder } from "@/components/shell/module-placeholder";

export default function ExpensesPage() {
  return (
    <ModulePlaceholder
      title="Expenses"
      icon="expenses"
      summary="Business expense tracking to sit alongside income, giving a true picture of profit rather than turnover. No expense data is modelled yet."
      planned={[
        "Categorised expense entries",
        "Recurring subscriptions and tooling costs",
        "Expenses attributable to a client or project",
        "Profit view combining revenue and expenses",
      ]}
      availableNow={{ label: "Back to Dashboard", href: "/dashboard" }}
    />
  );
}
