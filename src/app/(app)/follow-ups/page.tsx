import { listFollowUps } from "@/lib/crm/follow-ups";

export default async function FollowUpsPage() {
  const followUps = await listFollowUps();

  return (
    <div>
      <h1 className="text-2xl font-semibold">
        Follow-ups
      </h1>

      <div className="mt-6 space-y-3">
        {followUps.length === 0 ? (
          <div className="rounded-xl border p-8">
            No follow-ups scheduled.
          </div>
        ) : (
          followUps.map((item) => (
            <div
              key={item.id}
              className="rounded-xl border p-4"
            >
              <p className="font-medium">
                {item.lead.companyName}
              </p>
              <p className="text-sm text-muted-foreground">
                {item.sequence} · {item.channel} ·{" "}
                {item.status}
              </p>
              <p className="mt-2 text-sm">
                {item.scheduledAt.toLocaleString()}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
