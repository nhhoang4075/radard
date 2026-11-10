CREATE TABLE "profile_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile_id" integer NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_channels_recipient_uq" UNIQUE("channel","recipient")
);
--> statement-breakpoint
DROP INDEX "digests_once_uq";--> statement-breakpoint
ALTER TABLE "profile_channels" ADD CONSTRAINT "profile_channels_profile_id_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "digests_once_uq" ON "digests" USING btree ("profile_id","channel","recipient","period_end");