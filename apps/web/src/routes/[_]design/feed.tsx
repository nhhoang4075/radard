import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Preview = import.meta.env.DEV
  ? lazy(() => import("../../_design/feed-preview.tsx").then((m) => ({ default: m.FeedPreview })))
  : null;

export const Route = createFileRoute("/_design/feed")({
  component: () =>
    Preview ? (
      <Suspense fallback={null}>
        <Preview />
      </Suspense>
    ) : null,
});
