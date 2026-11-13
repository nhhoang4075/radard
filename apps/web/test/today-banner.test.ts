import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TodayBanner } from "../src/features/feed/today-banner.tsx";

const render = (over: { intro: string | null; eventCount: number | null }) =>
  renderToStaticMarkup(
    createElement(TodayBanner, {
      date: "2026-11-14",
      total: 30,
      digestCount: 7,
      topicCount: 5,
      ...over,
    }),
  );

describe("TodayBanner", () => {
  test("shows the intro paragraph and the event count when present", () => {
    const html = render({ intro: "Đoạn mở đầu.", eventCount: 141 });
    expect(html).toContain("<p>Đoạn mở đầu.</p>");
    expect(html).toContain("<dd>141</dd>");
  });

  test("hides the paragraph when intro is null, without placeholder text", () => {
    const html = render({ intro: null, eventCount: 141 });
    expect(html).not.toContain("<p>");
    expect(html).toContain("<dd>141</dd>");
  });

  test("hides the event stat when eventCount is null; zero is still shown", () => {
    const hidden = render({ intro: "x", eventCount: null });
    expect(hidden).not.toContain("Sự kiện mới");
    expect(hidden).toContain("<dd>30</dd>"); // total stays
    expect(render({ intro: null, eventCount: 0 })).toContain("<dd>0</dd>");
  });

  test("both null: only the original three stats remain", () => {
    const html = render({ intro: null, eventCount: null });
    expect(html.match(/<dd>/g)?.length).toBe(3);
  });
});
