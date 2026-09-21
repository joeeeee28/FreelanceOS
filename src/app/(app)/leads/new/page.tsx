import { createLeadAction } from "./actions";

const fields = [
  ["companyName", "Company *"],
  ["contactName", "Contact"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["website", "Website"],
  ["country", "Country"],
  ["city", "City"],
  ["industry", "Industry"],
  ["companySize", "Company Size"],
  ["linkedinUrl", "LinkedIn"],
  ["instagramUrl", "Instagram"],
  ["facebookUrl", "Facebook"],
  ["serviceInterest", "Service Interest"],
  ["source", "Source"],
];

export default function NewLeadPage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold">
        Add Lead
      </h1>

      <form
        action={createLeadAction}
        className="mt-6 space-y-5"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map(([name, label]) => (
            <label
              key={name}
              className="space-y-1"
            >
              <span className="text-sm font-medium">
                {label}
              </span>
              <input
                name={name}
                required={name === "companyName"}
                className="w-full rounded-md border bg-background px-3 py-2"
              />
            </label>
          ))}
        </div>

        <label className="block space-y-1">
          <span className="text-sm font-medium">
            Pain Point
          </span>
          <textarea
            name="painPoint"
            rows={5}
            className="w-full rounded-md border bg-background px-3 py-2"
          />
        </label>

        <button className="rounded-md bg-primary px-4 py-2 text-primary-foreground">
          Create Lead
        </button>
      </form>
    </div>
  );
}
