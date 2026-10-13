CREATE TABLE "doc_text" (
	"document_id" bigint PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"lang" text NOT NULL,
	"embedding" halfvec(1024) NOT NULL,
	"embedding_model" text NOT NULL,
	"relevance" real NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_documents" (
	"event_id" bigint NOT NULL,
	"document_id" bigint NOT NULL,
	"similarity" real NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "event_documents_document_id_pk" PRIMARY KEY("document_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"n_docs" integer DEFAULT 1 NOT NULL,
	"centroid" halfvec(1024) NOT NULL,
	"embedding_model" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"description" text NOT NULL,
	"embedding" halfvec(1024),
	"embedding_model" text,
	"display_lang" text DEFAULT 'vi' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "llm_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"reasoning_tokens" integer NOT NULL,
	"cost_usd" numeric(12, 8) NOT NULL,
	"latency_ms" integer NOT NULL,
	"ok" boolean NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "doc_text" ADD CONSTRAINT "doc_text_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_documents" ADD CONSTRAINT "event_documents_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_documents" ADD CONSTRAINT "event_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_text_relevance_idx" ON "doc_text" USING btree ("relevance");--> statement-breakpoint
CREATE INDEX "event_documents_event_idx" ON "event_documents" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "events_last_seen_idx" ON "events" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "events_centroid_hnsw" ON "events" USING hnsw ("centroid" halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX "llm_calls_at_idx" ON "llm_calls" USING btree ("at");