import { ModulePlaceholder } from "@/components/shell/module-placeholder";

export default function ContentCalendarPage() {
  return (
    <ModulePlaceholder
      title="Content Calendar"
      icon="calendar"
      summary="A calendar for the content you publish to generate inbound leads — posts, newsletters and case studies — scheduled in your workspace timezone."
      planned={[
        "Month and week views of planned content",
        "Draft, scheduled and published states",
        "Link published content to the leads it generated",
        "Recurring publishing cadences",
      ]}
      availableNow={{ label: "Go to Tasks", href: "/tasks" }}
    />
  );
}
