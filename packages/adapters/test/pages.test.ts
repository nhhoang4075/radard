/**
 * Tải trang và rút chữ: robots.txt, kiểu nội dung, lỗi HTTP; Readability bỏ menu và chân trang.
 * HttpClient giả, không gọi mạng.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { type HttpClient, HttpError, type HttpResponse } from "@radard/core";
import { createPageFetcher, extractPageText } from "../src/pages.ts";

const ARTICLE = `<!doctype html><html><head><title>Janas</title></head><body>
<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/login">Sign in</a></nav>
<article><h1>Janas: run LLMs larger than RAM</h1>
<p>${"Janas streams mixture-of-experts weights from an NVMe SSD on demand, so a 120B model runs on a laptop with 16 GB of RAM. ".repeat(4)}</p>
<p>${"Inference speed depends on SSD read bandwidth; the README reports 8 tokens per second on an M3 MacBook. ".repeat(3)}</p>
</article>
<footer>© 2026 · Privacy · Terms</footer></body></html>`;

function fakeHttp(
  routes: Record<string, () => HttpResponse>,
): HttpClient & { asked: string[]; pins: (string | undefined)[] } {
  const asked: string[] = [];
  const pins: (string | undefined)[] = [];
  return {
    asked,
    pins,
    post: () => Promise.reject(new Error("test này không POST")),
    async get(url, o) {
      asked.push(url);
      pins.push(o?.connectTo);
      const route = routes[url];
      if (!route) throw new HttpError(404, url, "");
      return route();
    },
  };
}

/** DNS giả: mọi tên miền công khai trừ vài tên được dặn riêng. */
const table: Record<string, string[]> = {
  "mixed.example": ["93.184.216.34", "10.0.0.5"],
  "internal.example": ["192.168.1.10"],
};
const resolve = async (host: string) => table[host] ?? ["93.184.216.34"];

const redirect = (to: string): HttpResponse => ({
  status: 302,
  body: "",
  headers: new Headers({ location: to }),
});

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
    const f = createPageFetcher({ http, resolve });
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
    const f = createPageFetcher({ http, resolve });
    expect(await f.fetch("https://b.com/paper.pdf")).toMatchObject({
      status: "skipped",
      contentType: "application/pdf",
    });
    expect(await f.fetch("https://b.com/paywall")).toMatchObject({
      status: "failed",
      httpStatus: 403,
    });
  });

  test("mục robots.txt hết hạn của host không gặp lại bị xoá, Map không phình", async () => {
    const http = fakeHttp({});
    const f = createPageFetcher({ http, resolve });
    setSystemTime(new Date("2026-10-30T00:00:00Z"));
    await f.fetch("https://old1.com/x");
    await f.fetch("https://old2.com/x");
    expect(f.robotsCacheSize?.()).toBe(2);
    setSystemTime(new Date("2026-10-31T01:00:00Z")); // quá 24 giờ
    await f.fetch("https://new.com/x");
    expect(f.robotsCacheSize?.()).toBe(1);
  });
});

