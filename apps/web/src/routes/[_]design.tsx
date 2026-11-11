import { createFileRoute, notFound } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

// Chỉ dev: bản build production không có trang này (nhánh DEV bị loại khi build).
const Catalog = import.meta.env.DEV
  ? lazy(() => import("../_design/catalog.tsx").then((m) => ({ default: m.Catalog })))
  : null;

export const Route = createFileRoute("/_design")({
  beforeLoad: () => {
    if (!Catalog) throw notFound();
  },
  component: () =>
    Catalog ? (
      <Suspense fallback={null}>
        <Catalog />
      </Suspense>
    ) : null,
});
