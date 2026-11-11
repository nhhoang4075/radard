import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

// Dev only: the production build does not include the /_design/* pages.
export const Route = createFileRoute("/_design")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: Outlet,
});
