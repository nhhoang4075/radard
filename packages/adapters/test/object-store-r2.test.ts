/**
 * Chạy bộ test chung với một bucket S3 thật. Mặc định bỏ qua; muốn chạy thì bật SeaweedFS local
 * (Docker Hub đã ngừng phát hành image MinIO):
 *
 *   docker run -d --name radard-s3 -p 8333:8333 chrislusf/seaweedfs server -dir=/data -s3 -s3.port=8333
 *   curl -X PUT localhost:8333/radard-test
 *   R2_TEST_ENDPOINT=http://localhost:8333 bun test object-store-r2
 *
 * SeaweedFS chưa cấu hình khoá thì không kiểm chữ ký, nên test này kiểm hành vi đọc ghi, không kiểm
 * khoá. Khoá R2 thật được kiểm bằng `cli store check` trên server.
 */
import { describe } from "bun:test";
import { r2ObjectStore } from "../src/object-store-r2.ts";
import { objectStoreContract } from "./object-store-contract.ts";

const endpoint = process.env.R2_TEST_ENDPOINT;
const opts = {
  endpoint: endpoint ?? "",
  bucket: process.env.R2_TEST_BUCKET ?? "radard-test",
  accessKeyId: process.env.R2_TEST_ACCESS_KEY_ID ?? "minioadmin",
  secretAccessKey: process.env.R2_TEST_SECRET_ACCESS_KEY ?? "minioadmin",
};

describe.skipIf(!endpoint)("r2ObjectStore", () => {
  objectStoreContract("R2", () => r2ObjectStore(opts));
});
