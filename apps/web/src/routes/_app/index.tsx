import { createFileRoute } from "@tanstack/react-router";
import { FeedPage, type FeedSearch } from "../../features/feed/feed-page.tsx";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Trạng thái Feed nằm trên URL: ?date=&scope=&topics=&item=
function validateSearch(s: Record<string, unknown>): FeedSearch {
  const topics = Array.isArray(s.topics)
    ? s.topics
        .filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 100)
        .slice(0, 20)
    : [];
  const item = Number(s.item);
  return {
    ...(typeof s.date === "string" && DATE.test(s.date) ? { date: s.date } : {}),
    ...(s.scope === "digest" ? { scope: "digest" as const } : {}),
    ...(topics.length ? { topics } : {}),
    ...(Number.isInteger(item) && item > 0 ? { item } : {}),
  };
}

function FeedRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <FeedPage search={search} onSearch={(next) => void navigate({ search: next, replace: true })} />
  );
}

export const Route = createFileRoute("/_app/")({ validateSearch, component: FeedRoute });
