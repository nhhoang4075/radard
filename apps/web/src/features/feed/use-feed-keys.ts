import { useEffect } from "react";

/** j/k đổi tin, o mở bài gốc. Bỏ qua khi đang gõ trong ô nhập hoặc có phím bổ trợ. */
export function useFeedKeys(h: { next(): void; prev(): void; open(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "j") h.next();
      else if (e.key === "k") h.prev();
      else if (e.key === "o") h.open();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [h]);
}
