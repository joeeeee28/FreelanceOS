"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      // Avoids the CSS transition flash when the resolved theme flips.
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
