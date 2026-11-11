import { useCallback, useEffect, useState } from "react";

const KEY = "rd.shell.collapsed";
const read = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

/** App shell state: collapsed sidebar (⌘B / Ctrl+B, remembered in the browser), drawer <900px, right panel <1100px. */
export function useShellState() {
  const [collapsed, setCollapsed] = useState(read);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(KEY, c ? "0" : "1");
      } catch {
        /* private mode: ignore */
      }
      return !c;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (window.matchMedia("(max-width: 899px)").matches) setDrawerOpen((o) => !o);
        else toggleCollapsed();
      }
      if (e.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCollapsed]);

  return { collapsed, toggleCollapsed, drawerOpen, setDrawerOpen, panelOpen, setPanelOpen };
}
