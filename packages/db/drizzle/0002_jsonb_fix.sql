-- Sửa dữ liệu jsonb bị mã hoá hai lần (driver bun-sql + jsonb() của Drizzle): cột chứa CHUỖI JSON
-- thay vì object. Xem packages/db/src/schema/json.ts. Chỉ chạm các dòng đang sai kiểu.

-- Chuỗi JSON → giá trị JSON thật.
UPDATE "sources"      SET "config" = ("config" #>> '{}')::jsonb WHERE jsonb_typeof("config") = 'string';--> statement-breakpoint
UPDATE "source_state" SET "state"  = ("state"  #>> '{}')::jsonb WHERE jsonb_typeof("state")  = 'string';--> statement-breakpoint
UPDATE "documents"    SET "meta"   = ("meta"   #>> '{}')::jsonb WHERE jsonb_typeof("meta")   = 'string';--> statement-breakpoint

-- Mảng rác do nối `chuỗi || object` bằng SQL khi cột còn sai kiểu: [ "<chuỗi JSON>", {…} ].
-- Ghép lại thành một object: phần tử đầu (đã giải mã) cộng phần tử thứ hai.
UPDATE "sources"
   SET "config" = ("config" ->> 0)::jsonb || coalesce("config" -> 1, '{}'::jsonb)
 WHERE jsonb_typeof("config") = 'array' AND jsonb_typeof("config" -> 0) = 'string';
