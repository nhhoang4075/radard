# Ghi chú: RAM của radard và Postgres trên Railway (27/10/2026)

Ghi để đối chiếu với log `bộ nhớ` sau vài giờ. **Chưa deploy bản sửa nào.** Server đang chạy commit `ccd5703`
(chỉ thêm log bộ nhớ mỗi 5 phút ở `apps/daemon/src/main.ts`).

## Hiện tượng
- Tiến trình radard cũ chạy liên tục 11 ngày (deploy 16/10 10:47 → 27/10 22:51 giờ VN). Biểu đồ Railway: RAM ~870 MB phẳng, CPU ~0,1 vCPU.
- Ngay sau deploy 22:51: RAM radard tụt xuống ~100 MB, CPU gần 0. RAM Postgres tụt ~600 → ~500 MB.
- Ô "Memory usage" $4,34 là chi phí vài tuần đầu, chưa đủ một tháng.

## Mẫu log của tiến trình mới (UTC)
| Lúc | rssMb | heapUsedMb | externalMb |
|---|---|---|---|
| 15:57 | 98 | 16 | 7 |
| 16:02 | 105 | 17 | 7 |

## Đã đo, kết quả
1. **Cache `robots.txt`** (`packages/adapters/src/pages.ts:27`): Map theo trang web, không bao giờ xoá mục hết hạn. ~9 KB/mục;
   3.500 trang trong 11 ngày ≈ 30 MB (~3 MB/ngày). Rò thật nhưng nhỏ.
2. **Bộ đệm prepared statement** (Bun SQL, `packages/db/src/client.ts`): mỗi câu SQL khác nhau được nhớ trên từng kết nối.
   - Thí nghiệm 2.000 câu `inArray` độ dài khác nhau (400–2.400 tham số): Bun rss 37 → 151 MB (heap phẳng 4 MB), các tiến trình Postgres 4 → ~290 MB.
   - Mô phỏng đúng cấu trúc radard (~400 hình dạng câu: `insert doc_text` 6 tham số/dòng, `inArray` ở `signals.ts`, `fetch.ts`; pool mặc định): Postgres bão hoà ~124 MB, Bun gần như không tăng.
   - Kết luận: giải thích được phần Postgres tụt ~100 MB lúc restart, **không** giải thích 800 MB của radard.
3. **Số trang web khác nhau**: tải 1.500 trang khác nhau, Bun rss giữ ~12 MB. Loại.
4. Log tiến trình cũ (20–27/10): không có vòng lỗi hay cảnh báo lặp; chỉ đúng nhịp job.

## Đã thử và không dùng được
- `prepare: false` ở `createDatabase`: 63 test lỗi (JSON và ngày giờ truyền sai kiểu qua giao thức văn bản).
- `maxLifetime: 2` giây: cắt ngang câu lệnh đang chạy (`ERR_POSTGRES_LIFETIME_TIMEOUT`). Nếu dùng thì phải đặt vài chục phút.
- `pg_get_process_memory_contexts`: chưa có trong Postgres 18.6.
- `railway ssh`: cần đăng ký SSH key (chưa làm; `railway ssh keys github` báo không có quyền).

## Chưa biết
- 870 MB của radard nằm ở heap JS hay ngoài heap. Chỉ log `bộ nhớ` trả lời được.
- CPU ~0,1 vCPU liên tục ở tiến trình cũ nhưng ~0 ở tiến trình mới, dù công việc như nhau.

## Cách đối chiếu khi có log (nhắn Claude đọc log, hoặc chạy lệnh dưới)
`railway logs --service radard --lines 3000 | rg "bộ nhớ"`
- `heapUsedMb` tăng đều → chỗ giữ là đối tượng JS (tìm Map, mảng, closure sống lâu).
- `rssMb`/`externalMb` tăng mà heap phẳng → bộ nhớ ngoài heap (thư viện native, HTTP, S3, linkedom, pg của pg-boss).
- Không tăng sau 6 giờ → 870 MB cũ có thể do tình huống hiếm (ví dụ backfill, job lớn); xem lại log tiến trình cũ quanh lúc RAM nhảy.

