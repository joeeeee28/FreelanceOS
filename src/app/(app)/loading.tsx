export default function AppLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-4">
      <div className="h-7 w-48 animate-pulse rounded bg-muted" />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-24 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>

      <div className="h-64 animate-pulse rounded-lg bg-muted" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
