import { createFileRoute, redirect } from "@tanstack/react-router";
import { LoginPage } from "../features/auth/login-page.tsx";
import { sessionQuery } from "../features/auth/use-session.ts";

export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>): { error?: string } =>
    typeof s.error === "string" ? { error: s.error } : {},
  // Already have a session and profile: go straight to the main page.
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(sessionQuery).catch(() => null);
    if (me) throw redirect({ to: "/" });
  },
  component: () => <LoginPage error={Route.useSearch().error} />,
});
