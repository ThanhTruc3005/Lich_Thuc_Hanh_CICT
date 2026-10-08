# CTU Practice Reminder

Theo dõi lịch thực hành từ Google Spreadsheet công khai của trường.
Sinh viên nhập **mã môn + nhóm** → web tự tìm buổi thực hành, phát hiện lịch đổi, nhắc trước buổi học.

> Quy tắc quan trọng: lịch trường **chỉ có Sáng / Chiều, không có giờ cụ thể**.
> App không bao giờ tự suy đoán hay hiển thị giờ giả (07:00, 13:00, ...).

## 1. Cài đặt

Yêu cầu: **Node.js >= 18** (khuyên dùng Node 22+). Không cần cài thêm gì.

```bash
npm install   # không có dependency ngoài, lệnh này chỉ để chắc chắn
```

## 2. Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng web |
| `DB_PATH` | `./data/app.db` | File SQLite |
| `SPREADSHEET_ID` | (ID lịch trường) | Google Spreadsheet nguồn |
| `SHEET_SOURCES` | `T01:1201125911` | Seed/dự phòng khi discovery thất bại |
| `SYNC_INTERVAL_MIN` | `30` | Tự đồng bộ mỗi N phút (`0` = tắt) |
| `DISCOVERY_TTL_MIN` | `360` | Đọc lại danh sách tab mỗi N phút (`0` = mỗi lần sync) |

Xem `.env.example`. Trên PowerShell: `$env:PORT=3000; npm start`.

## 3. Chạy local

```bash
npm start
# Mở http://localhost:3000
```

Lần khởi động đầu tiên server tự đồng bộ T01 từ Google Sheet (chạy nền).
Bấm **↻ Đồng bộ** trên web để cập nhật thủ công (giới hạn 1 phút/lần).

## 4. Database (SQLite, built-in `node:sqlite`)

File tại `DB_PATH`, tự tạo khi chạy. Bảng:

- `sessions` — mỗi ô lịch là 1 dòng, khóa ổn định `identity_key = gid|ngày|buổi|mã|nhóm`
  nên sync lại không bao giờ trùng. Dòng bị xóa ở sheet gốc được giữ lại với `active=0`.
- `subscriptions` — `(client_id, course_code, group_code)` duy nhất, không login.
- `notifications` — `NEW_SESSION`, `SCHEDULE_CHANGED`, `SCHEDULE_REMOVED`, `UPCOMING`
  (dedup bằng `UNIQUE(subscription, type, session, ngày)`).
- `session_changes` — lịch sử đổi phòng/GV/môn từng buổi.
- `sync_state` — trạng thái đồng bộ từng tuần.

## 5. Nguồn Google Sheet (source of truth)

Public HTML + CSV export, fetch **phía server** (tránh CORS trình duyệt).
Không hard-code gid từng tuần, không copy lịch vào source:

```
GET /edit                     -> phát hiện tab (tên + gid) từ HTML public
GET /export?format=csv&gid=.. -> dữ liệu từng tuần (khi đã biết gid)
GET /gviz/tq?sheet=TÊN         -> dự phòng khi chưa biết gid
```

`src/sheet/discovery.js` tự liệt kê tab mỗi lần sync (cache theo
`DISCOVERY_TTL_MIN`, fallback: probe tên `T00..TNN`, cuối cùng là `SHEET_SOURCES`).
Tab mới (ví dụ `T19`) được nhận ở lần sync sau mà không cần sửa code;
tab không phải dạng tuần bị bỏ qua. Database chỉ là cache: sheet lỗi thì
giữ dữ liệu cũ, ghi `ERROR` vào `sync_state`, lần sau thử lại.

## 6. Cơ chế sync & nhắc

- `syncWeek()` trong `src/sync.js`: parse → so sánh theo `identity_key` →
  thêm mới / cập nhật + ghi `session_changes` + tạo notification đổi/hủy.
- Nhắc dựa trên **ngày + Sáng/Chiều** (`Hôm nay / Ngày mai / Còn N ngày`),
  tạo idempotent cho các buổi trong 7 ngày tới.
- Kênh thông báo là abstraction (`channels` trong `src/reminders.js`):
  MVP dùng `inapp` (xem ở mục 🔔 trên web); Telegram/Web Push cắm thêm sau
  mà không phải sửa sync hay UI logic.
- Production: giữ nguyên `SYNC_INTERVAL_MIN`, hoặc gọi `POST /api/sync`
  từ cron ngoài (Vercel Cron / systemd timer) và đặt `SYNC_INTERVAL_MIN=0`.

## 7. API

Mọi API user-scoped dùng header `X-Client-Id` (web tự sinh UUID, lưu localStorage).

| Method | Endpoint | Mô tả |
|---|---|---|
| `POST` | `/api/subscriptions` | `{courseCode, groupCode}` → tạo (201) hoặc trả về có sẵn (200) + lịch khớp |
| `GET` | `/api/subscriptions` | Danh sách đang theo dõi |
| `DELETE` | `/api/subscriptions/:id` | Bỏ theo dõi (chỉ chủ sở hữu) |
| `GET` | `/api/schedules` | Buổi sắp tới của các môn đang theo dõi |
| `GET` | `/api/notifications` | Nhắc + cảnh báo đổi/hủy lịch |
| `POST` | `/api/sync` | Đồng bộ thủ công `{refreshSheets?: bool}` (rate-limit 1 phút) |
| `GET` | `/api/sync/status` | `{lastSyncAt, status, worksheets, sessions}` |
| `GET` | `/api/status` | Trạng thái sync chi tiết từng tuần |
| `GET` | `/api/status` | Trạng thái sync từng tuần |

## 8. Test

```bash
npm test   # 36 tests: parser (17, giữ nguyên) + validation + store + sync + reminders
```

## 9. Deploy gợi ý (đơn giản nhất)

- VPS nhỏ: `node src/server.js` sau reverse proxy (Caddy/Nginx), `DB_PATH` trỏ vào
  volume persistent, `SYNC_INTERVAL_MIN=30`.
- Hoặc bất kỳ PaaS nào chạy được Node 22+ với disk persistent cho file `.db`.
- Không cần thêm service nào (không queue, không worker riêng, không auth).
