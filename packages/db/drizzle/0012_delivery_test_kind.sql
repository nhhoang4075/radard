ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_kind_ck";--> statement-breakpoint
-- Tin thử cũ (notify test) từng ghi kind = 'event' với digest_id trống: chuyển sang 'test' trước khi
-- bật ràng buộc, để migration chạy được trên DB đã có tin thử.
UPDATE "deliveries" SET "kind" = 'test', "position" = NULL WHERE "digest_id" IS NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_shape_ck" CHECK (("deliveries"."kind" = 'test') = ("deliveries"."digest_id" is null)
        and ("deliveries"."kind" = 'event') = ("deliveries"."event_id" is not null)
        and ("deliveries"."digest_id" is null) = ("deliveries"."position" is null));--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_kind_ck" CHECK ("deliveries"."kind" in ('header', 'event', 'test'));