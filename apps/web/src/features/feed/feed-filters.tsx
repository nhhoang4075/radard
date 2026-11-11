import { dayLabel, todayVN } from "../../lib/format.ts";
import { strings } from "../../lib/strings.vi.ts";
import { Chip, MultiSelect, Select } from "../../ui/index.ts";

export type FeedScope = "digest" | "all";
const INLINE_TOPICS = 4;

/** Chọn ngày, phạm vi, chip chủ đề chọn nhiều (+N là select có ô tìm). Trạng thái nằm trên URL (do trang cha giữ). */
export function FeedFilters({
  dates,
  date,
  onDate,
  scope,
  onScope,
  topics,
  selected,
  onSelected,
}: {
  dates: string[];
  date: string;
  onDate(d: string): void;
  scope: FeedScope;
  onScope(s: FeedScope): void;
  topics: { id: number; name: string }[];
  selected: ReadonlySet<number>;
  onSelected(next: Set<number>): void;
}) {
  const f = strings.feed.filters;
  const today = todayVN();
  const dateOptions = (dates.includes(date) ? dates : [date, ...dates]).map((d) => ({
    value: d,
    label: dayLabel(d, today),
  }));
  const inline = topics.slice(0, INLINE_TOPICS);
  const rest = topics.slice(INLINE_TOPICS);
  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelected(next);
  };
  return (
    <div className="fd-filters" role="toolbar" aria-label={f.label}>
      <Select value={date} options={dateOptions} onChange={onDate} label={f.day} />
      <Select
        value={scope}
        options={[
          { value: "digest", label: f.scopeDigest },
          { value: "all", label: f.scopeAll },
        ]}
        onChange={onScope}
        label={f.scope}
      />
      <span className="fd-vsep" aria-hidden="true" />
      <Chip pressed={selected.size === 0} onClick={() => onSelected(new Set())}>
        {f.topicAll}
      </Chip>
      {inline.map((t) => (
        <Chip key={t.id} pressed={selected.has(t.id)} onClick={() => toggle(t.id)}>
          {t.name}
        </Chip>
      ))}
      {rest.length > 0 ? (
        <MultiSelect
          values={new Set([...selected].filter((id) => rest.some((t) => t.id === id)).map(String))}
          options={rest.map((t) => ({ value: String(t.id), label: t.name }))}
          onChange={(next) => {
            const keep = [...selected].filter((id) => !rest.some((t) => t.id === id));
            onSelected(new Set([...keep, ...[...next].map(Number)]));
          }}
          triggerLabel={f.more(rest.length)}
          searchPlaceholder={f.searchTopic}
          emptyLabel={f.noTopic}
        />
      ) : null}
    </div>
  );
}
