ALTER TABLE "profile_topics" DROP CONSTRAINT "profile_topics_origin_ck";--> statement-breakpoint
ALTER TABLE "profile_topics" DROP CONSTRAINT "profile_topics_topic_id_topics_id_fk";
--> statement-breakpoint
ALTER TABLE "baselines" DROP CONSTRAINT "baselines_profile_topic_id_profile_topics_id_fk";
--> statement-breakpoint
ALTER TABLE "doc_topic_scores" DROP CONSTRAINT "doc_topic_scores_profile_topic_id_profile_topics_id_fk";
--> statement-breakpoint
DROP INDEX "profile_topics_library_uq";--> statement-breakpoint
DROP INDEX "profile_topics_label_uq";--> statement-breakpoint
DROP INDEX "baselines_key_uq";--> statement-breakpoint
DROP INDEX "doc_topic_scores_topic_idx";--> statement-breakpoint
ALTER TABLE "doc_topic_scores" DROP CONSTRAINT "doc_topic_scores_document_id_profile_topic_id_pk";--> statement-breakpoint
ALTER TABLE "profile_topics" ALTER COLUMN "topic_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_topic_scores" ALTER COLUMN "topic_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_topic_scores" ADD CONSTRAINT "doc_topic_scores_document_id_topic_id_pk" PRIMARY KEY("document_id","topic_id");--> statement-breakpoint
ALTER TABLE "profile_topics" ADD CONSTRAINT "profile_topics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_topics_topic_uq" ON "profile_topics" USING btree ("profile_id","topic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "baselines_key_uq" ON "baselines" USING btree ("metric",coalesce("source_id", 0),coalesce("topic_id", 0));--> statement-breakpoint
CREATE INDEX "doc_topic_scores_topic_idx" ON "doc_topic_scores" USING btree ("topic_id");--> statement-breakpoint
ALTER TABLE "profile_topics" DROP COLUMN "label";--> statement-breakpoint
ALTER TABLE "profile_topics" DROP COLUMN "description_user";--> statement-breakpoint
ALTER TABLE "profile_topics" DROP COLUMN "description_en";--> statement-breakpoint
ALTER TABLE "profile_topics" DROP COLUMN "origin";--> statement-breakpoint
ALTER TABLE "profile_topics" DROP COLUMN "embedding";--> statement-breakpoint
ALTER TABLE "profile_topics" DROP COLUMN "embedding_model";--> statement-breakpoint
ALTER TABLE "baselines" DROP COLUMN "profile_topic_id";--> statement-breakpoint
ALTER TABLE "doc_topic_scores" DROP COLUMN "profile_topic_id";