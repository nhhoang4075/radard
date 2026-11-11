ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_kind_ck";--> statement-breakpoint
-- Old test messages (notify test) once wrote kind = 'event' with an empty digest_id: switch them to 'test' before
-- enabling the constraint, so the migration can run on a DB that already has test messages.
UPDATE "deliveries" SET "kind" = 'test', "position" = NULL WHERE "digest_id" IS NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_shape_ck" CHECK (("deliveries"."kind" = 'test') = ("deliveries"."digest_id" is null)
        and ("deliveries"."kind" = 'event') = ("deliveries"."event_id" is not null)
        and ("deliveries"."digest_id" is null) = ("deliveries"."position" is null));--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_kind_ck" CHECK ("deliveries"."kind" in ('header', 'event', 'test'));