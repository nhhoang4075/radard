import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { requireSession, SessionError } from "../features/auth/require-session.tsx";
import { useSession } from "../features/auth/use-session.ts";
import { authClient } from "../lib/api.ts";
import { strings } from "../lib/strings.vi.ts";

// Trang trống sau đăng nhập (placeholder): tên người dùng và nút đăng xuất. Feed làm ở đợt sau.
function HomePage() {
  const { data } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const onSignOut = async () => {
    await authClient.signOut();
    queryClient.clear(); // bỏ dữ liệu đã lưu đệm của người vừa đăng xuất
    await navigate({ to: "/login" });
  };
  return (
    <main className="page">
      <h1>{strings.appName}</h1>
      <p>{strings.home.hello(data?.name ?? "")}</p>
      <button type="button" onClick={() => void onSignOut()}>
        {strings.home.signOut}
      </button>
    </main>
  );
}

export const Route = createFileRoute("/")({
  beforeLoad: ({ context }) => requireSession(context.queryClient),
  errorComponent: SessionError,
  component: HomePage,
});
