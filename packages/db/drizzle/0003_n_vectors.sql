ALTER TABLE "events" ADD COLUMN "n_vectors" integer DEFAULT 1 NOT NULL;--> statement-breakpoint

-- Existing events: recount the vectors contributed to the centroid (seed + merged by vector), drop the merge for the same URL.
-- Centroids of these events were computed with n_docs weights (may be off); `layer2 recluster` rebuilds them correctly.
UPDATE "events" e
   SET "n_vectors" = c.n
  FROM (SELECT "event_id", count(*)::int AS n
          FROM "event_documents"
         WHERE "reason" IN ('seed', 'vector')
         GROUP BY "event_id") c
 WHERE c."event_id" = e."id";
