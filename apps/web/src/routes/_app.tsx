import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { requireSession, SessionError } from "../features/auth/require-session.tsx";
import { useSession } from "../features/auth/use-session.ts";
import { authClient } from "../lib/api.ts";
import { strings } from "../lib/strings.vi.ts";
import { AppShell } from "../shell/app-shell.tsx";
import { Button } from "../ui/index.ts";

// Khung đã đăng nhập: app shell + chân sidebar (tên, đăng xuất). Trang con render trong <Outlet/>.
function Layout() {
  const { data } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const onSignOut = async () => {
    await authClient.signOut();
    queryClient.clear(); // bỏ dữ liệu đã lưu đệm của người vừa đăng xuất
    await navigate({ to: "/login" });
  };
  return (
    <AppShell
      crumb={strings.nav.items.feed}
      sidebarFooter={
        <>
          <div>{data?.name ?? ""}</div>
          <Button variant="ghost" size="sm" onClick={() => void onSignOut()}>
            {strings.home.signOut}
          </Button>
        </>
      }
    >
      <Outlet />
    </AppShell>
  );
}

export const Route = createFileRoute("/_app")({
  beforeLoad: ({ context }) => requireSession(context.queryClient),
  errorComponent: SessionError,
  component: Layout,
});