## Hướng xử lý dự kiến (chưa làm)
- Xoá mục hết hạn của cache `robots.txt` (sửa rẻ).
- Thay `inArray(cột, danh sách)` bằng một tham số mảng (`= any($1::bigint[])`) ở `fetch.ts`, `signals.ts`, `rank.ts`, `digest.ts`, `topics.ts`, `repo-stats.ts`… để mọi độ dài chung một câu SQL.
- Chỉ làm khi log cho thấy đáng làm.

## Kết quả đọc log sau ~6 giờ (đọc 28/10, mẫu 15:57 → 21:47 UTC ngày 27/10, 71 dòng)
- rss 98 → 132 MB (đáy mỗi giờ: 117 lúc 16:12, 123 lúc 17:02, 133 lúc 19:02, 132 lúc 21:47). Đỉnh 153 MB lúc 21:12 rồi tụt về 135 MB (job lớn, bộ nhớ được trả lại).
- heapUsed phẳng quanh 21–22 MB (đáy), heapTotal 15 → 18 MB, external 9–10 MB (đáy), arrayBuffers ~0. **Heap JS không rò.**
- Phần ngoài heap (rss − heapTotal − external): 91 (16:12) → 96 (17:02) → 105 (19:02) → 104 (20:02) → 104 (21:47). Tăng ~13 MB trong 3 giờ đầu rồi phẳng 3 giờ sau.
- Kết luận tạm: không có rò trong đối tượng JS. Phần ngoài heap tăng chậm rồi có dấu hiệu bão hoà (khớp giả thuyết bộ đệm prepared statement/bộ nhớ native), nhưng 6 giờ chưa đủ để loại trừ rò chậm ~2 MB/giờ (11 ngày ≈ 500 MB). Cần mẫu 24–48 giờ.

## Kết quả đọc log sau ~2,9 ngày (27/10 15:57 → 30/10 14:12 UTC, 845 mẫu)
- rss đáy theo khối 6 giờ: 98 → 125 → 145 → 143 → 143 → 145 → 158 → 157 → 159 → 157 → 160 → 160 → 161 MB. Tăng nhanh ngày đầu rồi chậm dần (~+2 MB/ngày ngày thứ 3).
- heapUsed đáy: 16 → 21 → 24 → … → 31 MB, tăng đều ~3–5 MB/ngày. **Khớp cache robots.txt (~3 MB/ngày đã đo).** Ngoại suy 11 ngày ≈ +50 MB, không phải +800.
- Phần ngoài heap (rss − heapTotal − external), đáy: 76 → 113 (ngày 1) rồi đi ngang 105–120 MB suốt 2 ngày sau. Bão hoà, khớp bộ đệm prepared statement.
- Đỉnh rss 179–192 MB quanh 00:00–06:00 UTC (job lớn), trả lại sau đó.
- Kết luận: với code hiện tại radard ổn định ~160 MB và tăng ~5 MB/ngày. 870 MB của tiến trình cũ không tái hiện; nhiều khả năng do một sự kiện hiếm (job/backfill lớn) trong 11 ngày đó.

## Sự cố đình chỉ service (02/11 → 07/11/2026)
- 02/11: Railway đình chỉ service radard, lý do ghi "Compromised service detected" (không nêu tín hiệu). Log trước đó không có lỗi; bộ nhớ ổn định 135–152 MB.
- Đã làm: sao lưu DB (`pg_dump -Fc`, 548 MB, ngoài repo), đổi toàn bộ secret (Postgres, Telegram, AI Gateway, GitHub, R2), gửi appeal.
- 07/11: Railway gỡ đình chỉ. `railway redeploy` chạy lại bản cũ (commit "seed the topic library") nên crash do cột `description_en` đã đổi tên. Commit rỗng bị Railway bỏ qua ("No changes to watched files"). Sửa bằng `railway up`; deployment `ec88165e` SUCCESS.
- Sau khi chạy lại: tải bù 6 lần chạm trần 300 trang rồi về ~9 trang/lần; cache robots đạt 648 rồi về ~400 (bản sửa dọn cache hoạt động); 40 giờ đầu chưa bị gắn cờ lại.
- Bài học: không có cơ chế chạy bù bản tin các ngày đã lỡ; `railway redeploy` chạy lại đúng deployment cũ chứ không build từ main.
