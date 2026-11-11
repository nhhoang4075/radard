import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { getFeedClient } from "../../lib/feed-client.ts";
import { todayVN } from "../../lib/format.ts";
import { queryKeys } from "../../lib/query-keys.ts";
import type { FeedbackState, FeedItem, FeedPage } from "./types.ts";

/** Chu kỳ hỏi lại khi chưa có bản chụp hôm nay (quyết định 10/11/2026); có rồi thì dừng. */
export const POLL_MS = 5000;

export function useFeedDates() {
  return useQuery({
    queryKey: queryKeys.feedDates,
    queryFn: () => getFeedClient().getDates(),
    refetchInterval: (q) =>
      q.state.data?.dates.some((d) => d.date === todayVN()) ? false : POLL_MS,
  });
}

/** Feed của một ngày theo con trỏ; `date` rỗng = ngày gần nhất mà server chọn. */
export function useFeed(date: string | undefined) {
  return useInfiniteQuery({
    queryKey: queryKeys.feed(date),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      getFeedClient().getFeed({ ...(date ? { date } : {}), cursor: pageParam }),
    getNextPageParam: (last: FeedPage) => last.nextCursor ?? undefined,
  });
}

/** Cập nhật lạc quan phản hồi của một tin trong mọi trang đã tải; trả hàm hoàn lại. */
export function useFeedbackPatch() {
  const qc = useQueryClient();
  return (feedItemId: number, next: FeedbackState) => {
    const snapshots = qc.getQueriesData<{ pages: FeedPage[]; pageParams: unknown[] }>({
      queryKey: ["feed"],
    });
    for (const [key, data] of snapshots) {
      if (!data) continue;
      qc.setQueryData(key, {
        ...data,
        pages: data.pages.map((p) => ({
          ...p,
          items: p.items.map((i: FeedItem) =>
            i.feedItemId === feedItemId ? { ...i, feedback: next } : i,
          ),
        })),
      });
    }
    return () => {
      for (const [key, data] of snapshots) qc.setQueryData(key, data);
    };
  };
}
