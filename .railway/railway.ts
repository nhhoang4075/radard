/**
 * Cấu hình deploy của radard trên Railway (Infrastructure as Code, thay `railway.json` từ 13/10/2026).
 *
 * File này quản lý service `radard` và `backup` (sao lưu Postgres lên R2 mỗi đêm, xem ops/backup).
 * Service `postgres` (template của Railway) và mọi biến môi
 * trường do Railway giữ (`variables.managed: false`), nên khoá bí mật không bao giờ nằm trong repo.
 * Xem trước bằng `railway config plan`, áp dụng bằng `railway config apply`.
 *
 * Hai điểm lạ đã kiểm bằng API (13/10/2026, CLI 5.66.0):
 * - `plan` luôn báo đổi `restartPolicyType`/`restartPolicyMaxRetries` (CLI đọc lại null), dù trên
 *   service đã đúng ON_FAILURE / 10.
 * - API ghi builder là RAILPACK (enum của API không có DOCKERFILE), nhưng log build vẫn là
 *   "load build definition from Dockerfile": có `dockerfilePath` thì Railway build bằng Dockerfile.
 */
import { defineRailway, github, project, service } from "railway/iac";

export const partial = "radard";

export default defineRailway(() => {
  const radard = service("radard", {
    source: github("nhhoang4075/radard", { branch: "main", checkSuites: false }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
      // Chỉ deploy khi code hoặc cấu hình build đổi; sửa docs không deploy.
      watchPatterns: [
        "apps/**",
        "packages/**",
        "Dockerfile",
        ".dockerignore",
        "package.json",
        "bun.lock",
        "tsconfig.base.json",
        ".railway/**",
      ],
    },
    deploy: {
      // Bản cũ dừng hẳn rồi bản mới mới chạy: không bao giờ có hai bot cùng nhận lượt bấm (lỗi 409).
      overlapSeconds: 0,
      // Daemon chờ job đang chạy tối đa 25 giây sau SIGTERM (main.ts).
      drainingSeconds: 30,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    // Một bản duy nhất (scheduler và bot chỉ được chạy một bản), cùng khu vực với Postgres.
    replicas: { "asia-southeast1-eqsg3a": 1 },
  });

  // Chạy một lần mỗi đêm rồi thoát (Railway Cron): 20:00 UTC = 03:00 giờ VN. Không thử lại khi lỗi:
  // lượt hỏng báo trong log, đêm sau chạy tiếp; thử lại liên tục sẽ tải đi tải lại cả DB.
  const backup = service("backup", {
    source: github("nhhoang4075/radard", { branch: "main", checkSuites: false }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "ops/backup/Dockerfile",
      watchPatterns: ["ops/backup/**", ".railway/**"],
    },
    deploy: {
      cronSchedule: "0 20 * * *",
      restartPolicyType: "NEVER",
    },
    // Cùng khu vực với Postgres: kéo cả DB mỗi đêm không phải đi xa.
    replicas: { "asia-southeast1-eqsg3a": 1 },
  });

  return project("radard", {
    variables: { managed: false },
    resources: [radard, backup],
  });
});
