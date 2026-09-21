"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

const OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // The resolved theme is only known in the browser (it depends on
  // localStorage and the OS preference). Rendering the real control before
  // mount would produce a hydration mismatch, so a placeholder of the same
  // size is rendered on the server pass.
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <div className="h-8 rounded-md border" aria-hidden />;
  }

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className="flex rounded-md border p-0.5"
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => setTheme(option.value)}
          aria-pressed={theme === option.value}
          className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${
            theme === option.value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
