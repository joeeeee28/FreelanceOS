"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

export function UserMenu({
  userName,
  userEmail,
}: {
  userName: string;
  userEmail: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  async function handleLogout() {
    setFailed(false);

    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        // Ensures the session cookie is sent so the server can delete the row.
        credentials: "same-origin",
      });

      if (!response.ok) {
        setFailed(true);
        return;
      }
    } catch {
      setFailed(true);
      return;
    }

    // Drop every cached query so no workspace data from the previous session
    // is readable after signing out.
    queryClient.clear();

    startTransition(() => {
      router.replace("/login");
      // Discards the client-side Router Cache, otherwise going "back" could
      // render a previously fetched authenticated page from memory.
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium" title={userName}>
          {userName}
        </p>
        <p className="truncate text-xs text-muted-foreground" title={userEmail}>
          {userEmail}
        </p>
      </div>

      {failed ? (
        <p role="alert" className="text-xs text-destructive">
          Sign out failed. Please try again.
        </p>
      ) : null}

      <button
        type="button"
        onClick={handleLogout}
        disabled={pending}
        className="w-full rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-60"
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
