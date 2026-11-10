import { describe, expect, test } from "bun:test";
import {
  assertPublicUrl,
  checkUrlShape,
  isPublicAddress,
  UrlBlockedError,
} from "../src/url-guard.ts";

const PRIVATE = [
  "127.0.0.1",
  "127.255.255.255",
  "0.0.0.0",
  "0.1.2.3",
  "10.0.0.0",
  "10.255.255.255",
  "172.16.0.0",
  "172.20.5.5",
  "172.31.255.255",
  "192.168.0.1",
  "192.168.255.255",
  "169.254.0.0",
  "169.254.169.254",
  "169.254.255.255",
  "100.64.0.0",
  "100.100.100.100",
  "100.127.255.255",
  "224.0.0.1",
  "255.255.255.255",
  "::",
  "::1",
  "fc00::",
  "fd12:3456:789a::1",
  "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "fe80::1",
  "fe80::abcd%en0",
  "febf:ffff::1",
  "fec0::1",
  "ff02::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::ffff:10.1.2.3",
  "::ffff:169.254.169.254",
  "::ffff:192.168.1.1",
  "0:0:0:0:0:ffff:a00:1",
  "::127.0.0.1",
  "64:ff9b::7f00:1",
  "2002:7f00:1::1",
  // Không phải địa chỉ hợp lệ: coi là không an toàn.
  "garbage",
  "",
  "1.2.3",
  "256.1.1.1",
  "1.2.3.4.5",
  "::ffff:1.2.3",
  "1::2::3",
  "12345::1",
];
const PUBLIC = [
  "8.8.8.8",
  "1.1.1.1",
  "126.255.255.255",
  "128.0.0.1",
  "172.15.255.255",
  "172.32.0.0",
  "100.63.255.255",
  "100.128.0.0",
  "169.253.255.255",
  "169.255.0.0",
  "192.167.255.255",
  "192.169.0.0",
  "11.0.0.0",
  "9.255.255.255",
  "223.255.255.255",
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
  "fbff:ffff::1",
  "fe00::1",
  "::ffff:8.8.8.8",
  "::ffff:808:808",
  "64:ff9b::808:808",
  "2002:808:808::1",
];

describe("isPublicAddress", () => {
  test.each(PRIVATE)("%p bị coi là riêng/không hợp lệ", (a) => {
    expect(isPublicAddress(a)).toBe(false);
  });
  test.each(PUBLIC)("%p là công khai", (a) => {
    expect(isPublicAddress(a)).toBe(true);
  });
});

describe("checkUrlShape", () => {
  test.each([
    "file:///etc/passwd",
    "ftp://example.com/x",
    "gopher://example.com/",
    "javascript:alert(1)",
    "http://example.com:5432/",
    "https://example.com:6379/",
    "http://example.com:8080/",
    "not a url",
  ])("từ chối %p", (u) => {
    expect(() => checkUrlShape(u)).toThrow(UrlBlockedError);
  });
  test.each([
    "http://example.com/",
    "https://example.com/",
    "http://example.com:80/",
    "https://example.com:443/x",
    "https://example.com:80/",
  ])("cho qua %p", (u) => {
    expect(checkUrlShape(u).href).toBeTruthy();
  });
});

const dns = (table: Record<string, string[]>) => async (host: string) => {
  const r = table[host];
  if (!r) throw new Error("ENOTFOUND");
  return r;
};

describe("assertPublicUrl", () => {
  const resolve = dns({
    "good.example": ["93.184.216.34", "2606:2800:220:1::1"],
    "mixed.example": ["93.184.216.34", "10.0.0.5"],
    "mixed6.example": ["93.184.216.34", "fd00::1"],
    "internal.example": ["192.168.1.10"],
    localhost: ["127.0.0.1", "::1"],
  });
  const blocked = (u: string) =>
    expect(assertPublicUrl(u, resolve)).rejects.toBeInstanceOf(UrlBlockedError);

  test("tên miền công khai (cả A lẫn AAAA) được qua", async () => {
    const u = await assertPublicUrl("https://good.example/a", resolve);
    expect(u.hostname).toBe("good.example");
  });
  test("một bản ghi riêng là đủ để từ chối, dù nó không đứng đầu", async () => {
    await blocked("https://mixed.example/");
    await blocked("https://mixed6.example/");
    await blocked("http://internal.example/");
    await blocked("http://localhost/");
  });
  test("tên miền có đuôi chấm vẫn được phân giải đúng", async () => {
    expect((await assertPublicUrl("https://good.example./", resolve)).href).toContain(
      "good.example",
    );
    await blocked("http://localhost./");
    await blocked("http://internal.example./");
  });
  test("IP viết lạ: URL chuẩn hoá về dạng chuẩn rồi mới kiểm", async () => {
    expect(new URL("http://2130706433/").hostname).toBe("127.0.0.1");
    await blocked("http://2130706433/"); // thập phân
    await blocked("http://0x7f000001/"); // thập lục phân
    await blocked("http://0177.0.0.1/"); // bát phân
    await blocked("http://127.1/"); // rút gọn
    await blocked("http://0/");
    await blocked("http://[::1]/");
    await blocked("http://[::ffff:127.0.0.1]/");
    await blocked("http://[::ffff:7f00:1]/");
    await blocked("http://[fe80::1]/");
    await blocked("http://[fd00::1]/");
    await blocked("http://169.254.169.254/latest/meta-data/");
    await blocked("http://100.64.0.1/");
    await blocked("http://172.16.0.1/");
    await blocked("http://192.168.0.1/");
    await blocked("http://10.1.1.1/");
  });
  test("IP công khai viết thẳng được qua mà không cần DNS", async () => {
    expect((await assertPublicUrl("http://8.8.8.8/", async () => [])).hostname).toBe("8.8.8.8");
    const v6 = await assertPublicUrl("http://[2606:4700:4700::1111]/", async () => []);
    expect(v6.port).toBe("");
  });
  test("lược đồ, cổng lạ bị chặn trước khi phân giải", async () => {
    let called = 0;
    const spy = async () => {
      called++;
      return ["93.184.216.34"];
    };
    for (const u of [
      "file:///etc/passwd",
      "ftp://good.example/",
      "gopher://good.example/",
      "http://good.example:5432/",
      "http://good.example:6379/",
    ]) {
      await expect(assertPublicUrl(u, spy)).rejects.toBeInstanceOf(UrlBlockedError);
    }
    expect(called).toBe(0);
  });
  test("không phân giải được hoặc không có địa chỉ thì từ chối", async () => {
    await blocked("http://nope.example/");
    await expect(assertPublicUrl("http://x.example/", async () => [])).rejects.toBeInstanceOf(
      UrlBlockedError,
    );
  });
});
