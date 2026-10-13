CREATE TABLE "documents" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "documents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"url_canonical" text NOT NULL,
	"title" text,
	"lang" text,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_sha256" text NOT NULL,
	"raw_key" text NOT NULL,
	"content_type" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "documents_source_external_uq" UNIQUE("source_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "fetch_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fetch_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_id" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"http_status" integer,
	"n_fetched" integer DEFAULT 0 NOT NULL,
	"n_new" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "source_state" (
	"source_id" integer PRIMARY KEY NOT NULL,
	"state" jsonb,
	"last_ok_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"fail_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sources_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cadence" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"default_role" text DEFAULT 'community' NOT NULL,
	"trust_score" real DEFAULT 0.5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fetch_runs" ADD CONSTRAINT "fetch_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_state" ADD CONSTRAINT "source_state_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_sha_idx" ON "documents" USING btree ("content_sha256");--> statement-breakpoint
CREATE INDEX "documents_url_idx" ON "documents" USING btree ("url_canonical");--> statement-breakpoint
CREATE INDEX "documents_fetched_idx" ON "documents" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "fetch_runs_source_started_idx" ON "fetch_runs" USING btree ("source_id","started_at");