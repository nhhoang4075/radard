import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { authClient, HttpError } from "../../lib/api.ts";
import { strings } from "../../lib/strings.vi.ts";
import { Button } from "../../ui/index.ts";
import "./auth.css";
import { sessionQuery } from "./use-session.ts";

/**
 * `beforeLoad` for routes that need sign-in: no session (401) → sign-in page. Other errors (including 403,
 * no profile yet) are rethrown so the route's `errorComponent` handles them.
 */
export async function requireSession(queryClient: QueryClient) {
  try {
    await queryClient.ensureQueryData(sessionQuery);
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) throw redirect({ to: "/login" });
    throw err;
  }
}

/** Error for routes that need sign-in: 403 shows the no-profile message, otherwise a generic error. */
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
