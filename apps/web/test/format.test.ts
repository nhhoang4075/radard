import { expect, test } from "bun:test";
import { dayLabel, formatScore, todayVN } from "../src/lib/format.ts";

test("todayVN dùng giờ Việt Nam (UTC+7), không phải UTC", () => {
  expect(todayVN(new Date("2026-10-15T17:30:00Z"))).toBe("2026-10-16");
  expect(todayVN(new Date("2026-10-15T16:59:00Z"))).toBe("2026-10-15");
});

test("dayLabel: Hôm nay / thứ trong tuần", () => {
  expect(dayLabel("2026-10-16", "2026-10-16")).toBe("Hôm nay, 16/10");
  expect(dayLabel("2026-10-15", "2026-10-16")).toBe("Thứ Năm, 15/10");
});

test("formatScore dùng dấu phẩy", () => {
  expect(formatScore(0.69)).toBe("0,69");
});
