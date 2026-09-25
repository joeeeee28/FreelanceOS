import { ModulePlaceholder } from "@/components/shell/module-placeholder";

export default function SettingsPage() {
  return (
    <ModulePlaceholder
      title="Settings"
      icon="settings"
      summary="Workspace preferences — name, country, currency and timezone — are set during first-run setup and are not yet editable from the app. Theme can be changed from the account menu in the sidebar."
      planned={[
        "Edit workspace name, country, currency and timezone",
        "Profile and password management",
        "Active session review and revocation",
        "Notification preferences for daily revenue actions",
      ]}
      availableNow={{ label: "Back to Dashboard", href: "/dashboard" }}
    />
  );
}
