CREATE TABLE "repo_stats" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repo_stats_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"repo" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stars" integer NOT NULL,
	"forks" integer,
	"source" text NOT NULL,
	"reported_gain" integer,
	CONSTRAINT "repo_stats_source_ck" CHECK ("repo_stats"."source" in ('github_stars', 'trending_daily'))
);
--> statement-breakpoint
CREATE INDEX "repo_stats_repo_observed_idx" ON "repo_stats" USING btree ("repo","observed_at");