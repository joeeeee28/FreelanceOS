"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

const OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Auto" },
] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // The resolved theme is only known in the browser (localStorage + OS
  // preference), so a same-sized placeholder renders on the server pass.
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <div className="h-7 rounded-md border border-border" aria-hidden />;
  }

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className="flex rounded-md border border-border bg-surface-muted p-0.5"
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => setTheme(option.value)}
          aria-pressed={theme === option.value}
          className={`flex-1 rounded px-2 py-1 text-2xs font-medium transition-colors ${
            theme === option.value
              ? "bg-surface text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
