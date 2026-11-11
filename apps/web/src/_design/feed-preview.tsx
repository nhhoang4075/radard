/** Xem trước trang Feed (dữ liệu giả) không cần đăng nhập, chỉ dev: /_design/feed. */
import { useState } from "react";
import { FeedPage, type FeedSearch } from "../features/feed/feed-page.tsx";
import { strings } from "../lib/strings.vi.ts";
import { AppShell } from "../shell/app-shell.tsx";

export function FeedPreview() {
  const [search, setSearch] = useState<FeedSearch>({});
  return (
    <AppShell crumb={strings.nav.items.feed}>
      <FeedPage search={search} onSearch={setSearch} />
    </AppShell>
  );
}
