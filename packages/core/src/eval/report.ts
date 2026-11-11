/** Formats scorer results as Vietnamese text (pure function, so it can be tested). */
import type { Verdict } from "./bootstrap.ts";
import type { Comparison, EvalReport, SetScore, VariantReport } from "./harness.ts";
import { pairAccuracy } from "./metrics.ts";

const VERDICT_TEXT: Record<Verdict, string> = {
  win: "thắng",
  tie: "hoà (trong nhiễu)",
  lose: "thua",
};

const num = (x: number, digits = 3): string => (Number.isNaN(x) ? "–" : x.toFixed(digits));
const signed = (x: number): string => (Number.isNaN(x) ? "–" : (x >= 0 ? "+" : "") + x.toFixed(3));
const pct = (x: number): string => (Number.isNaN(x) ? "–" : `${(x * 100).toFixed(1)}%`);

function pairText(s: SetScore): string {
  const { clean, all } = s.pairwise;
  return `👍–👎 ${pct(pairAccuracy(clean))} (${clean.pairs} cặp) · mọi cặp ${pct(pairAccuracy(all))} (${all.pairs} cặp)`;
}

function compareText(c: Comparison | undefined): string {
  if (!c) return "(chuẩn so sánh)";
  const v = c.verdict === null ? "chưa đủ dữ liệu" : VERDICT_TEXT[c.verdict];
  return `hiệu ${signed(c.interval.mean)}, KTC 95% [${signed(c.interval.lo)}; ${signed(c.interval.hi)}] trên ${c.interval.n} ngày → ${v}`;
}

function setLines(label: string, s: SetScore, c: Comparison | undefined): string[] {
  return [
    `  ${label}: NDCG trung bình ${num(s.meanNdcg)} (${s.days.length} ngày)`,
    `    ${compareText(c)}`,
    `    cặp: ${pairText(s)}`,
  ];
}

const ACCEPT_TEXT = {
  accept: "NHẬN (thắng baseline ở cả tập thường lẫn tập khoá kín)",
  reject: "KHÔNG NHẬN",
  insufficient: "chưa đủ dữ liệu (tập khoá kín quá nhỏ để có khoảng tin cậy)",
} as const;

function variantLines(v: VariantReport, closedIncluded: boolean): string[] {
  const lines = [
    `● ${v.name}`,
    ...setLines("Tập thường (bỏ-một-ngày)", v.regular, v.vsBaselineRegular),
  ];
  if (v.closed) lines.push(...setLines("Tập khoá kín", v.closed, v.vsBaselineClosed));
  if (closedIncluded && v.accepted) lines.push(`  Kết luận chung: ${ACCEPT_TEXT[v.accepted]}`);
  if (!closedIncluded && v.name !== "baseline")
    lines.push("  Kết luận chung cần tập khoá kín: chạy lại với --closed.");
  return lines;
}

export function formatEvalReport(r: EvalReport): string {
  const f = r.fingerprint;
  const head = [
    "Bộ chấm bất biến (a): NDCG theo ngày, gain 👍 = 2 · chưa bấm = 1 · 👎 = 0",
    `Dữ liệu: sha256 ${f.sha256}`,
    `  ${f.days} ngày (${f.informativeDays} có thông tin, ${f.uninformativeDays} ngày không thông tin bị loại) · ${f.samples} mẫu · ${f.likes} 👍 · ${f.dislikes} 👎`,
    `  Chia ngày có thông tin: ${r.split.regular} ngày thường` +
      (r.closedIncluded
        ? `, ${r.split.closed} ngày khoá kín`
        : " (tập khoá kín không in; thêm --closed)"),
    "",
  ];
  const base = r.variants[0];
  const baseLine = base
    ? [
        `Baseline (S hiện tại, trọng số chép cứng): NDCG ${num(base.regular.meanNdcg)} trên tập thường` +
          (base.closed ? `, ${num(base.closed.meanNdcg)} trên tập khoá kín` : ""),
        "",
      ]
    : [];
  return [
    ...head,
    ...baseLine,
    ...r.variants.flatMap((v) => [...variantLines(v, r.closedIncluded), ""]),
  ]
    .join("\n")
    .trimEnd();
}
