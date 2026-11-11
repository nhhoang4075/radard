-- Rename columns by purpose: `description` is always the human-written text; machine-used columns state what they are for.
-- Postgres itself renames the columns inside indexes and check constraints (topics_custom_label_uq, topics_source_ck).
ALTER TABLE "topics" RENAME COLUMN "label_vi" TO "name";--> statement-breakpoint
ALTER TABLE "topics" RENAME COLUMN "group_vi" TO "group_name";--> statement-breakpoint
ALTER TABLE "topics" RENAME COLUMN "description_user" TO "description";--> statement-breakpoint
ALTER TABLE "topics" RENAME COLUMN "description_en" TO "embed_text";--> statement-breakpoint
ALTER TABLE "topics" RENAME COLUMN "scope_note" TO "label_guide";--> statement-breakpoint
ALTER TABLE "profile" RENAME COLUMN "description" TO "prompt_context";--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "description" text;
