ALTER TABLE "events" ADD COLUMN "n_vectors" integer DEFAULT 1 NOT NULL;--> statement-breakpoint

-- Sự kiện đã có: đếm lại số vector đã góp vào tâm (seed + gộp theo vector), bỏ gộp vì cùng URL.
-- Tâm của các sự kiện này đã tính với trọng số n_docs (có thể lệch); `layer2 recluster` dựng lại đúng.
UPDATE "events" e
   SET "n_vectors" = c.n
  FROM (SELECT "event_id", count(*)::int AS n
          FROM "event_documents"
         WHERE "reason" IN ('seed', 'vector')
         GROUP BY "event_id") c
 WHERE c."event_id" = e."id";
