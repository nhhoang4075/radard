/** Preview of the Feed page (fake data) without sign-in, dev only: /_design/feed. */
import { useEffect, useState } from "react";
import { FeedPage, type FeedSearch } from "../features/feed/feed-page.tsx";
import { fixtureClient } from "../features/feed/fixtures.ts";
import { fetchClient, setFeedClient } from "../lib/feed-client.ts";
import { strings } from "../lib/strings.vi.ts";
import { AppShell } from "../shell/app-shell.tsx";

export function FeedPreview() {
  const [search, setSearch] = useState<FeedSearch>({});
  // Fake data only on this page; leaving the page returns to the real client.
  setFeedClient({ ...fetchClient, ...fixtureClient });
  useEffect(() => () => setFeedClient(fetchClient), []);
  return (
    <AppShell crumb={strings.nav.items.feed}>
      <FeedPage search={search} onSearch={setSearch} />
    </AppShell>
  );
}
