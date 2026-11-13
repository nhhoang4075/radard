/** Xem trước trang Feed (dữ liệu giả) không cần đăng nhập, chỉ dev: /_design/feed. */
import { useEffect, useState } from "react";
import { FeedPage, type FeedSearch } from "../features/feed/feed-page.tsx";
import { fixtureClient } from "../features/feed/fixtures.ts";
import { fetchClient, setFeedClient } from "../lib/feed-client.ts";
import { strings } from "../lib/strings.vi.ts";
import { AppShell } from "../shell/app-shell.tsx";

export function FeedPreview() {
  const [search, setSearch] = useState<FeedSearch>({});
  // Fixtures only on this page. Set during render so the first queries use them, and again in the effect
  // because StrictMode runs the cleanup (restoring the real client) between the two effect passes.
  const preview = { ...fetchClient, ...fixtureClient };
  setFeedClient(preview);
  useEffect(() => {
    setFeedClient(preview);
    return () => setFeedClient(fetchClient);
  });
  return (
    <AppShell crumb={strings.nav.items.feed}>
      <FeedPage search={search} onSearch={setSearch} />
    </AppShell>
  );
}
