"use client";

import { useEffect } from "react";

/**
 * Error boundary for the authenticated shell. Keeps the sidebar mounted so a
 * failing page does not take down navigation. Like the root boundary, it never
 * renders the error message or stack.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[freelanceos] a workspace page failed to render", {
      digest: error.digest,
    });
  }, [error.digest]);

  return (
    <div className="rounded-lg border bg-background p-6">
      <h2 className="text-lg font-semibold">This page could not be loaded</h2>

      <p className="mt-2 text-sm text-muted-foreground">
        Something went wrong while loading your workspace data. Nothing was
        changed. Try again, and if it keeps happening, check your database
        connection.
      </p>

      {error.digest ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Reference code: <span className="font-mono">{error.digest}</span>
        </p>
      ) : null}

      <button
        onClick={reset}
        className="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
      >
        Try again
      </button>
    </div>
  );
}
