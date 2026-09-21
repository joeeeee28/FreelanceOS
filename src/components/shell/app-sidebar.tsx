import Link from "next/link";

const links = [
  ["Dashboard", "/dashboard"],
  ["Leads", "/leads"],
  ["Pipeline", "/pipeline"],
  ["Contacts", "/contacts"],
  ["Activities", "/activities"],
  ["Follow-ups", "/follow-ups"],
  ["Tasks", "/tasks"],
];

export function AppSidebar() {
  return (
    <aside className="border-b bg-background md:fixed md:inset-y-0 md:w-64 md:border-r">
      <div className="p-5">
        <Link
          href="/dashboard"
          className="text-xl font-bold"
        >
          FreelanceOS
        </Link>
      </div>

      <nav className="flex overflow-x-auto p-3 md:block">
        {links.map(([label, href]) => (
          <Link
            key={href}
            href={href}
            className="block whitespace-nowrap rounded-md px-3 py-2 text-sm hover:bg-muted"
          >
            {label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