describe("createPageFetcher: SSRF", () => {
  test.each([
    "file:///etc/passwd",
    "ftp://a.com/x",
    "gopher://a.com/x",
    "http://a.com:5432/",
    "http://a.com:6379/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://2130706433/",
    "http://mixed.example/",
    "http://internal.example./",
  ])("từ chối %p, không gọi mạng", async (url) => {
    const http = fakeHttp({});
    const res = await createPageFetcher({ http, resolve }).fetch(url);
    expect(res.status).toBe("failed");
    expect(res.error).toContain("URL bị chặn");
    expect(http.asked).toEqual([]);
  });

  test("trang công khai 302 tới địa chỉ riêng thì dừng ở bước đó", async () => {
    const http = fakeHttp({
      "https://a.com/go": () => redirect("http://169.254.169.254/latest/meta-data/"),
    });
    const res = await createPageFetcher({ http, resolve }).fetch("https://a.com/go");
    expect(res).toMatchObject({ status: "failed" });
    expect(res.error).toContain("169.254.169.254");
    expect(http.asked).toEqual(["https://a.com/robots.txt", "https://a.com/go"]);
  });

  test("redirect tới tên miền có một bản ghi riêng cũng bị chặn", async () => {
    const http = fakeHttp({ "https://a.com/go": () => redirect("https://mixed.example/x") });
    const res = await createPageFetcher({ http, resolve }).fetch("https://a.com/go");
    expect(res.status).toBe("failed");
    expect(http.asked).not.toContain("https://mixed.example/x");
  });

  test("redirect có hợp lệ thì theo; robots.txt tính theo host CUỐI", async () => {
    const http = fakeHttp({
      "https://a.com/start": () => redirect("https://b.com/article"),
      "https://b.com/robots.txt": () => html("User-agent: *\nDisallow: /article", "text/plain"),
      "https://b.com/article": () => html(ARTICLE),
    });
    const res = await createPageFetcher({ http, resolve }).fetch("https://a.com/start");
    expect(res.status).toBe("blocked");
    expect(http.asked).toContain("https://b.com/robots.txt");
    expect(http.asked).not.toContain("https://b.com/article");
  });

  test("redirect hợp lệ tới trang cho phép: finalUrl là đích cuối", async () => {
    const http = fakeHttp({
      "https://a.com/start": () => redirect("/next"),
      "https://a.com/next": () => html(ARTICLE),
    });
    const res = await createPageFetcher({ http, resolve }).fetch("https://a.com/start");
    expect(res).toMatchObject({ status: "ok", finalUrl: "https://a.com/next" });
  });

  test("đủ 5 redirect vẫn được; thêm một nữa thì dừng và ghi lỗi", async () => {
    const chain = (n: number) => {
      const routes: Record<string, () => HttpResponse> = {};
      for (let i = 0; i < n; i++) {
        routes[`https://a.com/r${i}`] = () => redirect(`https://a.com/r${i + 1}`);
      }
      routes[`https://a.com/r${n}`] = () => html(ARTICLE);
      return routes;
    };
    const five = await createPageFetcher({ http: fakeHttp(chain(5)), resolve }).fetch(
      "https://a.com/r0",
    );
    expect(five.status).toBe("ok");
    const http = fakeHttp(chain(6));
    const six = await createPageFetcher({ http, resolve }).fetch("https://a.com/r0");
    expect(six.status).toBe("failed");
    expect(six.error).toContain("redirect");
    expect(http.asked).not.toContain("https://a.com/r6");
  });

  test("kết nối thẳng tới địa chỉ đã kiểm (ghim), cả robots.txt; IP viết thẳng thì không ghim", async () => {
    const http = fakeHttp({
      "https://a.com/p": () => html(ARTICLE),
      "http://8.8.8.8/p": () => html(ARTICLE),
    });
    const f = createPageFetcher({ http, resolve });
    expect((await f.fetch("https://a.com/p")).status).toBe("ok");
    expect(http.pins).toEqual(["93.184.216.34", "93.184.216.34"]);
    http.pins.length = 0;
    expect((await f.fetch("http://8.8.8.8/p")).status).toBe("ok");
    expect(http.pins).toEqual([undefined, undefined]);
  });

  test("địa chỉ đầu không kết nối được thì thử địa chỉ kế (đều đã kiểm)", async () => {
    const tried: (string | undefined)[] = [];
    const http: HttpClient = {
      post: () => Promise.reject(new Error("không POST")),
      async get(url, o) {
        tried.push(o?.connectTo);
        if (o?.connectTo === "2606:4700::1") throw new TypeError("Unable to connect");
        if (url.endsWith("/robots.txt")) throw new HttpError(404, url, "");
        return html(ARTICLE);
      },
    };
    const two = async () => ["2606:4700::1", "93.184.216.34"];
    const res = await createPageFetcher({ http, resolve: two }).fetch("https://a.com/p");
    expect(res.status).toBe("ok");
    expect(tried).toEqual(["2606:4700::1", "93.184.216.34", "2606:4700::1", "93.184.216.34"]);
  });

  test("robots.txt 404 và 403 = được phép", async () => {
    for (const code of [404, 403]) {
      const http = fakeHttp({
        "https://c.com/robots.txt": () => {
          throw new HttpError(code, "https://c.com/robots.txt", "");
        },
        "https://c.com/p": () => html(ARTICLE),
      });
      expect((await createPageFetcher({ http, resolve }).fetch("https://c.com/p")).status).toBe(
        "ok",
      );
    }
  });

  test("robots.txt 503 hoặc không kết nối được thì KHÔNG tải trang", async () => {
    for (const fail of [
      () => {
        throw new HttpError(503, "https://c.com/robots.txt", "");
      },
      () => {
        throw new TypeError("Unable to connect");
      },
    ]) {
      const http = fakeHttp({
        "https://c.com/robots.txt": fail,
        "https://c.com/p": () => html(ARTICLE),
      });
      const f = createPageFetcher({ http, resolve });
      const res = await f.fetch("https://c.com/p");
      expect(res.status).toBe("deferred");
      expect(res.error).toContain("robots.txt");
      expect(http.asked).toEqual(["https://c.com/robots.txt"]);
      expect(f.robotsCacheSize?.()).toBe(0); // lỗi không được nhớ: lần sau thử lại
    }
  });

  test("robots.txt 503 rồi hồi lại: lần sau tải được (không nhớ lỗi)", async () => {
    let up = false;
    const http = fakeHttp({
      "https://c.com/robots.txt": () => {
        if (!up) throw new HttpError(503, "https://c.com/robots.txt", "");
        return html("User-agent: *\nAllow: /", "text/plain");
      },
      "https://c.com/p": () => html(ARTICLE),
    });
    const f = createPageFetcher({ http, resolve });
    expect((await f.fetch("https://c.com/p")).status).toBe("deferred");
    up = true;
    expect((await f.fetch("https://c.com/p")).status).toBe("ok");
  });

  test("robots.txt redirect tới địa chỉ riêng thì không tải trang", async () => {
    const http = fakeHttp({
      "https://c.com/robots.txt": () => redirect("http://127.0.0.1/robots.txt"),
      "https://c.com/p": () => html(ARTICLE),
    });
    const res = await createPageFetcher({ http, resolve }).fetch("https://c.com/p");
    expect(res.status).toBe("failed"); // chặn chủ động, không phải lỗi tạm
    expect(res.error).toContain("127.0.0.1");
    expect(http.asked).not.toContain("https://c.com/p");
  });
});

afterEach(() => setSystemTime());
