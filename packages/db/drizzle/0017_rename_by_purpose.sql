-- Đổi tên cột theo mục đích dùng: `description` luôn là chữ người viết, cột máy dùng thì nói rõ dùng để làm gì.
-- Postgres tự đổi tên cột bên trong index và check constraint (topics_custom_label_uq, topics_source_ck).
ALTER TABLE "topics" RENAME COLUMN "label_vi" TO "name";--> statement-breakpoint
ALTER TABLE "topics" RENAME COLUMN "group_vi" TO "group_name";--> statement-breakpoint
ALTER TABLE "topics" RENAME COLUMN "description_user" TO "description";--> statement-breakpoint
ALTER TABLE "topics" RENAME COLUMN "description_en" TO "embed_text";--> statement-breakpoint
ALTER TABLE "topics" RENAME COLUMN "scope_note" TO "label_guide";--> statement-breakpoint
ALTER TABLE "profile" RENAME COLUMN "description" TO "prompt_context";--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "description" text;
