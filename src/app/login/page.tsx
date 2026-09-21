"use client";

import { FormEvent, useEffect, useState } from "react";

export default function LoginPage() {
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/init-status")
      .then((r) => r.json())
      .then((data) => {
        if (!data.initialized) {
          window.location.assign("/setup");
        }
      })
      .catch(() => {});
  }, []);

  async function submit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    setError("");

    const form = new FormData(event.currentTarget);

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password"),
      }),
    });

    if (!response.ok) {
      setError("Invalid credentials.");
      return;
    }

    window.location.assign("/dashboard");
  }

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-md space-y-4"
      >
        <h1 className="text-3xl font-semibold">
          FreelanceOS
        </h1>

        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="Email"
          className="w-full rounded-md border p-3"
        />

        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="Password"
          className="w-full rounded-md border p-3"
        />

        {error && (
          <p className="text-sm text-destructive">
            {error}
          </p>
        )}

        <button className="w-full rounded-md bg-primary p-3 text-primary-foreground">
          Sign in
        </button>
      </form>
    </main>
  );
}
