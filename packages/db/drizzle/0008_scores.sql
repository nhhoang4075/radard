CREATE TABLE "baselines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "baselines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"metric" text NOT NULL,
	"source_id" integer,
	"profile_topic_id" bigint,
	"median" real NOT NULL,
	"p999" real NOT NULL,
	"n" integer NOT NULL,
	"window_days" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_signals" (
	"document_id" bigint NOT NULL,
	"metric" text NOT NULL,
	"value" real NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_signals_document_id_metric_pk" PRIMARY KEY("document_id","metric")
);
--> statement-breakpoint
CREATE TABLE "doc_topic_scores" (
	"document_id" bigint NOT NULL,
	"profile_topic_id" bigint NOT NULL,
	"score" real NOT NULL,
	CONSTRAINT "doc_topic_scores_document_id_profile_topic_id_pk" PRIMARY KEY("document_id","profile_topic_id")
);
--> statement-breakpoint
DROP INDEX "doc_text_relevance_idx";--> statement-breakpoint
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_profile_topic_id_profile_topics_id_fk" FOREIGN KEY ("profile_topic_id") REFERENCES "public"."profile_topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_signals" ADD CONSTRAINT "doc_signals_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_topic_scores" ADD CONSTRAINT "doc_topic_scores_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_topic_scores" ADD CONSTRAINT "doc_topic_scores_profile_topic_id_profile_topics_id_fk" FOREIGN KEY ("profile_topic_id") REFERENCES "public"."profile_topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "baselines_key_uq" ON "baselines" USING btree ("metric",coalesce("source_id", 0),coalesce("profile_topic_id", 0));--> statement-breakpoint
CREATE INDEX "doc_topic_scores_topic_idx" ON "doc_topic_scores" USING btree ("profile_topic_id");--> statement-breakpoint
ALTER TABLE "doc_text" DROP COLUMN "relevance";--> statement-breakpoint
ALTER TABLE "profile" DROP COLUMN "embedding";--> statement-breakpoint
ALTER TABLE "profile" DROP COLUMN "embedding_model";