"use client";

import { useEffect } from "react";

/**
 * Root error boundary.
 *
 * Next.js already strips error messages and stack traces from client bundles in
 * production builds, but this component additionally never renders `error.message`
 * or `error.stack` in any environment, so database errors, SQL fragments,
 * secrets and session details cannot reach the browser. Only the opaque
 * `digest` (a server-generated correlation id) is shown.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Logged client-side without the message/stack, purely so the digest can be
    // matched against the server log entry when debugging.
    console.error("[freelanceos] a page failed to render", {
      digest: error.digest,
    });
  }, [error.digest]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 rounded-lg border bg-background p-6 text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>

        <p className="text-sm text-muted-foreground">
          We hit an unexpected problem loading this page. Your data has not been
          changed. You can retry, or head back to your dashboard.
        </p>

        {error.digest ? (
          <p className="text-xs text-muted-foreground">
            Reference code: <span className="font-mono">{error.digest}</span>
          </p>
        ) : null}

        <div className="flex justify-center gap-3 pt-2">
          <button
            onClick={reset}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
          >
            Try again
          </button>

          <a
            href="/dashboard"
            className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
          >
            Go to dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
