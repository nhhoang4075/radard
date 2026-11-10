CREATE TABLE "interest_clusters" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "interest_clusters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"profile_id" integer NOT NULL,
	"position" integer NOT NULL,
	"status" text NOT NULL,
	"name" text,
	"center" double precision[] NOT NULL,
	"importance" double precision NOT NULL,
	"medoid" text NOT NULL,
	"member_ids" text[] NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interest_clusters" ADD CONSTRAINT "interest_clusters_profile_id_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interest_clusters_profile_idx" ON "interest_clusters" USING btree ("profile_id","position");