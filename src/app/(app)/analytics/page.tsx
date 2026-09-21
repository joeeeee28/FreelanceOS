import { ModulePlaceholder } from "@/components/shell/module-placeholder";

export default function AnalyticsPage() {
  return (
    <ModulePlaceholder
      title="Analytics"
      icon="analytics"
      summary="Deeper reporting on conversion, cycle time and channel performance over time. The dashboard already shows live pipeline counts and a conversion funnel built from your real records."
      planned={[
        "Stage-to-stage conversion rates over a chosen period",
        "Average days spent in each pipeline stage",
        "Outreach channel effectiveness",
        "Score accuracy: predicted versus actual won deals",
      ]}
      availableNow={{ label: "Back to Dashboard", href: "/dashboard" }}
    />
  );
}
