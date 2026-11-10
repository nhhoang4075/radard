import { describe, expect, test } from "bun:test";
import {
  ageWeight,
  clusterInterests,
  type InterestCluster,
  type InterestItem,
  interestScore,
} from "../src/interest.ts";

const R = Math.SQRT1_2; // 1/căn 2

// Nhóm A quanh (R, R, 0): tổng 0,6+0,8+R theo x bằng tổng theo y nên tâm = (R, R, 0).
const A: InterestItem[] = [
  { id: "a1", vector: [0.6, 0.8, 0], ageDays: 0 },
  { id: "a2", vector: [0.8, 0.6, 0], ageDays: 0 },
  { id: "a3", vector: [R, R, 0], ageDays: 0 },
];
// Nhóm B quanh (0, -R, -R), cách A khoảng ~1,73.
const B: InterestItem[] = [
  { id: "b1", vector: [0, -0.6, -0.8], ageDays: 0 },
  { id: "b2", vector: [0, -0.8, -0.6], ageDays: 0 },
  { id: "b3", vector: [0, -R, -R], ageDays: 0 },
];

function cluster(partial: Partial<InterestCluster> & Pick<InterestCluster, "center">) {
  return {
    status: "active",
    name: null,
    importance: 1,
    medoid: "m",
    memberIds: ["m"],
    ...partial,
  } as InterestCluster;
}

describe("ageWeight", () => {
  test("nửa đời 60 ngày", () => {
    expect(ageWeight(0)).toBe(1);
    expect(ageWeight(60)).toBeCloseTo(0.5, 12);
    expect(ageWeight(120)).toBeCloseTo(0.25, 12);
  });

  test("tin quá ~200 ngày bị bỏ, 190 ngày còn giữ", () => {
    const base = { vector: [1, 0, 0] };
    const out = clusterInterests(
      [
        { id: "old", ageDays: 201, ...base },
        { id: "mid", ageDays: 190, ...base },
        { id: "new", ageDays: 0, ...base },
      ],
      { distanceThreshold: 1 },
    );
    expect(out.flatMap((c) => c.memberIds).sort()).toEqual(["mid", "new"]);
  });
});

