/** Xem trước trang Feed (dữ liệu giả) không cần đăng nhập, chỉ dev: /_design/feed. */
import { useEffect, useState } from "react";
import { FeedPage, type FeedSearch } from "../features/feed/feed-page.tsx";
import { fixtureClient } from "../features/feed/fixtures.ts";
import { fetchClient, setFeedClient } from "../lib/feed-client.ts";
import { strings } from "../lib/strings.vi.ts";
import { AppShell } from "../shell/app-shell.tsx";

export function FeedPreview() {
  const [search, setSearch] = useState<FeedSearch>({});
  // Dữ liệu giả chỉ trong trang này; rời trang thì trả về client thật.
  setFeedClient({ ...fetchClient, ...fixtureClient });
  useEffect(() => () => setFeedClient(fetchClient), []);
  return (
    <AppShell crumb={strings.nav.items.feed}>
      <FeedPage search={search} onSearch={setSearch} />
    </AppShell>
  );
}
