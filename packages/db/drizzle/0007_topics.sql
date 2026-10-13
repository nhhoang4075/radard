CREATE TABLE "profile_topics" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "profile_topics_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"profile_id" integer DEFAULT 1 NOT NULL,
	"topic_id" bigint,
	"label" text NOT NULL,
	"description_user" text,
	"description_en" text NOT NULL,
	"origin" text NOT NULL,
	"kind" text DEFAULT 'include' NOT NULL,
	"embedding" halfvec(1024),
	"embedding_model" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_topics_origin_ck" CHECK ("profile_topics"."origin" in ('library', 'custom')),
	CONSTRAINT "profile_topics_kind_ck" CHECK ("profile_topics"."kind" in ('include', 'exclude')),
	CONSTRAINT "profile_topics_source_ck" CHECK (("profile_topics"."origin" = 'library') = ("profile_topics"."topic_id" is not null) and ("profile_topics"."origin" = 'library' or "profile_topics"."description_user" is not null))
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "topics_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"key" text NOT NULL,
	"group_vi" text NOT NULL,
	"label_vi" text NOT NULL,
	"description_en" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "topics_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "profile_topics" ADD CONSTRAINT "profile_topics_profile_id_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_topics" ADD CONSTRAINT "profile_topics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_topics_library_uq" ON "profile_topics" USING btree ("profile_id","topic_id") WHERE "profile_topics"."topic_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_topics_label_uq" ON "profile_topics" USING btree ("profile_id",lower("label"));