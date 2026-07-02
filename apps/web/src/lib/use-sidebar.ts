import { useEffect, useState } from "react";

const KEY = "ficta-sidebar";

/**
 * Open/closed state for the chat history sidebar, persisted in localStorage. Starts open so SSR and the
 * first client paint agree (same approach as use-theme.ts), then after mount syncs to the saved choice —
 * or collapses on a narrow viewport when there's no saved choice yet.
 */
export function useSidebar() {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let initial = true;
    try {
      const saved = localStorage.getItem(KEY);
      initial = saved ? saved === "open" : window.matchMedia("(min-width: 768px)").matches;
    } catch {}
    setOpen(initial);
  }, []);

  const set = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(KEY, next ? "open" : "closed");
    } catch {}
  };

  return { open, toggle: () => set(!open), close: () => set(false) };
}
