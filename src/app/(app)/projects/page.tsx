import { ModulePlaceholder } from "@/components/shell/module-placeholder";

export default function ProjectsPage() {
  return (
    <ModulePlaceholder
      title="Projects"
      icon="projects"
      summary="Project tracking will cover scope, milestones and delivery status for work you have won. Task management already works and will attach to projects once they exist."
      planned={[
        "Projects created from a won lead or client",
        "Milestones with due dates and completion state",
        "Tasks grouped under a project",
        "Time and scope tracking against the agreed brief",
      ]}
      availableNow={{ label: "Go to Tasks", href: "/tasks" }}
    />
  );
}
