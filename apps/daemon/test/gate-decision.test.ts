/**
 * Phần thuần của cổng bằng model quyết định: tên và phạm vi tiếng Anh của chủ đề thư viện, chạy
 * song song có giới hạn. Phần đọc DB và hỏi model nằm trong rank.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { englishScopeNote, mapLimit } from "../src/jobs/gate-decision.ts";
import { topicNameEn } from "../src/jobs/topic-overlap.ts";
import { TOPIC_LIBRARY } from "../src/topics/library.ts";

/** Chữ có dấu tiếng Việt (như lúc đo, thử nghiệm B): còn sót là còn tên tiếng Việt. */
const VIETNAMESE = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

describe("tên và phạm vi tiếng Anh", () => {
  const names = new Map(TOPIC_LIBRARY.map((t) => [t.name, topicNameEn({ ...t, label: t.name })]));

  test("mọi chủ đề thư viện có tên tiếng Anh", () => {
    for (const [vi, en] of names) {
      expect(VIETNAMESE.test(en), `${vi} → ${en}`).toBe(false);
    }
    expect(names.get("Agent AI")).toBe("AI agents");
    expect(names.get("Trợ lý và ứng dụng AI")).toBe("AI assistants and apps");
    expect(names.get("Lập trình với AI")).toBe("Programming with AI");
    expect(names.get("Model AI: phát hành và hành vi")).toBe("AI models: releases and behavior");
  });

  test("phạm vi của mọi chủ đề thư viện không còn tên tiếng Việt sau khi thay", () => {
    for (const t of TOPIC_LIBRARY) {
      const note = englishScopeNote(t.labelGuide, names);
      expect(VIETNAMESE.test(note), `${t.key}: ${note}`).toBe(false);
    }
    const media = TOPIC_LIBRARY.find((t) => t.key === "multimodal")?.labelGuide ?? "";
    expect(englishScopeNote(media, names)).toContain(
      "otherwise → AI models: releases and behavior.",
    );
  });

  test("chỉ thay trọn tên", () => {
    const m = new Map([["Agent", "AI agents"]]);
    expect(englishScopeNote("Agents and agent tools (→ Agent).", m)).toBe(
      "Agents and agent tools (→ AI agents).",
    );
  });
});

describe("mapLimit", () => {
  test("giữ thứ tự, không quá giới hạn cùng lúc", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (x) => {
      running++;
      peak = Math.max(peak, running);
      await Bun.sleep(x);
      running--;
      return x * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });
});
