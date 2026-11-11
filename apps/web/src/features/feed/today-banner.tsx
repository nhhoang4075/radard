import { dayLabel, todayVN } from "../../lib/format.ts";
import { strings } from "../../lib/strings.vi.ts";

/** The "Điểm tin sáng nay" block. Numbers come from the snapshot being viewed: the total from `total`, the rest counted over the items fully loaded. */
export function TodayBanner({
  date,
  total,
  digestCount,
  topicCount,
}: {
  date: string;
  total: number;
  digestCount: number | null;
  topicCount: number | null;
}) {
  const b = strings.feed.banner;
  const isToday = date === todayVN();
  const stat = (v: number | null) => (v === null ? "–" : String(v));
  return (
    <section className="fd-hero" aria-labelledby="fd-hero-title">
      <div className="fd-hero-text">
        <span className="fd-pill">{b.eyebrow}</span>
        <h1 id="fd-hero-title">{isToday ? b.title : b.titleOther(dayLabel(date))}</h1>
      </div>
      <dl className="fd-stats">
        <div>
          <dd>{total}</dd>
          <dt>{b.stats.total}</dt>
        </div>
        <div>
          <dd>{stat(digestCount)}</dd>
          <dt>{b.stats.digest}</dt>
        </div>
        <div>
          <dd>{stat(topicCount)}</dd>
          <dt>{b.stats.topics}</dt>
        </div>
      </dl>
    </section>
  );
}
