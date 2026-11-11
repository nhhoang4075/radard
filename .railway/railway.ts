/**
 * Radard deploy configuration on Railway (Infrastructure as Code, replaces `railway.json` since 13/10/2026).
 *
 * This file manages the `radard` and `backup` services (nightly Postgres backup to R2, see ops/backup).
 * The `postgres` service (a Railway template) and every environment
 * variable are held by Railway (`variables.managed: false`), so secrets never live in the repo.
 * Preview with `railway config plan`, apply with `railway config apply`.
 *
 * Two oddities checked against the API (13/10/2026, CLI 5.66.0):
 * - `plan` always reports a change to `restartPolicyType`/`restartPolicyMaxRetries` (the CLI reads back null), although
 *   the service is already ON_FAILURE / 10.
 * - The API records the builder as RAILPACK (the API enum has no DOCKERFILE), yet the build log still says
 *   "load build definition from Dockerfile": with `dockerfilePath` set, Railway builds with the Dockerfile.
 */
import { defineRailway, github, project, service } from "railway/iac";

export const partial = "radard";

export default defineRailway(() => {
  const radard = service("radard", {
    source: github("nhhoang4075/radard", { branch: "main", checkSuites: false }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
      // Deploy only when code or build config changes; docs edits do not deploy.
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
      // The old version stops completely before the new one starts: never two bots receiving button presses (error 409).
      overlapSeconds: 0,
      // The daemon waits up to 25 seconds for a running job after SIGTERM (main.ts).
      drainingSeconds: 30,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    // A single copy (scheduler and bot may run only once), in the same region as Postgres.
    replicas: { "asia-southeast1-eqsg3a": 1 },
  });

  // Runs once a night then exits (Railway Cron): 20:00 UTC = 03:00 Vietnam time. No retry on failure:
  // a failed run is reported in the log and the next night runs again; endless retries would pull the whole DB again and again.
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
    // Same region as Postgres: pulling the whole DB every night should not travel far.
    replicas: { "asia-southeast1-eqsg3a": 1 },
  });

  return project("radard", {
    variables: { managed: false },
    resources: [radard, backup],
  });
});
