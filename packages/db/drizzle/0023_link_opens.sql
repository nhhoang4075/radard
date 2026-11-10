CREATE TABLE "link_opens" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "link_opens_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"profile_id" integer NOT NULL,
	"delivery_id" bigint NOT NULL,
	"link_index" integer NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"is_prefetch" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "link_opens" ADD CONSTRAINT "link_opens_profile_id_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_opens" ADD CONSTRAINT "link_opens_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "link_opens_delivery_link_idx" ON "link_opens" USING btree ("delivery_id","link_index","opened_at");--> statement-breakpoint
CREATE INDEX "link_opens_profile_idx" ON "link_opens" USING btree ("profile_id","opened_at");