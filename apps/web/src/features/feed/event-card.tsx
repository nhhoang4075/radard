import type { Ref } from "react";
import { formatScore } from "../../lib/format.ts";
import { strings } from "../../lib/strings.vi.ts";
import { FeedbackButtons } from "./feedback-buttons.tsx";
import type { FeedItem } from "./types.ts";

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
          <span className="fd-meta">
            <span>{item.topic ?? s.noTopic}</span>
            <span aria-hidden="true">·</span>
            <span>
              {item.sources.length > 1
                ? s.mergedFrom(item.sources.length)
                : (item.sources[0] ?? "")}
            </span>
            {item.inDigest ? <span className="fd-tag">{s.inDigest}</span> : null}
            {item.updated ? <span className="fd-tag">{s.update}</span> : null}
          </span>
        </span>
      </button>
      <div className="fd-side">
        <span className="fd-score rd-mono">{formatScore(item.score.s)}</span>
        <FeedbackButtons feedItemId={item.feedItemId} value={item.feedback} />
      </div>
    </div>
  );
}
