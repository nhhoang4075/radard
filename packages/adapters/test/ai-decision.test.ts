/**
 * Contract of DecisionProvider: the Gateway adapter (runs on the fake model of `ai/test`, without calling
 * the network) and the fake for tests. Both must return the same answer shape and record cost into the sink.
 */
import { describe, expect, test } from "bun:test";
import type { DecisionProvider, UsageEvent } from "@radard/core";
import { Experimental_DecisionMockModelV4 as MockDecisionModel } from "ai/test";
import { fakeDecision } from "../src/ai-fake.ts";
import { gatewayDecision } from "../src/ai-gateway.ts";

const QUESTIONS = {
  relation: {
    type: "choice",
    instructions: "How does A relate to B?",
    criteria: { same: "Same news", different: "Different news" },
  },
  useful: { type: "boolean", instructions: "Is A useful?" },
} as const;

function sinkInto(events: UsageEvent[]) {
  return async (e: UsageEvent) => {
    events.push(e);
  };
}

function mockModel(meta?: Record<string, Record<string, string>>) {
  return new MockDecisionModel({
    provider: "gateway",
    modelId: "typesafe-ai/jev",
    supportedQuestionTypes: ["boolean", "choice", "score"],
    doDecide: async () => ({
      answers: {
        relation: { type: "choice", choice: "same", probabilities: { same: 0.8, different: 0.2 } },
        useful: { type: "boolean", probability: 0.25 },
      },
      usage: { inputTokens: 120, outputTokens: 0 },
      warnings: [],
      providerMetadata: meta,
    }),
  });
}

async function expectContract(p: DecisionProvider) {
  const res = await p.decide({
    task: "test_decide",
    state: { a: "x", b: "y" },
    questions: QUESTIONS,
  });
  expect(res.answers.relation.type).toBe("choice");
  expect(Object.keys(res.answers.relation.probabilities).sort()).toEqual(["different", "same"]);
  expect(res.answers.useful.type).toBe("boolean");
  expect(res.answers.useful.probability).toBeGreaterThanOrEqual(0);
  expect(res.answers.useful.probability).toBeLessThanOrEqual(1);
  return res;
}

describe("gatewayDecision", () => {
  test("trả câu trả lời có kiểu, ghi chi phí Gateway báo", async () => {
    const events: UsageEvent[] = [];
    const p = gatewayDecision({
      model: mockModel({ gateway: { cost: "0.00000504", generationId: "gen_1" } }),
      sink: sinkInto(events),
    });
    const res = await expectContract(p);
    expect(res.answers.relation.choice).toBe("same");
    expect(res.answers.relation.probabilities.same).toBe(0.8);
    expect(res.answers.useful.probability).toBe(0.25);
    expect(res.usage).toEqual({ inputTokens: 120, costUsd: 0.00000504 });
    expect(res.model).toBe("typesafe-ai/jev");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      task: "test_decide",
      model: "typesafe-ai/jev",
      inputTokens: 120,
      outputTokens: 0,
      costUsd: 0.00000504,
      costSource: "gateway",
      generationId: "gen_1",
      ok: true,
    });
  });

  test("Gateway không báo chi phí thì ước tính từ bảng giá (chỉ token vào)", async () => {
    const events: UsageEvent[] = [];
    const seen: unknown[] = [];
    const p = gatewayDecision({
      model: mockModel(),
      sink: sinkInto(events),
      priceBook: {
        estimate: async (model, usage) => {
          seen.push({ model, usage });
          return usage.input * 0.042e-6;
        },
      },
    });
    const res = await p.decide({ task: "t", state: "s", questions: QUESTIONS });
    expect(res.usage.costUsd).toBeCloseTo(120 * 0.042e-6, 12);
    expect(events[0]?.costSource).toBe("estimate");
    expect(seen).toEqual([{ model: "typesafe-ai/jev", usage: { input: 120, output: 0 } }]);
  });

  test("lỗi thì ghi lời gọi hỏng rồi ném lỗi", async () => {
    const events: UsageEvent[] = [];
    const p = gatewayDecision({
      model: new MockDecisionModel({
        supportedQuestionTypes: ["boolean", "choice"],
        doDecide: async () => {
          throw new Error("hỏng");
        },
      }),
      sink: sinkInto(events),
    });
    await expect(p.decide({ task: "t", state: "s", questions: QUESTIONS })).rejects.toThrow();
    expect(events[0]).toMatchObject({ ok: false, costUsd: 0 });
  });
});

describe("fakeDecision", () => {
  test("cùng hợp đồng: trả lời theo hàm của test, đủ xác suất mọi phương án", async () => {
    const events: UsageEvent[] = [];
    const p = fakeDecision({
      answer: (q) => (q.type === "boolean" ? 0.9 : "different"),
      sink: sinkInto(events),
      costUsd: 0.001,
    });
    const res = await expectContract(p);
    expect(res.answers.relation).toEqual({
      type: "choice",
      choice: "different",
      probabilities: { same: 0, different: 1 },
    });
    expect(res.answers.useful.probability).toBe(0.9);
    expect(res.usage.costUsd).toBe(0.001);
    expect(events[0]).toMatchObject({ task: "test_decide", costUsd: 0.001, ok: true });
  });

  test("chọn phương án không có trong criteria thì lỗi", async () => {
    const p = fakeDecision({ answer: (q) => (q.type === "boolean" ? 0.5 : "nope") });
    await expect(p.decide({ task: "t", state: "s", questions: QUESTIONS })).rejects.toThrow(
      /không có phương án/,
    );
  });
});
