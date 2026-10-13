ALTER TABLE "profile_topics" DROP CONSTRAINT "profile_topics_source_ck";--> statement-breakpoint
ALTER TABLE "topics" ALTER COLUMN "key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "topics" ALTER COLUMN "group_vi" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "description_user" text;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "origin" text DEFAULT 'library' NOT NULL;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "owner_profile_id" integer;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "embedding" halfvec(1024);--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "baselines" ADD COLUMN "topic_id" bigint;--> statement-breakpoint
ALTER TABLE "doc_topic_scores" ADD COLUMN "topic_id" bigint;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_owner_profile_id_profile_id_fk" FOREIGN KEY ("owner_profile_id") REFERENCES "public"."profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_topic_scores" ADD CONSTRAINT "doc_topic_scores_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Chuyển dữ liệu sang mô hình mới (13/10/2026): embedding nằm ở `topics`, chủ đề tự thêm thành một dòng
-- `topics`, điểm và mặt bằng khoá theo `topic_id`. Cột cũ bỏ ở migration 0014.
-- 1. Embedding của chủ đề thư viện đã chọn chuyển sang `topics`.
UPDATE "topics" t SET "embedding" = pt."embedding", "embedding_model" = pt."embedding_model"
FROM "profile_topics" pt WHERE pt."topic_id" = t."id" AND pt."embedding" IS NOT NULL;--> statement-breakpoint
-- 2. Chủ đề tự thêm thành dòng `topics` của hồ sơ, rồi `profile_topics` trỏ về dòng đó.
ALTER TABLE "topics" ADD COLUMN "legacy_profile_topic_id" bigint;--> statement-breakpoint
INSERT INTO "topics" ("label_vi", "description_en", "description_user", "origin", "owner_profile_id", "embedding", "embedding_model", "legacy_profile_topic_id")
SELECT "label", "description_en", "description_user", 'custom', "profile_id", "embedding", "embedding_model", "id"
FROM "profile_topics" WHERE "origin" = 'custom';--> statement-breakpoint
UPDATE "profile_topics" pt SET "topic_id" = t."id" FROM "topics" t WHERE t."legacy_profile_topic_id" = pt."id";--> statement-breakpoint
ALTER TABLE "topics" DROP COLUMN "legacy_profile_topic_id";--> statement-breakpoint
-- 3. Điểm và mặt bằng giữ nguyên giá trị, chỉ đổi khoá sang `topic_id`.
UPDATE "doc_topic_scores" s SET "topic_id" = pt."topic_id" FROM "profile_topics" pt WHERE pt."id" = s."profile_topic_id";--> statement-breakpoint
UPDATE "baselines" b SET "topic_id" = pt."topic_id" FROM "profile_topics" pt WHERE pt."id" = b."profile_topic_id";--> statement-breakpoint
CREATE UNIQUE INDEX "topics_custom_label_uq" ON "topics" USING btree ("owner_profile_id",lower("label_vi")) WHERE "topics"."origin" = 'custom';--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_origin_ck" CHECK ("topics"."origin" in ('library', 'custom'));--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_source_ck" CHECK (("topics"."origin" = 'library') = ("topics"."key" is not null)
        and ("topics"."origin" = 'library') = ("topics"."owner_profile_id" is null)
        and ("topics"."origin" = 'library' or "topics"."description_user" is not null));