-- Fixes jsonb data encoded twice (bun-sql driver + Drizzle's jsonb()): columns that hold a JSON STRING
-- instead of an object. See packages/db/src/schema/json.ts. Only touches rows with the wrong type.

-- JSON string → real JSON value.
UPDATE "sources"      SET "config" = ("config" #>> '{}')::jsonb WHERE jsonb_typeof("config") = 'string';--> statement-breakpoint
UPDATE "source_state" SET "state"  = ("state"  #>> '{}')::jsonb WHERE jsonb_typeof("state")  = 'string';--> statement-breakpoint
UPDATE "documents"    SET "meta"   = ("meta"   #>> '{}')::jsonb WHERE jsonb_typeof("meta")   = 'string';--> statement-breakpoint

-- Junk array from concatenating `string || object` in SQL while the column still has the wrong type: [ "<JSON string>", {…} ].
-- Merge back into one object: the first element (already decoded) plus the second element.
UPDATE "sources"
   SET "config" = ("config" ->> 0)::jsonb || coalesce("config" -> 1, '{}'::jsonb)
 WHERE jsonb_typeof("config") = 'array' AND jsonb_typeof("config" -> 0) = 'string';
