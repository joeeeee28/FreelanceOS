import { listTasks } from "@/lib/crm/tasks";

export default async function TasksPage() {
  const tasks = await listTasks();

  return (
    <div>
      <h1 className="text-2xl font-semibold">
        Tasks
      </h1>

      <div className="mt-6 space-y-3">
        {tasks.length === 0 ? (
          <div className="rounded-xl border p-8">
            No tasks yet.
          </div>
        ) : (
          tasks.map((task) => (
            <div
              key={task.id}
              className="rounded-xl border p-4"
            >
              <div className="flex justify-between gap-4">
                <div>
                  <p className="font-medium">
                    {task.title}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {task.lead?.companyName ??
                      "General task"}
                  </p>
                </div>
                <span>{task.priority}</span>
              </div>

              {task.dueAt && (
                <p className="mt-2 text-sm">
                  Due {task.dueAt.toLocaleString()}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
