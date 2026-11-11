/**
 * Runs the shared test suite against a real S3 bucket. Skipped by default; to run it, start a local SeaweedFS
 * (Docker Hub no longer publishes MinIO images):
 *
 *   docker run -d --name radard-s3 -p 8333:8333 chrislusf/seaweedfs server -dir=/data -s3 -s3.port=8333
 *   curl -X PUT localhost:8333/radard-test
 *   R2_TEST_ENDPOINT=http://localhost:8333 bun test object-store-r2
 *
 * SeaweedFS without access keys configured does not check signatures, so this test checks read/write behaviour, not
 * access keys. Real R2 keys are checked with `cli store check` on the server.
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
