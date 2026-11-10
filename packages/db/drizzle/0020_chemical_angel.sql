CREATE TABLE "topic_examples" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "topic_examples_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"topic_id" integer NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" halfvec(1024) NOT NULL,
	"embedding_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "topic_examples" ADD CONSTRAINT "topic_examples_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "topic_examples_topic_pos_uq" ON "topic_examples" USING btree ("topic_id","position");