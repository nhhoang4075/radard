import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

// Chỉ dev: bản build production không có các trang /_design/*.
export const Route = createFileRoute("/_design")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: Outlet,
});
