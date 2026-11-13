import { useQuery } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import { getFeedClient } from "../../lib/feed-client.ts";
import { formatScore, formatTime } from "../../lib/format.ts";
import { queryKeys } from "../../lib/query-keys.ts";
import { strings } from "../../lib/strings.vi.ts";
import { hostOf, safeUrl } from "../../lib/url.ts";
import { IconButton, Skeleton, State } from "../../ui/index.ts";
import { ForMeZone } from "./for-me.tsx";
import type { FeedItem } from "./types.ts";

// Same five bars as the demo: R, P, C, A and N (novelty). F and U are not shown.
const KEYS = ["r", "p", "c", "a", "n"] as const;

/** Detail panel (mirrors drawDetail() in docs/demo-giao-dien.html). Scores come from the stored snapshot. */
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
    <article className="fd-detail-inner">
      <header className="fd-dh">
        <div className="fd-dh-tags">
          <span className="fd-pill">{item.topic ?? strings.feed.card.noTopic}</span>
          <span className="fd-pill">{t.scorePill(formatScore(item.score.s))}</span>
          <span className="fd-dh-close">
            <IconButton label={t.close} onClick={onClose}>
              <X aria-hidden />
            </IconButton>
          </span>
        </div>
        <h2>{item.title}</h2>
      </header>
      <div className="fd-db">
        {item.summary ? <p className="fd-lead">{item.summary}</p> : null}
        <ForMeZone eventId={item.eventId} />

        {q.isPending ? (
          <div className="fd-sec">
            <Skeleton width="40%" style={{ marginBottom: 10 }} />
            <Skeleton width="90%" style={{ marginBottom: 8 }} />
            <Skeleton width="70%" />
          </div>
        ) : null}
        {q.isError ? <State>{t.loadError}</State> : null}
        {d ? (
          <div className="fd-sec">
            <span className="rd-label">{t.merged(d.docs.length)}</span>
            <ul className="fd-tl">
              {d.docs.map((a) => {
                const href = safeUrl(a.url);
                return (
                  <li key={a.url} className={a.publishedAt ? undefined : "fd-tl-notime"}>
                    {a.publishedAt ? <span>{formatTime(a.publishedAt)}</span> : null}
                    <div title={`${hostOf(a.url) ?? a.sourceName} · ${a.title}`}>
                      {hostOf(a.url) ?? a.sourceName} ·{" "}
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer">
                          {a.title}
                        </a>
                      ) : (
                        a.title
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        <div className="fd-sec">
          <span className="rd-label">{t.why}</span>
          <div className="fd-scores">
            {KEYS.map((k) => {
              const v = item.score[k];
              return (
                <div key={k} className="fd-sc">
                  <span>{t.components[k]}</span>
                  <div className="fd-bar" aria-hidden="true">
                    <i style={{ width: `${Math.round(Math.min(Math.max(v, 0), 1) * 100)}%` }} />
                  </div>
                  <span className="rd-mono">{v ? formatScore(v) : "–"}</span>
                </div>
              );
            })}
          </div>
        </div>

        {firstUrl ? (
          <div className="fd-sec fd-actions">
            <a className="rd-btn" href={firstUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden />
              {strings.feed.card.readDetail}
            </a>
          </div>
        ) : null}
      </div>
    </article>
  );
}
