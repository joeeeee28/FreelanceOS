import type { IconName } from "@/components/ui/domain";

/**
 * Application information architecture.
 *
 * `status: "live"` items are backed by real services. `status: "planned"`
 * items have no backend yet — they route to an honest placeholder that
 * explains what will live there rather than showing invented data.
 */
export interface NavItem {
  label: string;
  href: string;
  icon: IconName;
  status: "live" | "planned";
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Revenue",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: "dashboard", status: "live" },
      { label: "Leads", href: "/leads", icon: "leads", status: "live" },
      { label: "Pipeline", href: "/pipeline", icon: "pipeline", status: "live" },
      { label: "Contacts", href: "/contacts", icon: "contacts", status: "live" },
      { label: "Outreach", href: "/outreach", icon: "outreach", status: "planned" },
      { label: "Follow-ups", href: "/follow-ups", icon: "followups", status: "live" },
    ],
  },
  {
    label: "Delivery",
    items: [
      { label: "Clients", href: "/clients", icon: "clients", status: "planned" },
      { label: "Projects", href: "/projects", icon: "projects", status: "planned" },
      { label: "Tasks", href: "/tasks", icon: "tasks", status: "live" },
      {
        label: "Content Calendar",
        href: "/content-calendar",
        icon: "calendar",
        status: "planned",
      },
    ],
  },
  {
    label: "Finance",
    items: [
      { label: "Proposals", href: "/proposals", icon: "proposals", status: "planned" },
      { label: "Invoices", href: "/invoices", icon: "invoices", status: "planned" },
      { label: "Payments", href: "/payments", icon: "payments", status: "planned" },
      { label: "Expenses", href: "/expenses", icon: "expenses", status: "planned" },
    ],
  },
  {
    label: "Insights",
    items: [
      { label: "Activity", href: "/activities", icon: "followups", status: "live" },
      { label: "Analytics", href: "/analytics", icon: "analytics", status: "planned" },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Automation", href: "/automation", icon: "automation", status: "live" },
      { label: "Settings", href: "/settings", icon: "settings", status: "planned" },
    ],
  },
];

/** Flat lookup used by the top bar to title the current page. */
export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/** Longest-prefix match so /leads/123 resolves to the Leads entry. */
export function findNavItem(pathname: string): NavItem | undefined {
  return [...ALL_NAV_ITEMS]
    .filter(
      (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
    )
    .sort((a, b) => b.href.length - a.href.length)[0];
}
