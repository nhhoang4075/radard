/**
 * Interface nguồn. Lõi chỉ biết kiểu này; mỗi nguồn (HN, arXiv, GitHub…) là một adapter.
 *
 * Trạng thái của nguồn (con trỏ, ETag…) là `unknown` với lõi: adapter tự đọc và tự trả về
 * trạng thái mới. Nhờ vậy thêm một kiểu nguồn không cần đổi schema.
 */
import type { HttpClient } from "./http.ts";

/** Một mục thô lấy được từ nguồn, chưa qua xử lý nào. */
export interface RawItem {
  /** Id phía nguồn. Cùng với source_id là khoá idempotent của `documents`. */
  externalId: string;
  url: string;
  title?: string;
  publishedAt?: Date;
  /** Nội dung gốc đúng như nhận được (JSON, HTML, XML). Lưu nguyên vào ObjectStore. */
  body: string;
  contentType: string;
  /** Vài trường tiện tra cứu mà không phải mở bản thô (điểm, tác giả…). */
  meta?: Record<string, unknown>;
}

export interface FetchContext<C, S> {
  config: C;
  /** `undefined` ở lần chạy đầu. */
  state: S | undefined;
  http: HttpClient;
  now: Date;
}

export interface FetchResult<S> {
  items: RawItem[];
  /** Trạng thái để lần sau đọc tiếp. Chỉ được lưu khi lượt chạy thành công. */
  state: S;
  /** Server trả 304: không có gì mới, không phải lỗi. */
  notModified?: boolean;
  httpStatus?: number;
  /**
   * Lượt này dừng trước khi bắt kịp hiện tại (hết ngân sách, hoặc lỗi sau khi đã xong vài
   * cửa sổ). `items` và `state` chỉ gồm phần đã lấy đủ; lượt sau đọc tiếp từ đó. Ghi lý do.
   */
  behind?: string;
  /**
   * Số đo repo GitHub đọc được trong lượt này (trang Trending có tổng sao và "N stars today" của
   * mọi repo trên trang, kể cả repo đã là tài liệu từ trước). Job fetch ghi thẳng vào `repo_stats`
   * (chỉ ghi thêm), vì `documents` chỉ giữ một dòng mỗi repo. Nguồn khác không khai báo.
   */
  repoStats?: RepoObservation[];
}

/** Một lần đo repo GitHub, xem `repo_stats` trong @radard/db. */
export interface RepoObservation {
  /** `owner/repo`, job fetch tự viết thường. */
  repo: string;
  stars: number;
  forks: number | null;
  source: "github_stars" | "trending_daily";
  /** Số tăng nguồn tự báo ("N stars today"); radard tự chụp thì `null`. */
  reportedGain: number | null;
}

/**
 * Đi tiến theo các cửa sổ thời gian (lo, hi], mỗi cửa sổ không quá `cap` kết quả (giới hạn
 * phân trang của API), tới `end`. Con trỏ chỉ dời tới cuối cửa sổ ĐÃ LẤY ĐỦ, nên không bao
 * giờ có lỗ hổng: daemon tắt lâu thì các lượt sau lấp dần, không mất bài.
 *
 * `count(lo, hi)` trả tổng số kết quả của cửa sổ (kèm trang đầu để khỏi gọi lại), `fetchAll`
 * lấy hết cửa sổ. Thời gian là số nguyên theo đơn vị của nguồn (giây, phút…).
 */
export async function walkWindows<P, T>(opts: {
  start: number;
  end: number;
  cap: number;
  budget: number;
  count: (lo: number, hi: number) => Promise<{ total: number; first: P }>;
  fetchAll: (lo: number, hi: number, first: P) => Promise<T[]>;
}): Promise<{ items: T[]; coveredUntil: number; behind?: string }> {
  const items: T[] = [];
  let lo = opts.start;
  let span = Math.max(1, opts.end - lo);
  while (lo < opts.end) {
    if (items.length >= opts.budget) {
      return { items, coveredUntil: lo, behind: `hết ngân sách ${opts.budget} mục mỗi lượt` };
    }
    const hi = Math.min(opts.end, lo + span);
    let page: { total: number; first: P };
    try {
      page = await opts.count(lo, hi);
      if (page.total > opts.cap && hi - lo > 1) {
        // Cửa sổ quá đầy: thu hẹp một nửa rồi hỏi lại.
        span = Math.max(1, Math.floor((hi - lo) / 2));
        continue;
      }
      items.push(...(await opts.fetchAll(lo, hi, page.first)));
    } catch (err) {
      // Chưa xong cửa sổ nào thì báo lỗi như cũ; đã xong vài cửa sổ thì giữ phần đã có.
      if (lo === opts.start) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      return { items, coveredUntil: lo, behind: `lỗi giữa chừng: ${msg}`.slice(0, 500) };
    }
    lo = hi;
    span *= 2;
  }
  return { items, coveredUntil: lo };
}

export interface SourceAdapter<C = unknown, S = unknown> {
  readonly kind: string;
  fetch(ctx: FetchContext<C, S>): Promise<FetchResult<S>>;
  /**
   * Rút văn bản để embed từ bản thô của CHÍNH nguồn này (job process gọi). Không có thì job process
   * dùng tiêu đề. Đặt cạnh `fetch` vì chỉ adapter biết bản thô của nó có cấu trúc gì.
   */
  toText?(body: string, title: string | null): string;
  /**
   * Lấy lại tín hiệu cộng đồng MỚI NHẤT (điểm, bình luận…) của các tài liệu, theo `externalId`.
   * Gọi ngay trước khi xếp hạng: số lưu lúc lấy bài gần như luôn là lúc bài vừa đăng. Trả map
   * externalId → { tên tín hiệu: giá trị }; tài liệu không còn trên nguồn thì vắng mặt.
   */
  refreshSignals?(externalIds: string[], http: HttpClient): Promise<Map<string, Signals>>;
  /**
   * Mức cộng đồng quan tâm MỘT tài liệu, từ tín hiệu của nó, ở dạng CỘNG ĐƯỢC: các tài liệu cùng
   * nguồn trong một sự kiện được cộng lại rồi mới lấy ln (xep-hang.html tab 04). Nguồn không có
   * tín hiệu thì không khai báo hàm này: công thức dùng độ nổi trung tính.
   */
  engagement?(signals: Signals): number | null;
  /**
   * Trang thảo luận của tài liệu (bình luận HN…), khác với bài gốc ở `url`. Digest hiện nó thành
   * link "Thảo luận". Không có trang thảo luận riêng (hoặc `url` đã chính là trang đó) thì `null`;
   * nguồn không có thảo luận thì không khai báo hàm này.
   */
  discussionUrl?(externalId: string, url: string): string | null;
  /**
   * Trang chứa NỘI DUNG của tài liệu, khi bản thô của nguồn chỉ có tiêu đề và link (bài HN thường
   * là một link sang blog, GitHub, báo). Job `pages` tải trang này, job process embed tiêu đề cùng
   * phần chữ chính của trang. `null`: nội dung đã nằm trong bản thô (Ask HN). Nguồn có sẵn nội
   * dung (arXiv có abstract, GitHub có ghi chú phát hành) thì không khai báo hàm này.
   */
  articleUrl?(externalId: string, url: string): string | null;
}

/** Tín hiệu của một tài liệu: tên do adapter đặt (`hn_points`…) → giá trị. */
export type Signals = Record<string, number>;
