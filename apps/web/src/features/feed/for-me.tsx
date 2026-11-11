import { useQuery } from "@tanstack/react-query";
import { MessageSquare, Sparkles } from "lucide-react";
import { getFeedClient } from "../../lib/feed-client.ts";
import { queryKeys } from "../../lib/query-keys.ts";
import { strings } from "../../lib/strings.vi.ts";
import { Button, Skeleton } from "../../ui/index.ts";
import { ForMeError } from "./types.ts";

/**
 * "Với tôi?" (quyết định 11/11/2026): gọi model khi bấm, kết quả ghi rõ là suy luận, có cache phía server
 * (`cached`) và phía client (mở lại hiện ngay). "Tìm hiểu thêm" xám, chưa bấm được ở giai đoạn 1.
 */
export function ForMeZone({ eventId }: { eventId: number }) {
  const t = strings.feed.forMe;
  const q = useQuery({
    queryKey: queryKeys.forMe(eventId),
    queryFn: async () => (await getFeedClient()).forMe(eventId),
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const loading = q.isFetching;
  const errKind = q.error instanceof ForMeError ? q.error.kind : "other";
  return (
    <div className="fd-forme">
      <div className="fd-forme-row">
        <Button
          variant="secondary"
          size="sm"
          icon={<Sparkles aria-hidden />}
          disabled={loading}
          aria-busy={loading}
          onClick={() => !q.data && void q.refetch()}
        >
          {loading ? t.loading : t.button}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<MessageSquare aria-hidden />}
          disabled
          title={t.soon}
        >
          {t.learnMore}
        </Button>
        <span className="fd-tag">{t.soonTag}</span>
      </div>
      {loading ? (
        <div className="fd-forme-res" role="status">
          <Skeleton width="94%" style={{ marginBottom: 8 }} />
          <Skeleton width="80%" style={{ marginBottom: 8 }} />
          <Skeleton width="55%" />
        </div>
      ) : null}
      {!loading && q.data ? (
        <div className="fd-forme-res">
          <p>{q.data.text}</p>
          <small>{t.note}</small>
        </div>
      ) : null}
      {!loading && q.isError ? (
        <div className="fd-forme-res" role="alert">
          <p>{t.errors[errKind]}</p>
          {errKind !== "limit" ? (
            <Button variant="ghost" size="sm" onClick={() => void q.refetch()}>
              {t.retry}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
