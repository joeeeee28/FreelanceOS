import Link from "next/link";

import { listContacts } from "@/lib/crm/contacts";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;

  const result = await listContacts({
    search: params.q,
    decisionMakersOnly: params.decisionMakers === "1",
    page: Number(params.page) || 1,
  });

  const query = (overrides: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...params, ...overrides })) {
      if (value !== undefined && value !== "") next.set(key, String(value));
    }
    const qs = next.toString();
    return qs ? `/contacts?${qs}` : "/contacts";
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Contacts</h1>
        <p className="text-muted-foreground">
          {result.total === 0
            ? "No contacts yet."
            : `${result.total} contact${result.total === 1 ? "" : "s"}`}
        </p>
      </header>

      <form method="GET" className="flex flex-wrap items-end gap-3 rounded-xl border p-4">
        <label className="min-w-[14rem] flex-1 space-y-1">
          <span className="text-xs font-medium">Search</span>
          <input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Name, email or company"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            name="decisionMakers"
            value="1"
            defaultChecked={params.decisionMakers === "1"}
            className="h-4 w-4 rounded border"
          />
          Decision makers only
        </label>

        <button className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">
          Filter
        </button>
        <Link href="/contacts" className="rounded-md border px-4 py-2 text-sm hover:bg-muted">
          Clear
        </Link>
      </form>

      {result.items.length === 0 ? (
        <div className="rounded-xl border p-8 text-center">
          <p className="font-medium">No contacts found.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Contacts are added from a lead&apos;s page so every person stays tied to an
            opportunity.
          </p>
        </div>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left">
                  <th className="p-3">Name</th>
                  <th className="p-3">Title</th>
                  <th className="p-3">Company</th>
                  <th className="p-3">Email</th>
                  <th className="p-3">Decision maker</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((contact) => (
                  <tr key={contact.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="p-3 font-medium">{contact.fullName}</td>
                    <td className="p-3">{contact.jobTitle ?? "—"}</td>
                    <td className="p-3">
                      <Link
                        href={`/leads/${contact.lead.id}`}
                        className="hover:underline"
                      >
                        {contact.lead.companyName}
                      </Link>
                    </td>
                    <td className="p-3">{contact.email ?? "—"}</td>
                    <td className="p-3">{contact.isDecisionMaker ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 md:hidden">
            {result.items.map((contact) => (
              <Link
                key={contact.id}
                href={`/leads/${contact.lead.id}`}
                className="block rounded-xl border p-4"
              >
                <p className="font-medium">{contact.fullName}</p>
                <p className="text-sm text-muted-foreground">
                  {contact.lead.companyName}
                  {contact.isDecisionMaker ? " · Decision maker" : ""}
                </p>
              </Link>
            ))}
          </div>

          {result.totalPages > 1 ? (
            <nav className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Page {result.page} of {result.totalPages}
              </p>
              <div className="flex gap-2">
                {result.page > 1 ? (
                  <Link
                    href={query({ page: result.page - 1 })}
                    className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                  >
                    Previous
                  </Link>
                ) : null}
                {result.page < result.totalPages ? (
                  <Link
                    href={query({ page: result.page + 1 })}
                    className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                  >
                    Next
                  </Link>
                ) : null}
              </div>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
