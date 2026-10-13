/**
 * Tải trang và rút chữ: robots.txt, kiểu nội dung, lỗi HTTP; Readability bỏ menu và chân trang.
 * HttpClient giả, không gọi mạng.
 */
import { describe, expect, test } from "bun:test";
import { type HttpClient, HttpError, type HttpResponse } from "@radard/core";
import { createPageFetcher, extractPageText } from "../src/pages.ts";

const ARTICLE = `<!doctype html><html><head><title>Janas</title></head><body>
<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/login">Sign in</a></nav>
<article><h1>Janas: run LLMs larger than RAM</h1>
<p>${"Janas streams mixture-of-experts weights from an NVMe SSD on demand, so a 120B model runs on a laptop with 16 GB of RAM. ".repeat(4)}</p>
<p>${"Inference speed depends on SSD read bandwidth; the README reports 8 tokens per second on an M3 MacBook. ".repeat(3)}</p>
</article>
<footer>© 2026 · Privacy · Terms</footer></body></html>`;

function fakeHttp(routes: Record<string, () => HttpResponse>): HttpClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async get(url) {
      asked.push(url);
      const route = routes[url];
      if (!route) throw new HttpError(404, url, "");
      return route();
    },
  };
}

const html = (body: string, type = "text/html; charset=utf-8"): HttpResponse => ({
  status: 200,
  body,
  url: "https://final.example/x",
  headers: new Headers({ "content-type": type }),
});

describe("extractPageText", () => {
  test("lấy phần bài, bỏ menu và chân trang", () => {
    const text = extractPageText(ARTICLE, "https://example.com/janas") ?? "";
    expect(text).toContain("streams mixture-of-experts weights from an NVMe SSD");
    expect(text).not.toContain("Sign in");
    expect(text).not.toContain("Privacy");
  });

  test("trang gần như không có chữ (cần JavaScript) thì trả null", () => {
    expect(
      extractPageText("<html><body><div id=root></div></body></html>", "https://x.com/"),
    ).toBeNull();
  });
});

describe("createPageFetcher", () => {
  test("robots.txt cấm thì không tải; đọc robots một lần cho mỗi host", async () => {
    const http = fakeHttp({
      "https://a.com/robots.txt": () =>
        html("User-agent: radard\nDisallow: /private/", "text/plain"),
      "https://a.com/public": () => html(ARTICLE),
    });
    const f = createPageFetcher({ http });
    expect((await f.fetch("https://a.com/private/x")).status).toBe("blocked");
    const ok = await f.fetch("https://a.com/public");
    expect(ok).toMatchObject({ status: "ok", httpStatus: 200, contentType: "text/html" });
    expect(ok.html).toContain("Janas");
    expect(http.asked).toEqual(["https://a.com/robots.txt", "https://a.com/public"]);
  });

  test("không có robots.txt (404) thì được tải; PDF bỏ qua; 403 ghi lỗi", async () => {
    const http = fakeHttp({
      "https://b.com/paper.pdf": () => html("%PDF-1.7", "application/pdf"),
      "https://b.com/paywall": () => {
        throw new HttpError(403, "https://b.com/paywall", "");
      },
    });
    const f = createPageFetcher({ http });
    expect(await f.fetch("https://b.com/paper.pdf")).toMatchObject({
      status: "skipped",
      contentType: "application/pdf",
    });
    expect(await f.fetch("https://b.com/paywall")).toMatchObject({
      status: "failed",
      httpStatus: 403,
    });
  });
});
