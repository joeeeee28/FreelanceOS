"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Leads", href: "/leads" },
  { label: "Pipeline", href: "/pipeline" },
  { label: "Contacts", href: "/contacts" },
  { label: "Activities", href: "/activities" },
  { label: "Follow-ups", href: "/follow-ups" },
  { label: "Tasks", href: "/tasks" },
];

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav className="flex overflow-x-auto p-3 md:block">
      {LINKS.map((link) => {
        // A nested route such as /leads/new keeps "Leads" highlighted, but
        // "/" style prefix collisions are avoided by requiring a segment break.
        const isActive =
          pathname === link.href || pathname.startsWith(`${link.href}/`);

        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive ? "page" : undefined}
            className={`block whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors ${
              isActive
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
