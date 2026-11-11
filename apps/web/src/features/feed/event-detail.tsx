import { useQuery } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import { getFeedClient } from "../../lib/feed-client.ts";
import { formatDateTime, formatScore } from "../../lib/format.ts";
import { queryKeys } from "../../lib/query-keys.ts";
import { strings } from "../../lib/strings.vi.ts";
import { safeUrl } from "../../lib/url.ts";
import { Badge, IconButton, Skeleton, State } from "../../ui/index.ts";
import { FeedbackButtons } from "./feedback-buttons.tsx";
import { ForMeZone } from "./for-me.tsx";
import type { FeedItem } from "./types.ts";

const KEYS = ["r", "p", "c", "a", "f", "u"] as const;

/** Right panel: summary, "Với tôi?", merged articles, why it was picked (scores saved in the snapshot, not recomputed). */
export function EventDetailPanel({
  item,
  onClose,
}: {
  item: FeedItem | null;
  onClose: () => void;
}) {
  const t = strings.feed.detail;
  const q = useQuery({
    queryKey: queryKeys.event(item?.eventId ?? 0),
    enabled: item !== null,
    queryFn: () => getFeedClient().getEvent(item?.eventId ?? 0),
  });
  if (!item) return <State>{t.empty}</State>;
  const d = q.data;
  const firstUrl = safeUrl(d?.docs[0]?.url);
  return (
    <article className="fd-detail">
      <header className="fd-detail-head">
        <div className="fd-detail-tags">
          {item.inDigest ? <Badge status="run">{strings.feed.card.inDigest}</Badge> : null}
          <Badge status="off">{item.topic ?? strings.feed.card.noTopic}</Badge>
          <span className="fd-detail-close">
            <IconButton label={t.close} onClick={onClose}>
              <X aria-hidden />
            </IconButton>
          </span>
        </div>
        <h2>{item.title}</h2>
      </header>
      <div className="fd-detail-body">
        {item.summary ? <p className="fd-lead">{item.summary}</p> : null}
        <ForMeZone eventId={item.eventId} />

        {q.isPending ? (
          <div className="fd-detail-skel">
            <Skeleton width="40%" style={{ marginBottom: 10 }} />
            <Skeleton width="90%" style={{ marginBottom: 8 }} />
            <Skeleton width="70%" />
          </div>
        ) : null}
        {q.isError ? <State>{t.loadError}</State> : null}
        {d ? (
          <section className="fd-sec">
            <span className="rd-label">{t.merged}</span>
            <ul className="fd-tl">
              {d.docs.map((a) => {
                const href = safeUrl(a.url);
                return (
                  <li key={a.url}>
                    <span className="rd-mono">
                      {a.publishedAt ? formatDateTime(a.publishedAt) : ""}
                    </span>
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {a.title} <em>{a.sourceName}</em>
                      </a>
                    ) : (
                      <span>
                        {a.title} <em>{a.sourceName}</em>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <section className="fd-sec">
          <span className="rd-label">{t.why}</span>
          {d?.why ? <p className="rd-muted fd-why">{d.why}</p> : null}
          <div className="fd-scores">
            {KEYS.map((k) => (
              <div key={k} className="fd-sc">
                <span>{t.components[k]}</span>
                <span className="fd-bar" aria-hidden="true">
                  <i
                    style={{
                      width: `${Math.round(Math.min(Math.max(item.score[k], 0), 1) * 100)}%`,
                    }}
                  />
                </span>
                <span className="rd-mono">{formatScore(item.score[k])}</span>
              </div>
            ))}
          </div>
          <p className="rd-muted fd-total">
            {t.score} <b className="rd-mono">{formatScore(item.score.s)}</b>
          </p>
        </section>

        <div className="fd-detail-actions">
          <FeedbackButtons feedItemId={item.feedItemId} value={item.feedback} />
          {firstUrl ? (
            <a
              className="rd-btn"
              data-variant="secondary"
              data-size="sm"
              href={firstUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink aria-hidden />
              {strings.feed.card.readDetail}
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}
