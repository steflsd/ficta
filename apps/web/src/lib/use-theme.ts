import { useEffect, useState } from "react";

type Theme = "light" | "dark";

function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * Reads/sets the `.dark` class on <html> and persists the choice. The initial class is applied
 * pre-paint by the inline bootstrap in __root.tsx, so this hook only drives user toggles.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>("light");

  // Sync from the DOM after hydration (SSR can't know the client's resolved theme).
  useEffect(() => setTheme(currentTheme()), []);

  const toggle = () => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("ficta-theme", next);
    } catch {}
    setTheme(next);
  };

  return { theme, toggle };
}
