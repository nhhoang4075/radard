CREATE TABLE "deliveries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"digest_id" bigint,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"message_id" text NOT NULL,
	"kind" text NOT NULL,
	"position" bigint,
	"event_id" bigint,
	"document_ids" bigint[] DEFAULT '{}' NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_kind_ck" CHECK ("deliveries"."kind" in ('header', 'event'))
);
--> statement-breakpoint
CREATE TABLE "digests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "digests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'sending' NOT NULL,
	"lang" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "digests_status_ck" CHECK ("digests"."status" in ('sending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feedback_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"delivery_id" bigint,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"kind" text NOT NULL,
	"text" text,
	"source_message_id" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_kind_ck" CHECK ("feedback"."kind" in ('like', 'dislike', 'comment')),
	CONSTRAINT "feedback_text_ck" CHECK (("feedback"."kind" = 'comment') = ("feedback"."text" is not null and length("feedback"."text") > 0))
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_message_uq" ON "deliveries" USING btree ("channel","recipient","message_id");--> statement-breakpoint
CREATE INDEX "deliveries_digest_idx" ON "deliveries" USING btree ("digest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "digests_once_uq" ON "digests" USING btree ("channel","recipient","period_end");--> statement-breakpoint
CREATE INDEX "feedback_delivery_idx" ON "feedback" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "feedback_created_idx" ON "feedback" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_source_message_uq" ON "feedback" USING btree ("channel","recipient","source_message_id");