import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 rounded-lg border bg-background p-6 text-center">
        <p className="text-sm font-medium text-muted-foreground">404</p>
        <h1 className="text-xl font-semibold">Page not found</h1>

        <p className="text-sm text-muted-foreground">
          This page does not exist, or the record you were looking for is no
          longer available.
        </p>

        <div className="pt-2">
          <Link
            href="/dashboard"
            className="inline-block rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
          >
            Go to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
