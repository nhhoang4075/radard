import { createFileRoute } from "@tanstack/react-router";
import { strings } from "../../lib/strings.vi.ts";
import { State } from "../../ui/index.ts";

// Trang Feed: làm ở đợt sau. Hiện là trạng thái trống để kiểm khung.
export const Route = createFileRoute("/_app/")({
  component: () => <State title={strings.nav.items.feed}>{strings.home.hello("")}</State>,
});
