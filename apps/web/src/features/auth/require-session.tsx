import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { authClient, HttpError } from "../../lib/api.ts";
import { strings } from "../../lib/strings.vi.ts";
import { Button } from "../../ui/index.ts";
import "./auth.css";
import { sessionQuery } from "./use-session.ts";

/**
 * `beforeLoad` cho route cần đăng nhập: chưa có phiên (401) → trang đăng nhập. Lỗi khác (kể cả 403,
 * chưa có hồ sơ) được ném tiếp để `errorComponent` của route xử lý.
 */
export async function requireSession(queryClient: QueryClient) {
  try {
    await queryClient.ensureQueryData(sessionQuery);
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) throw redirect({ to: "/login" });
    throw err;
  }
}

/** Lỗi của route cần đăng nhập: 403 hiện thông báo chưa có hồ sơ, còn lại báo lỗi chung. */
export function SessionError({ error }: { error: unknown }) {
  const noProfile = error instanceof HttpError && error.status === 403;
  return (
    <main className="auth-page">
      <h1>{strings.appName}</h1>
      <p role="alert" className="auth-error">
        {noProfile ? strings.noProfile : strings.genericError}
      </p>
      {noProfile ? (
        <Button
          variant="secondary"
          onClick={() => void authClient.signOut().then(() => location.assign("/login"))}
        >
          {strings.home.signOut}
        </Button>
      ) : null}
    </main>
  );
}
