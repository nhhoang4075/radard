CREATE TABLE "feed_impressions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feed_impressions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"profile_id" integer NOT NULL,
	"snapshot_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_impressions_once_uq" UNIQUE("snapshot_id","position")
);
--> statement-breakpoint
CREATE TABLE "feed_items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feed_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"profile_id" integer NOT NULL,
	"snapshot_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"event_id" bigint NOT NULL,
	"document_ids" bigint[] DEFAULT '{}' NOT NULL,
	"source_id" integer NOT NULL,
	"topic_id" integer,
	"title" text NOT NULL,
	"score" double precision NOT NULL,
	"penalty" double precision NOT NULL,
	"r" double precision NOT NULL,
	"p" double precision NOT NULL,
	"c" double precision NOT NULL,
	"a" double precision NOT NULL,
	"f" double precision NOT NULL,
	"u" double precision NOT NULL,
	"n" double precision NOT NULL,
	"reserved" boolean NOT NULL,
	"notify_position" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_items_position_uq" UNIQUE("snapshot_id","position"),
	CONSTRAINT "feed_items_event_uq" UNIQUE("snapshot_id","event_id"),
	CONSTRAINT "feed_items_id_owner_uq" UNIQUE("id","profile_id"),
	CONSTRAINT "feed_items_owner_uq" UNIQUE("profile_id","snapshot_id","position"),
	CONSTRAINT "feed_items_position_ck" CHECK ("feed_items"."position" >= 1),
	CONSTRAINT "feed_items_notify_ck" CHECK ("feed_items"."notify_position" is null or "feed_items"."notify_position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "feed_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feed_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"profile_id" integer NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"select_seed" bigint NOT NULL,
	"item_count" integer,
	"feed_floor" double precision,
	"notify_floor" double precision,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"built_at" timestamp with time zone,
	CONSTRAINT "feed_snapshots_once_uq" UNIQUE("profile_id","period_end"),
	CONSTRAINT "feed_snapshots_owner_uq" UNIQUE("id","profile_id"),
	CONSTRAINT "feed_snapshots_status_ck" CHECK ("feed_snapshots"."status" in ('building', 'ready')),
	CONSTRAINT "feed_snapshots_seed_ck" CHECK ("feed_snapshots"."select_seed" >= 0 and "feed_snapshots"."select_seed" < 4294967296)
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "feed_item_id" bigint;--> statement-breakpoint
ALTER TABLE "digests" ADD COLUMN "feed_snapshot_id" bigint;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "feed_item_id" bigint;--> statement-breakpoint
ALTER TABLE "feed_impressions" ADD CONSTRAINT "feed_impressions_item_fk" FOREIGN KEY ("profile_id","snapshot_id","position") REFERENCES "public"."feed_items"("profile_id","snapshot_id","position") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_snapshot_fk" FOREIGN KEY ("snapshot_id","profile_id") REFERENCES "public"."feed_snapshots"("id","profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_snapshots" ADD CONSTRAINT "feed_snapshots_profile_id_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feed_impressions_profile_idx" ON "feed_impressions" USING btree ("profile_id","seen_at");--> statement-breakpoint
CREATE INDEX "feed_items_profile_idx" ON "feed_items" USING btree ("profile_id","snapshot_id");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_feed_item_fk" FOREIGN KEY ("feed_item_id","profile_id") REFERENCES "public"."feed_items"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_feed_snapshot_fk" FOREIGN KEY ("feed_snapshot_id","profile_id") REFERENCES "public"."feed_snapshots"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_feed_item_fk" FOREIGN KEY ("feed_item_id","profile_id") REFERENCES "public"."feed_items"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_feed_item_idx" ON "feedback" USING btree ("feed_item_id");