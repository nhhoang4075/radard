CREATE TABLE "candidate_pool" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "candidate_pool_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"profile_id" integer NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"event_id" bigint NOT NULL,
	"url_canonicals" text[] NOT NULL,
	"source_id" integer NOT NULL,
	"r" double precision NOT NULL,
	"p" double precision NOT NULL,
	"c" double precision NOT NULL,
	"a" double precision NOT NULL,
	"f" double precision NOT NULL,
	"n" double precision NOT NULL,
	"u" double precision,
	"score" double precision NOT NULL,
	"penalty" double precision,
	"selected" boolean NOT NULL,
	"reject_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidate_pool" ADD CONSTRAINT "candidate_pool_profile_id_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_pool_once_uq" ON "candidate_pool" USING btree ("profile_id","period_end","event_id");--> statement-breakpoint
CREATE INDEX "candidate_pool_profile_idx" ON "candidate_pool" USING btree ("profile_id","period_end");