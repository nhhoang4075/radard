export const queryKeys = {
  me: ["me"] as const,
  providers: ["providers"] as const,
  feed: (date: string | undefined) => ["feed", date ?? "latest"] as const,
  feedDates: ["feed-dates"] as const,
  event: (id: number) => ["event", id] as const,
  forMe: (id: number) => ["for-me", id] as const,
};
