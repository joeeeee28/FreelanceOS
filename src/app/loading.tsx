export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[60vh] items-center justify-center p-6"
    >
      <div className="w-full max-w-md space-y-3">
        <div className="h-6 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-4 w-full animate-pulse rounded bg-muted" />
        <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
