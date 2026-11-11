import { strings } from "./strings.vi.ts";

const VN = "Asia/Ho_Chi_Minh";

/** Ngày hiện tại theo giờ Việt Nam, YYYY-MM-DD. */
export const todayVN = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: VN,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

/** "Hôm nay, 16/10" | "Thứ Năm, 15/10". */
export function dayLabel(date: string, today: string = todayVN()): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dm = `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
  if (date === today) return `${strings.format.today}, ${dm}`;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${strings.format.weekdays[dow]}, ${dm}`;
}

/** 0,69 (dấu phẩy thập phân kiểu Việt). */
export const formatScore = (n: number): string => n.toFixed(2).replace(".", ",");

/** "08:30 · 16/10" theo giờ Việt Nam. */
export function formatDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("vi-VN", {
    timeZone: VN,
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("hour")}:${g("minute")} · ${g("day")}/${g("month")}`;
}
