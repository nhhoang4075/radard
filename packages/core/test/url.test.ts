import { describe, expect, test } from "bun:test";
import { canonicalizeUrl } from "../src/url.ts";

describe("canonicalizeUrl", () => {
  test("bỏ tham số theo dõi, fragment, www và dấu / cuối", () => {
    expect(canonicalizeUrl("http://www.Example.com/blog/post/?utm_source=x&fbclid=y#top")).toBe(
      "https://example.com/blog/post",
    );
  });

  test("giữ tham số chọn bài và sắp xếp để thứ tự không đổi khoá", () => {
    expect(canonicalizeUrl("https://site.com/item?page=2&id=123")).toBe(
      canonicalizeUrl("https://site.com/item?id=123&page=2"),
    );
    expect(canonicalizeUrl("https://news.ycombinator.com/item?id=1")).toContain("id=1");
  });

  test("chỉ bỏ tham số theo dõi, giữ tham số thật trong cùng query", () => {
    expect(canonicalizeUrl("https://site.com/item?id=5&utm_source=nl&utm_medium=email")).toBe(
      "https://site.com/item?id=5",
    );
  });

  test("bỏ mã click quảng cáo và mã email marketing", () => {
    const params = [
      "msclkid=a",
      "twclid=b",
      "yclid=c",
      "ttclid=d",
      "li_fat_id=e",
      "dclid=f",
      "gbraid=g",
      "wbraid=h",
      "_hsenc=p2ANqtz",
      "_hsmi=123",
      "mkt_tok=eyJ",
    ];
    expect(canonicalizeUrl(`https://blog.com/post?id=7&${params.join("&")}`)).toBe(
      "https://blog.com/post?id=7",
    );
  });

  test("không bỏ nhầm tham số chỉ trùng một phần tên", () => {
    // `utm_\w+` hay `gclid` không được khớp lỏng vào tham số có nghĩa như `hsmi` (thiếu gạch dưới), `gclids`.
    expect(canonicalizeUrl("https://site.com/x?hsmi=1&gclids=2")).toBe(
      "https://site.com/x?gclids=2&hsmi=1",
    );
  });

  test("giữ ref (GitHub dùng làm tên nhánh/tag)", () => {
    const v2 = canonicalizeUrl("https://api.github.com/repos/o/r/contents/README.md?ref=v2");
    const main = canonicalizeUrl("https://api.github.com/repos/o/r/contents/README.md?ref=main");
    expect(v2).toContain("ref=v2");
    expect(v2).not.toBe(main);
  });

  test("si chỉ bị bỏ ở host dùng nó để theo dõi", () => {
    expect(canonicalizeUrl("https://www.youtube.com/watch?v=abc&si=XYZ")).toBe(
      "https://youtube.com/watch?v=abc",
    );
    expect(canonicalizeUrl("https://example.com/search?si=1")).toContain("si=1");
  });

  test("chuỗi không phải URL thì trả nguyên (đã trim)", () => {
    expect(canonicalizeUrl("  not a url ")).toBe("not a url");
  });
});