describe("gom cụm Ward", () => {
  test("hai nhóm tách rõ cho đúng 2 cụm, cả hai active", () => {
    const out = clusterInterests([...A, ...B], { distanceThreshold: 0.5 });
    expect(out.map((c) => c.memberIds)).toEqual([
      ["a1", "a2", "a3"],
      ["b1", "b2", "b3"],
    ]);
    expect(out.every((c) => c.status === "active")).toBe(true);
  });

  test("τ rất lớn gộp thành 1 cụm", () => {
    const out = clusterInterests([...A, ...B], { distanceThreshold: 1000 });
    expect(out).toHaveLength(1);
    expect(out[0]?.memberIds).toEqual(["a1", "a2", "a3", "b1", "b2", "b3"]);
  });

  test("τ rất nhỏ cho nhiều cụm hơn nhưng không quá trần 6", () => {
    const eight: InterestItem[] = Array.from({ length: 8 }, (_, k) => ({
      id: `p${k}`,
      vector: [Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4), 0],
      ageDays: 0,
    }));
    expect(clusterInterests([...A, ...B], { distanceThreshold: 0.01 })).toHaveLength(6);
    expect(clusterInterests(eight, { distanceThreshold: 0.01 })).toHaveLength(6);
    expect(clusterInterests(eight, { distanceThreshold: 0.01, maxClusters: 3 })).toHaveLength(3);
  });

  test("công thức Ward: 3 điểm trên đường thẳng cắt đúng chỗ", () => {
    // Điểm 0, 1 và 10 trên trục x (không cần chuẩn hoá để thử khoảng cách).
    // Ward: gộp (0,1) ở chiều cao 1; sau đó gộp với 10: sqrt(2·2·1/3)·|0,5−10| = sqrt(4/3)·9,5 ≈ 10,97.
    const pts: InterestItem[] = [0, 1, 10].map((x, i) => ({
      id: `x${i}`,
      vector: [x, 0, 0],
      ageDays: 0,
    }));
    expect(clusterInterests(pts, { distanceThreshold: 0.99, minMembers: 1 })).toHaveLength(3);
    expect(clusterInterests(pts, { distanceThreshold: 1.01, minMembers: 1 })).toHaveLength(2);
    expect(clusterInterests(pts, { distanceThreshold: 10.9, minMembers: 1 })).toHaveLength(2);
    expect(clusterInterests(pts, { distanceThreshold: 11, minMembers: 1 })).toHaveLength(1);
  });

  test("cụm 1 đến 2 tin là pending và không đóng góp vào U", () => {
    const pair: InterestItem[] = [
      { id: "z1", vector: [0, 0, 1], ageDays: 0 },
      { id: "z2", vector: [0, 0, 1], ageDays: 0 },
    ];
    const out = clusterInterests([...A, ...pair], { distanceThreshold: 0.5 });
    const pending = out.find((c) => c.memberIds.includes("z1"));
    expect(pending?.status).toBe("pending");
    expect(out.filter((c) => c.status === "active")).toHaveLength(1);
    expect(interestScore([0, 0, 1], out)).toBe(0);
    expect(interestScore([R, R, 0], out)).toBeCloseTo(1, 12);
  });

  test("center, importance, medoid khớp ví dụ tính tay", () => {
    const [a] = clusterInterests(A, { distanceThreshold: 0.5 });
    expect(a?.importance).toBe(3);
    expect(a?.center[0]).toBeCloseTo(R, 12);
    expect(a?.center[1]).toBeCloseTo(R, 12);
    expect(a?.center[2]).toBeCloseTo(0, 12);
    expect(a?.medoid).toBe("a3");
  });

  test("trọng số theo tuổi vào center và importance", () => {
    // (1,0,0) trọng số 1 và (0,1,0) trọng số 0,5: tổng (1; 0,5; 0), chuẩn hoá chia sqrt(1,25).
    const out = clusterInterests(
      [
        { id: "u", vector: [1, 0, 0], ageDays: 0 },
        { id: "v", vector: [0, 1, 0], ageDays: 60 },
      ],
      { distanceThreshold: 10, minMembers: 2 },
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.importance).toBeCloseTo(1.5, 12);
    expect(out[0]?.center[0]).toBeCloseTo(1 / Math.sqrt(1.25), 12);
    expect(out[0]?.center[1]).toBeCloseTo(0.5 / Math.sqrt(1.25), 12);
    expect(out[0]?.medoid).toBe("u");
  });

  test("sắp theo importance giảm dần, hoà thì theo id thành viên nhỏ nhất", () => {
    const out = clusterInterests([...B, ...A], { distanceThreshold: 0.5 });
    expect(out[0]?.memberIds[0]).toBe("a1"); // hoà importance 3 và 3
    const heavy = clusterInterests([...A, ...B.map((b) => ({ ...b, ageDays: 60 }))], {
      distanceThreshold: 0.5,
    });
    expect(heavy[0]?.memberIds[0]).toBe("a1");
    const heavy2 = clusterInterests([...A.map((a) => ({ ...a, ageDays: 60 })), ...B], {
      distanceThreshold: 0.5,
    });
    expect(heavy2[0]?.memberIds[0]).toBe("b1");
  });

  test("không có tin nào thì không có cụm", () => {
    expect(clusterInterests([], { distanceThreshold: 1 })).toEqual([]);
  });
});

