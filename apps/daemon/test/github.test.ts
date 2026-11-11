import { describe, expect, test } from "bun:test";
import { type HttpClient, HttpError, type HttpResponse } from "@radard/core";
import { githubSource, releaseToItem } from "../src/sources/github.ts";
import fixture from "./fixtures/github-releases.json";

type Reply = Partial<HttpResponse> | Error;

/** Fake HTTP that answers based on the repo in the URL and records the headers sent. */
function fakeHttp(replies: Record<string, Reply>) {
  const sent: Array<{ repo: string; headers?: Record<string, string>; etag?: string }> = [];
  const http: HttpClient = {
    post: () => Promise.reject(new Error("test này không POST")),
    async get(url, opts) {
      const repo = /repos\/([^/]+\/[^/]+)\/releases/.exec(url)?.[1] ?? "";
      sent.push({ repo, headers: opts?.headers, etag: opts?.etag });
      const reply = replies[repo];
      if (reply instanceof Error) throw reply;
      return { status: 200, body: "[]", headers: new Headers(), ...reply };
    },
  };
  return { http, sent };
}

describe("releaseToItem", () => {
  test("đọc được phản hồi thật; name rỗng thì dùng tag", () => {
    const items = fixture.map((r) => releaseToItem("timgit/pg-boss", r));
    expect(items[0]?.title).toBe("timgit/pg-boss 12.35.0");
    expect(items[1]?.title).toBe("timgit/pg-boss proxy-1.10.0");
    expect(items[0]?.externalId).toMatch(/^\d+$/);
    expect(items[0]?.meta?.tag).toBe("12.35.0");
  });
});

describe("githubSource.fetch", () => {
  const now = new Date();

  test("gửi ETag lần trước; 304 thì không có mục, ETag cũ được giữ", async () => {
    const { http, sent } = fakeHttp({ "a/x": { status: 304, body: "" } });
    const res = await githubSource.fetch({
      config: { repos: ["a/x"] },
      state: { etags: { "a/x": 'W/"old"' } },
      http,
      now,
    });
    expect(sent[0]?.etag).toBe('W/"old"');
    expect(res.notModified).toBe(true);
    expect(res.state.etags["a/x"]).toBe('W/"old"');
  });

  test("bỏ bản nháp, lưu ETag mới", async () => {
    const releases = [
      { ...fixture[0], draft: false },
      { ...fixture[1], id: 9, draft: true },
    ];
    const { http } = fakeHttp({ "a/x": { body: JSON.stringify(releases), etag: 'W/"new"' } });
    const res = await githubSource.fetch({
      config: { repos: ["a/x"] },
      state: undefined,
      http,
      now,
    });
    expect(res.items).toHaveLength(1);
    expect(res.state.etags["a/x"]).toBe('W/"new"');
    expect(res.notModified).toBe(false);
  });

  test("repo 404 không làm hỏng các repo khác", async () => {
    const { http } = fakeHttp({
      "gone/repo": new HttpError(404, "u", ""),
      "a/x": { body: JSON.stringify([fixture[0]]) },
    });
    const res = await githubSource.fetch({
      config: { repos: ["gone/repo", "a/x"] },
      state: undefined,
      http,
      now,
    });
    expect(res.items).toHaveLength(1);
    expect(res.state.missingRepos).toEqual(["gone/repo"]);
  });

  test("lỗi khác 404 thì ném ra để pg-boss thử lại", async () => {
    const { http } = fakeHttp({ "a/x": new HttpError(503, "u", "") });
    await expect(
      githubSource.fetch({ config: { repos: ["a/x"] }, state: undefined, http, now }),
    ).rejects.toThrow("HTTP 503");
  });
});
