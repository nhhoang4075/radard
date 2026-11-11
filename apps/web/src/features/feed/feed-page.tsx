import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { HttpError } from "../../lib/api.ts";
import { todayVN } from "../../lib/format.ts";
import { queryKeys } from "../../lib/query-keys.ts";
import { strings } from "../../lib/strings.vi.ts";
import { safeUrl } from "../../lib/url.ts";
import { ShellPanel, useShellPanel } from "../../shell/app-shell.tsx";
import { Button, Skeleton, State } from "../../ui/index.ts";
import { EndOfFeed } from "./end-of-feed.tsx";
import { EventCard } from "./event-card.tsx";
import { EventDetailPanel } from "./event-detail.tsx";
import { FeedFilters, type FeedScope } from "./feed-filters.tsx";
import "./feed.css";
import { TodayBanner } from "./today-banner.tsx";
import type { EventDetail, FeedItem } from "./types.ts";
import { useFeed, useFeedDates } from "./use-feed.ts";
import { useFeedKeys } from "./use-feed-keys.ts";
import { useImpressions } from "./use-impressions.ts";

export type FeedSearch = { date?: string; scope?: FeedScope; topics?: string[]; item?: number };

export function FeedPage({
  search,
  onSearch,
}: {
  search: FeedSearch;
  onSearch(next: FeedSearch): void;
}) {
  const qc = useQueryClient();
  const today = todayVN();
  const dates = useFeedDates();
  const feed = useFeed(search.date);
  const panel = useShellPanel();
  const sentinel = useRef<HTMLDivElement>(null);

  const scope: FeedScope = search.scope ?? "all";
  const selectedTopics = useMemo(() => new Set(search.topics ?? []), [search.topics]);
  const pages = feed.data?.pages ?? [];
  const first = pages[0];
  const all: FeedItem[] = useMemo(() => pages.flatMap((p) => p.items), [pages]);
  const date = first?.date ?? search.date ?? today;
  const fullyLoaded = feed.isSuccess && !feed.hasNextPage;

  const topics = useMemo(() => [...new Set(all.flatMap((i) => (i.topic ? [i.topic] : [])))], [all]);

  const visible = useMemo(
    () =>
      all.filter(
        (i) =>
          (scope === "all" || i.inDigest) &&
          (selectedTopics.size === 0 || (i.topic !== null && selectedTopics.has(i.topic))),
      ),
    [all, scope, selectedTopics],
  );
  const filtering = scope !== "all" || selectedTopics.size > 0;

  // Lọc ở client cần đủ K tin (K ≤ 30): khi có bộ lọc thì tải nốt các trang còn lại.
  useEffect(() => {
    if (filtering && feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
  }, [filtering, feed.hasNextPage, feed.isFetchingNextPage, feed.fetchNextPage]);

  // Cuộn tới đáy thì tải trang kế (con trỏ).
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !feed.hasNextPage) return;
    const io = new IntersectionObserver((e) => {
      if (e[0]?.isIntersecting && !feed.isFetchingNextPage) void feed.fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [feed.hasNextPage, feed.isFetchingNextPage, feed.fetchNextPage]);

  const selected = visible.find((i) => i.feedItemId === search.item) ?? null;
  const select = (id: number | undefined) => {
    onSearch({ ...search, ...(id === undefined ? { item: undefined } : { item: id }) });
    panel.setOpen(id !== undefined);
  };
  const move = (d: 1 | -1) => {
    if (visible.length === 0) return;
    const idx = selected ? visible.indexOf(selected) : -1;
    const next = visible[Math.min(Math.max(idx + d, 0), visible.length - 1)];
    if (next) select(next.feedItemId);
  };
  useFeedKeys({
    next: () => move(1),
    prev: () => move(-1),
    open: () => {
      const url = selected
        ? safeUrl(qc.getQueryData<EventDetail>(queryKeys.event(selected.eventId))?.docs[0]?.url)
        : undefined;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    },
  });

  const observe = useImpressions(first?.snapshotId);
  const dateList = dates.data?.dates.map((d) => d.date) ?? [];
  const noSnapshot = feed.isError && feed.error instanceof HttpError && feed.error.status === 404;
  // Bản chụp hôm nay vừa có (hỏi lại 5 giây của danh sách ngày thấy nó): tải lại Feed đang báo 404.
  const hasToday = dateList.includes(today);
  useEffect(() => {
    if (noSnapshot && hasToday) void feed.refetch();
  }, [noSnapshot, hasToday, feed.refetch]);
  const waitingToday = (search.date === undefined || search.date === today) && !hasToday;

  const setSearch = (patch: Partial<FeedSearch>) =>
    onSearch({ ...search, ...patch, item: undefined });

  return (
    <div className="fd-page">
      <TodayBanner
        date={date}
        total={first?.total ?? 0}
        digestCount={fullyLoaded ? all.filter((i) => i.inDigest).length : null}
        topicCount={fullyLoaded ? topics.length : null}
      />
      <FeedFilters
        dates={dateList}
        date={date}
        onDate={(d) => setSearch({ date: d === today ? undefined : d })}
        scope={scope}
        onScope={(s) => setSearch({ scope: s === "all" ? undefined : s })}
        topics={topics}
        selected={selectedTopics}
        onSelected={(next) => setSearch({ topics: next.size ? [...next] : undefined })}
      />

      {feed.isPending ? (
        <div className="fd-list" aria-busy="true">
          {[0, 1, 2].map((k) => (
            <div key={k} className="fd-item fd-skel">
              <Skeleton width="60%" height="16px" style={{ marginBottom: 12 }} />
              <Skeleton width="92%" style={{ marginBottom: 8 }} />
              <Skeleton width="75%" />
            </div>
          ))}
        </div>
      ) : null}

      {feed.isError && !noSnapshot ? (
        <State title={strings.feed.loadError}>
          <Button variant="secondary" size="sm" onClick={() => void feed.refetch()}>
            {strings.feed.retry}
          </Button>
        </State>
      ) : null}
      {noSnapshot && waitingToday ? (
        <State title={strings.feed.waiting.title}>{strings.feed.waiting.body}</State>
      ) : null}
      {noSnapshot && !waitingToday ? (
        <State title={strings.feed.noSnapshot.title}>{strings.feed.noSnapshot.body}</State>
      ) : null}
      {feed.isSuccess && all.length > 0 && visible.length === 0 && !feed.hasNextPage ? (
        <State>{strings.feed.noMatch}</State>
      ) : null}

      <div className="fd-list">
        {visible.map((i) => (
          <EventCard
            key={i.feedItemId}
            item={i}
            selected={i === selected}
            onSelect={() => select(i.feedItemId)}
            innerRef={observe(i.position)}
          />
        ))}
      </div>
      <div ref={sentinel} aria-hidden="true" />
      {fullyLoaded && all.length > 0 ? <EndOfFeed date={date} count={visible.length} /> : null}

      <ShellPanel>
        <EventDetailPanel item={selected} onClose={() => select(undefined)} />
      </ShellPanel>
    </div>
  );
}
