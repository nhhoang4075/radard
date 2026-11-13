import type { Ref } from "react";
import { formatScore } from "../../lib/format.ts";
import { strings } from "../../lib/strings.vi.ts";
import { Badge } from "../../ui/index.ts";
import { FeedbackButtons } from "./feedback-buttons.tsx";
import type { FeedItem } from "./types.ts";

/** One list card (mirrors drawList() in docs/demo-giao-dien.html). */
export function EventCard({
  item,
  selected,
  onSelect,
  innerRef,
}: {
  item: FeedItem;
  selected: boolean;
  onSelect: () => void;
  innerRef: Ref<HTMLDivElement>;
}) {
  const s = strings.feed.card;
  return (
    <div ref={innerRef} className="fd-item" data-selected={selected ? "" : undefined}>
      <button type="button" className="fd-item-main" aria-pressed={selected} onClick={onSelect}>
        <span className="fd-n rd-mono">{String(item.position).padStart(2, "0")}</span>
        <span className="fd-body">
          <span className="fd-title">{item.title}</span>
          {item.summary ? <span className="fd-sum">{item.summary}</span> : null}
          <span className="fd-m">{item.topic ?? s.noTopic}</span>
          <span className="fd-m">
            <span>
              {s.articles(item.articleCount)} · {item.sources.join(", ")}
            </span>
            {item.inDigest ? <Badge status="ok">{s.inDigest}</Badge> : null}
            {item.updated ? <Badge status="run">{s.update}</Badge> : null}
          </span>
        </span>
      </button>
      <div className="fd-side">
        <span className="fd-score rd-mono">
          {formatScore(item.score.s)}
          <small>{s.scoreLabel}</small>
        </span>
        <FeedbackButtons feedItemId={item.feedItemId} value={item.feedback} />
      </div>
    </div>
  );
}
