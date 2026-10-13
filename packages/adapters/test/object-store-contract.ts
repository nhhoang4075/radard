/**
 * Bộ test chung cho mọi ObjectStore: adapter đĩa và adapter R2 phải cư xử giống hệt nhau.
 */
import { expect, test } from "bun:test";
import type { ObjectStore } from "@radard/core";

export function objectStoreContract(name: string, store: () => ObjectStore): void {
  const key = (k: string) => `raw/t${Date.now() % 100}/${k}-${crypto.randomUUID()}.gz`;

  test(`${name}: ghi rồi đọc lại đúng từng byte`, async () => {
    const k = key("text");
    const body = new TextEncoder().encode("xin chào ".repeat(200));
    await store().put(k, body, "text/plain");
    expect(await store().exists(k)).toBe(true);
    expect(new TextDecoder().decode((await store().get(k)) ?? new Uint8Array())).toBe(
      "xin chào ".repeat(200),
    );
  });

  test(`${name}: nội dung nhị phân không bị đổi`, async () => {
    const k = key("bin");
    const body = new Uint8Array(4096).map((_, i) => (i * 37) % 256);
    await store().put(k, body, "application/octet-stream");
    expect(await store().get(k)).toEqual(body);
  });

  test(`${name}: ghi lại cùng key là vô hại`, async () => {
    const k = key("twice");
    const body = new TextEncoder().encode("same");
    await store().put(k, body, "text/plain");
    await store().put(k, body, "text/plain");
    expect(await store().get(k)).toEqual(body);
  });

  test(`${name}: key chưa có thì get trả null, exists trả false`, async () => {
    const k = key("none");
    expect(await store().get(k)).toBeNull();
    expect(await store().exists(k)).toBe(false);
  });
}
