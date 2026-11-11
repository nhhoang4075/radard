import { dayLabel, todayVN } from "../../lib/format.ts";
import { strings } from "../../lib/strings.vi.ts";

/** `nextCursor === null`: hết bản chụp. */
export function EndOfFeed({ date, count }: { date: string; count: number }) {
  const label =
    date === todayVN()
      ? strings.format.today.toLocaleLowerCase("vi")
      : (dayLabel(date).split(",")[0]?.toLocaleLowerCase("vi") ?? date);
  return (
    <div className="fd-end">
      <div>{strings.feed.end(label, count)}</div>
      <div>{strings.feed.endHint}</div>
    </div>
  );
}
