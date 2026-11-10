/** Đọc câu trả lời của LLM cho tin giả định của chủ đề (HyDE). */
import { describe, expect, test } from "bun:test";
import { EXAMPLES_PER_TOPIC, parseExamples } from "../src/jobs/topic-examples.ts";

describe("parseExamples", () => {
  test("đọc mảng trong khối ```json, bỏ mục sai độ dài và trùng, cắt đủ số lượng", () => {
    const reply = [
      "```json",
      JSON.stringify([
        "llama.cpp adds Metal flash-attention, 30% faster on M3",
        "llama.cpp adds metal flash-attention, 30% faster on m3",
        "short",
        42,
        "MLX 0.20 supports quantized Qwen3 on M-series chips",
        "Benchmark: Ollama vs LM Studio on M4 Max",
        "Show HN: a tiny local LLM runner for Apple Silicon laptops",
        "One more headline about running models on a Mac mini",
      ]),
      "```",
    ].join("\n");
    const out = parseExamples(reply);
    expect(out).toHaveLength(EXAMPLES_PER_TOPIC);
    expect(out[0]).toBe("llama.cpp adds Metal flash-attention, 30% faster on M3");
    expect(out).not.toContain("short");
  });

  test("không có mảng hoặc JSON hỏng thì lỗi để thử lại", () => {
    expect(() => parseExamples("xin lỗi, không làm được")).toThrow();
    expect(() => parseExamples("[not json]")).toThrow();
  });
});
