import { listContacts } from "@/lib/crm/contacts";

export default async function ContactsPage() {
  const contacts = await listContacts();

  return (
    <div>
      <h1 className="text-2xl font-semibold">
        Contacts
      </h1>

      {contacts.length === 0 ? (
        <div className="mt-6 rounded-xl border p-8">
          No contacts yet.
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="p-3 text-left">Name</th>
                <th className="p-3 text-left">Title</th>
                <th className="p-3 text-left">
                  Company
                </th>
                <th className="p-3 text-left">Email</th>
                <th className="p-3">Decision Maker</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) => (
                <tr
                  key={contact.id}
                  className="border-b"
                >
                  <td className="p-3">
                    {contact.fullName}
                  </td>
                  <td className="p-3">
                    {contact.jobTitle ?? "—"}
                  </td>
                  <td className="p-3">
                    {contact.lead.companyName}
                  </td>
                  <td className="p-3">
                    {contact.email ?? "—"}
                  </td>
                  <td className="p-3 text-center">
                    {contact.isDecisionMaker
                      ? "Yes"
                      : "No"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
