CREATE TABLE "linked_pages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "linked_pages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"url_canonical" text NOT NULL,
	"url" text NOT NULL,
	"final_url" text,
	"status" text NOT NULL,
	"http_status" integer,
	"content_type" text,
	"content_sha256" text,
	"raw_key" text,
	"error" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linked_pages_url_canonical_unique" UNIQUE("url_canonical"),
	CONSTRAINT "linked_pages_status_ck" CHECK ("linked_pages"."status" in ('ok', 'blocked', 'skipped', 'failed')),
	CONSTRAINT "linked_pages_raw_ck" CHECK (("linked_pages"."status" = 'ok') = ("linked_pages"."raw_key" is not null))
);
