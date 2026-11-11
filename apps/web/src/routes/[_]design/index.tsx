import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

// Dev only: the production build does not include this page (the DEV branch is stripped at build time).
const Catalog = import.meta.env.DEV
  ? lazy(() => import("../../_design/catalog.tsx").then((m) => ({ default: m.Catalog })))
  : null;

export const Route = createFileRoute("/_design/")({
  component: () =>
    Catalog ? (
      <Suspense fallback={null}>
        <Catalog />
      </Suspense>
    ) : null,
});
