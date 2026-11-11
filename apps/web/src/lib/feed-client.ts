/**
 * Feed client: one interface; the real implementation uses `hc<AppType>` (typed). It can be swapped for fake data
 * (`setFeedClient(fixtureClient)`), used only for the dev preview page `/_design/feed` that needs no sign-in.
 */
import type {
  EventDetail,
  FeedbackKind,
  FeedDates,
  FeedPage,
  ForMe,
  ImpressionInput,
} from "../features/feed/types.ts";
import { ForMeError } from "../features/feed/types.ts";
import { api, HttpError } from "./api.ts";

export interface FeedClient {
  getFeed(q: { date?: string; cursor?: string | null }): Promise<FeedPage>;
  getDates(): Promise<FeedDates>;
  getEvent(eventId: number): Promise<EventDetail>;
  /** Tapping the selected button again makes the server clear it; returns the new state. */
  putFeedback(q: { feedItemId: number; kind: FeedbackKind }): Promise<"like" | "dislike" | "none">;
  postImpressions(batch: ImpressionInput[]): Promise<void>;
  forMe(eventId: number): Promise<ForMe>;
}

export const fetchClient: FeedClient = {
  async getFeed({ date, cursor }) {
    // limit=50 ≥ K (≤ 30): fetch the whole snapshot at once, so topic chips and the counts in the banner are usable right away.
    const res = await api.feed.$get({
      query: { limit: "50", ...(date ? { date } : {}), ...(cursor ? { cursor } : {}) },
    });
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  },
  async getDates() {
    const res = await api.feed.dates.$get();
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  },
  async getEvent(eventId) {
    const res = await api.events[":id"].$get({ param: { id: String(eventId) } });
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  },
  async putFeedback(json) {
    const res = await api.feedback.$put({ json });
    if (!res.ok) throw new HttpError(res.status);
    return (await res.json()).state;
  },
  async postImpressions(items) {
    const res = await api.impressions.$post({ json: { items } });
    if (!res.ok) throw new HttpError(res.status);
  },
  async forMe(eventId) {
    const res = await api.events[":id"]["for-me"].$post({ param: { id: String(eventId) } });
    if (res.status === 429) throw new ForMeError("limit");
    if (res.status === 503) throw new ForMeError("unavailable");
    if (!res.ok) throw new ForMeError("other");
    return (await res.json()) as ForMe;
  },
};

let current: FeedClient = fetchClient;
export const getFeedClient = (): FeedClient => current;
export const setFeedClient = (c: FeedClient): void => {
  current = c;
};