describe("interestScore", () => {
  const e1 = [1, 0, 0];
  const e2 = [0, 1, 0];
  const e3 = [0, 0, 1];
  const clusters = [
    cluster({ center: e1, importance: 6 }),
    cluster({ center: e2, importance: 3 }),
    cluster({ center: e3, importance: 100, status: "pending" }),
  ];

  test("π = 1 và 0,5: trùng tâm cụm lớn cho 1, trùng tâm cụm nhỏ cho sqrt(0,5)", () => {
    expect(interestScore(e1, clusters)).toBeCloseTo(1, 12);
    expect(interestScore(e2, clusters)).toBeCloseTo(Math.sqrt(0.5), 12);
  });

  test("lấy max theo cụm", () => {
    // Vector (R, R, 0): cos với e1 = R → 1·R; với e2 = R → sqrt(0,5)·R. Max = R.
    expect(interestScore([R, R, 0], clusters)).toBeCloseTo(R, 12);
  });

  test("cụm pending không tính; không có cụm active thì 0", () => {
    expect(interestScore(e3, clusters)).toBe(0);
    expect(interestScore(e1, [])).toBe(0);
    expect(interestScore(e1, [cluster({ center: e1, status: "pending" })])).toBe(0);
  });

  test("cosine âm kẹp về 0", () => {
    expect(interestScore([-1, 0, 0], [cluster({ center: e1, importance: 6 })])).toBe(0);
  });
});

describe("giữ tên cụm", () => {
  test("cụm mới gần cụm cũ nhận tên, dưới ngưỡng thì null", () => {
    const [a, b] = clusterInterests([...A, ...B], { distanceThreshold: 0.5 });
    expect(a).toBeDefined();
    const out = clusterInterests([...A, ...B], {
      distanceThreshold: 0.5,
      previous: [{ name: "Gu A", center: [R, R, 0.05] }],
      nameCarryMinCosine: 0.9,
    });
    expect(out[0]?.name).toBe("Gu A");
    expect(out[1]?.name).toBeNull();
    expect(b).toBeDefined();
  });

  test("hai cụm mới không cùng nhận một tên", () => {
    const g1: InterestItem[] = ["g1", "g2", "g3"].map((id) => ({
      id,
      vector: [1, 0, 0],
      ageDays: 0,
    }));
    const a30 = Math.PI / 6;
    const g2: InterestItem[] = ["h1", "h2", "h3"].map((id) => ({
      id,
      vector: [Math.cos(a30), Math.sin(a30), 0],
      ageDays: 0,
    }));
    const a15 = Math.PI / 12;
    const out = clusterInterests([...g1, ...g2], {
      distanceThreshold: 0.1,
      previous: [{ name: "Chung", center: [Math.cos(a15), Math.sin(a15), 0] }],
      nameCarryMinCosine: 0.9,
    });
    expect(out).toHaveLength(2);
    expect(out.filter((c) => c.name === "Chung")).toHaveLength(1);
    expect(out.filter((c) => c.name === null)).toHaveLength(1);
  });

  test("hai tên cũ gán đúng cho hai cụm gần nhất", () => {
    const out = clusterInterests([...A, ...B], {
      distanceThreshold: 0.5,
      previous: [
        { name: "Gu B", center: [0, -1, -0.1] },
        { name: "Gu A", center: [1, 1, 0] },
      ],
      nameCarryMinCosine: 0.5,
    });
    expect(out.map((c) => c.name)).toEqual(["Gu A", "Gu B"]);
  });
});

describe("xác định và hiệu năng", () => {
  test("gọi hai lần cho kết quả y hệt; đảo thứ tự đầu vào không đổi kết quả", () => {
    const items = [...A, ...B];
    const opts = { distanceThreshold: 0.5 };
    const first = clusterInterests(items, opts);
    expect(clusterInterests(items, opts)).toEqual(first);
    expect(clusterInterests([...items].reverse(), opts)).toEqual(first);
  });

  test("~100 tin 1024 chiều gom dưới 1 giây", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296 - 0.5;
    };
    const items: InterestItem[] = Array.from({ length: 100 }, (_, i) => {
      const v = Array.from({ length: 1024 }, rnd);
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      return { id: `t${i}`, vector: v.map((x) => x / n), ageDays: i };
    });
    const t0 = performance.now();
    const out = clusterInterests(items, { distanceThreshold: 1 });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(out.length).toBeLessThanOrEqual(6);
  });
});
