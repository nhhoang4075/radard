import { useCallback, useEffect, useRef } from "react";
import { getFeedClient } from "../../lib/feed-client.ts";
import { createDwell, createImpressionQueue, IMPRESSION } from "../../lib/impressions.ts";

/**
 * Ghi lượt hiện (use-impressions, mục 4 docs/cau-truc-web.html). Trả `observe(position)` dùng làm ref của thẻ.
 * Thẻ cao hơn nửa khung nhìn: điều kiện thay thế là phần thẻ trong khung chiếm ≥ 50% chiều cao khung nhìn.
 */
export function useImpressions(snapshotId: number | undefined) {
  const snapRef = useRef(snapshotId);
  snapRef.current = snapshotId;
  const els = useRef(new Map<number, Element>());
  const io = useRef<IntersectionObserver | null>(null);

  const state = useRef<{
    queue: ReturnType<typeof createImpressionQueue>;
    dwell: ReturnType<typeof createDwell>;
  } | null>(null);
  if (!state.current) {
    const queue = createImpressionQueue((batch) => {
      // Khi trang đang đóng/ẩn dùng sendBeacon (không bị huỷ); còn lại gọi qua client (có thể là fixtures).
      if (
        document.visibilityState === "hidden" &&
        "sendBeacon" in navigator &&
        (!import.meta.env.DEV || import.meta.env.VITE_FEED_API === "1")
      ) {
        navigator.sendBeacon(
          "/api/impressions",
          new Blob([JSON.stringify(batch)], { type: "application/json" }),
        );
        return;
      }
      void getFeedClient()
        .then((c) => c.postImpressions(batch))
        .catch(() => {});
    });
    const dwell = createDwell((key) => {
      const snap = snapRef.current;
      if (snap) queue.add(snap, Number(key), new Date().toISOString());
    });
    state.current = { queue, dwell };
  }
  const { queue, dwell } = state.current;

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        dwell.clear();
        queue.flush();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", queue.flush);
    io.current = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const key = (e.target as HTMLElement).dataset.position;
          if (!key) continue;
          const rootH = e.rootBounds?.height ?? window.innerHeight;
          const visible =
            e.intersectionRatio >= IMPRESSION.threshold ||
            e.intersectionRect.height >= IMPRESSION.threshold * rootH;
          if (visible && document.visibilityState === "visible") dwell.enter(key);
          else dwell.leave(key);
        }
      },
      { threshold: [0, 0.25, IMPRESSION.threshold, 0.75, 1] },
    );
    for (const el of els.current.values()) io.current.observe(el);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", queue.flush);
      io.current?.disconnect();
      dwell.clear();
      queue.flush();
    };
  }, [dwell, queue]);

  return useCallback(
    (position: number) => (el: HTMLElement | null) => {
      const prev = els.current.get(position);
      if (prev && prev !== el) {
        io.current?.unobserve(prev);
        dwell.leave(String(position));
        els.current.delete(position);
      }
      if (el) {
        el.dataset.position = String(position);
        els.current.set(position, el);
        io.current?.observe(el);
      }
    },
    [dwell],
  );
}
