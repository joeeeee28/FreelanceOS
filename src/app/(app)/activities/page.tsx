import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";

export default async function ActivitiesPage() {
  const { workspaceId } = await requireUser();

  const activities = await db.activity.findMany({
    where: { workspaceId },
    include: {
      lead: {
        select: {
          companyName: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold">
        Activities
      </h1>

      <div className="mt-6 space-y-3">
        {activities.length === 0 ? (
          <div className="rounded-xl border p-8">
            No activity yet.
          </div>
        ) : (
          activities.map((activity) => (
            <article
              key={activity.id}
              className="rounded-xl border p-4"
            >
              <p className="font-medium">
                {activity.title}
              </p>
              <p className="text-sm text-muted-foreground">
                {activity.lead?.companyName
                  ? `${activity.lead.companyName} · `
                  : ""}
                {activity.createdAt.toLocaleString()}
              </p>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
