CREATE TABLE "event_for_profile" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_for_profile_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"profile_id" integer NOT NULL,
	"event_id" bigint NOT NULL,
	"lang" text NOT NULL,
	"context_hash" text NOT NULL,
	"text" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_for_profile_uq" UNIQUE("profile_id","event_id","lang","context_hash")
);
--> statement-breakpoint
CREATE TABLE "event_summaries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_summaries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_id" bigint NOT NULL,
	"lang" text NOT NULL,
	"docs_hash" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_summaries_uq" UNIQUE("event_id","lang","docs_hash")
);
--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "summary_id" bigint;--> statement-breakpoint
ALTER TABLE "event_for_profile" ADD CONSTRAINT "event_for_profile_profile_id_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_for_profile_quota_idx" ON "event_for_profile" USING btree ("profile_id","created_at");--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_summary_id_event_summaries_id_fk" FOREIGN KEY ("summary_id") REFERENCES "public"."event_summaries"("id") ON DELETE set null ON UPDATE no action;