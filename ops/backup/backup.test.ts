import { describe, expect, test } from "bun:test";
import { backupName, keysToDelete } from "./backup.ts";

describe("backupName", () => {
  test("giờ UTC, sắp theo tên là sắp theo thời gian", () => {
    expect(backupName(new Date("2026-11-09T20:00:05.123Z"))).toBe("radard-20261109-200005.dump");
    expect(
      backupName(new Date("2026-11-09T20:00:05Z")) < backupName(new Date("2026-12-01T00:00:00Z")),
    ).toBe(true);
  });
});

describe("keysToDelete", () => {
  const k = (d: number) => `backup/radard-202611${String(d).padStart(2, "0")}-200000.dump`;

  test("giữ keep bản mới nhất, xoá bản cũ nhất", () => {
    const keys = Array.from({ length: 16 }, (_, i) => k(i + 1));
    expect(keysToDelete(keys, 14)).toEqual([k(1), k(2)]);
  });

  test("không đủ keep bản thì không xoá gì, thứ tự đầu vào không quan trọng", () => {
    expect(keysToDelete([k(3), k(1), k(2)], 14)).toEqual([]);
    expect(keysToDelete([k(3), k(1), k(2)], 2)).toEqual([k(1)]);
  });

  test("không đụng file không đúng tên sao lưu", () => {
    const keys = ["backup/README.txt", "backup/other.dump", k(1), k(2)];
    expect(keysToDelete(keys, 1)).toEqual([k(1)]);
  });
});
