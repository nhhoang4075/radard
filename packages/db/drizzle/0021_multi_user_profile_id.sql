-- Gắn người nhận với hồ sơ. Thêm cột cho phép trống, điền các dòng cũ bằng hồ sơ hiện có (hiện chỉ
-- có một người dùng; không có dòng profile thì dùng 1), rồi mới đặt NOT NULL và khoá ngoại.
ALTER TABLE "deliveries" ADD COLUMN "profile_id" integer;--> statement-breakpoint
ALTER TABLE "digests" ADD COLUMN "profile_id" integer;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "profile_id" integer;--> statement-breakpoint
UPDATE "deliveries" SET "profile_id" = coalesce((SELECT "id" FROM "profile" ORDER BY "id" LIMIT 1), 1) WHERE "profile_id" IS NULL;--> statement-breakpoint
UPDATE "digests" SET "profile_id" = coalesce((SELECT "id" FROM "profile" ORDER BY "id" LIMIT 1), 1) WHERE "profile_id" IS NULL;--> statement-breakpoint
UPDATE "feedback" SET "profile_id" = coalesce((SELECT "id" FROM "profile" ORDER BY "id" LIMIT 1), 1) WHERE "profile_id" IS NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ALTER COLUMN "profile_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "digests" ALTER COLUMN "profile_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback" ALTER COLUMN "profile_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_profile_id_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_profile_id_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_profile_id_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliveries_profile_idx" ON "deliveries" USING btree ("profile_id","kind","sent_at");--> statement-breakpoint
CREATE INDEX "digests_profile_idx" ON "digests" USING btree ("profile_id","period_end");--> statement-breakpoint
CREATE INDEX "feedback_profile_idx" ON "feedback" USING btree ("profile_id","created_at");
