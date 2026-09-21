"use client";

import { FormEvent, useEffect, useState } from "react";

export default function SetupPage() {
  const [timezone, setTimezone] =
    useState("Asia/Kolkata");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const detected =
      Intl.DateTimeFormat().resolvedOptions().timeZone;

    if (detected) setTimezone(detected);
  }, []);

  async function submit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    setBusy(true);
    setError("");

    const form = new FormData(event.currentTarget);

    const response = await fetch("/api/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        Object.fromEntries(form.entries()),
      ),
    });

    if (!response.ok) {
      const result = await response
        .json()
        .catch(() => null);

      setError(
        result?.error ?? "Unable to create workspace.",
      );
      setBusy(false);
      return;
    }

    window.location.assign("/dashboard");
  }

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="w-full max-w-xl">
        <h1 className="text-3xl font-semibold">
          Welcome to FreelanceOS
        </h1>
        <p className="mt-2 text-muted-foreground">
          Create your workspace.
        </p>

        <form
          onSubmit={submit}
          className="mt-8 space-y-4"
        >
          {[
            ["name", "Your name", "text"],
            ["email", "Email", "email"],
            ["password", "Password", "password"],
            [
              "workspaceName",
              "Workspace / business name",
              "text",
            ],
            ["country", "Country", "text"],
          ].map(([name, label, type]) => (
            <label
              key={name}
              className="block space-y-1"
            >
              <span className="text-sm font-medium">
                {label}
              </span>
              <input
                required
                name={name}
                type={type}
                className="w-full rounded-md border px-3 py-2"
              />
            </label>
          ))}

          <label className="block space-y-1">
            <span className="text-sm font-medium">
              Currency
            </span>
            <select
              name="defaultCurrency"
              defaultValue="INR"
              className="w-full rounded-md border px-3 py-2"
            >
              {[
                "INR",
                "USD",
                "EUR",
                "GBP",
                "AUD",
                "AED",
              ].map((currency) => (
                <option key={currency}>
                  {currency}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-sm font-medium">
              Timezone
            </span>
            <input
              required
              name="timezone"
              value={timezone}
              onChange={(e) =>
                setTimezone(e.target.value)
              }
              className="w-full rounded-md border px-3 py-2"
            />
          </label>

          {error && (
            <p className="text-sm text-destructive">
              {error}
            </p>
          )}

          <button
            disabled={busy}
            className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground"
          >
            {busy
              ? "Creating workspace..."
              : "Create workspace"}
          </button>
        </form>
      </div>
    </main>
  );
}
