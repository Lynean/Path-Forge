# Thí nghiệm 1 — AI có tự dựng được bố cục bảng phấn không?

Thí nghiệm độc lập, không phụ thuộc app PathForge. Câu hỏi: từ một tài liệu thật, có sinh được **Board**
(sơ đồ giảng theo từng bước) mà không cần chỉnh tay không?

Tài liệu mẫu: "Đề xuất Mô hình Agentic Engineering v4" (15 mục, ~30 bảng) → rút thành 10 Board.

## Kiến trúc

```
Diagram (ngữ nghĩa thuần, KHÔNG tọa độ)   <- LLM sinh (generate.py), hoặc người soạn tay (samples/)
   │  src/schema.mjs   validate: <=9 node, label <=40 ký tự, mọi node có src, mọi node có beat...
   ▼
Layout xác định (src/layout.mjs)           <- KHÔNG dùng AI
   │   flow/tree  -> ELK (layered, orthogonal)
   │   flow dài   -> khuôn "rắn bò" (tự viết)
   │   nested     -> khuôn "vòng đồng tâm" (tự viết)
   │   matrix     -> khuôn lưới 2x2 (tự viết)
   ▼
Chấm điểm hình học (src/metrics.mjs) + đo tràn chữ bằng Chromium thật (src/run.mjs)
   ▼
Render (src/render.mjs): cùng một dữ liệu, hai biến thể  sketch (nét phấn rough.js, vẽ dần theo beat)
                                                          snap   (đường gọn, chữ in)
```

Chạy: `npm i && node src/run.mjs` → mở `out/index.html` (bấm "▶ Giảng", "Snap", "Hiện hết").

## Kết quả

10/10 Board đạt bộ chấm tự động **và** đạt khi xem bằng mắt (sau khi sửa). Nhưng đường đến đó mới là phát hiện chính:

| Lần chạy | Đạt tự động | Mắt thấy | Ghi chú |
|---|---|---|---|
| 1 | 5/7 (3 Board bị schema loại) | — | 3 nhãn >40 ký tự bị chặn: giới hạn schema có tác dụng |
| 2 | 10/10 | **4 Board xấu** | Bộ đo chỉ có chồng lấn/xuyên/cắt nên bỏ sót mũi tên chạy vòng, cạnh ngược chiều |
| 3 | 3/10 | — | Thêm tiêu chí `backEdges`, `maxDetour` → lộ lỗi thật (và lỗi công thức đo của chính mình) |
| 4 | 10/10 | Đạt | Sau khi thêm khuôn riêng + vòng lặp tìm kiếm bên dưới |

### Phát hiện

1. **Một bộ layout tổng quát không đủ — cần "khuôn" theo loại nội dung.** ELK làm tốt flow và tree, nhưng:
   chuỗi dài bị gập thành mũi tên quấn vòng (→ khuôn rắn bò); vòng đồng tâm bị vẽ thành mũi tên chạy loạn
   (→ khuôn nested tự viết); ma trận 2x2 không phải đồ thị (→ khuôn lưới).
   Vì vậy LLM nên **chọn `layout`**, không chọn vị trí.
2. **Vòng lặp "dàn thử → chấm điểm → chọn" cứu được các ca biên** (b03, b10): thử nhiều mức xuống dòng của
   nhãn và cả hướng dọc/ngang, lấy phương án đạt đầu tiên. Rẻ vì layout là xác định.
3. **Bộ chấm quyết định chất lượng.** Bản đầu báo 10/10 trong khi mắt thấy 4 Board kém. Tiêu chí phải có
   cả hình học lẫn "dễ đọc" (ngược chiều, đường vòng, chữ quá nhỏ khi hiển thị).
4. **Schema nên có luật theo khuôn:** `nested` cấm `edges` (mỗi Board một ý: chứa-trong HOẶC luồng, không trộn).
5. **Đừng để id do AI sinh ra chạm vào id nội bộ** — id `root` từng ghi đè gốc tọa độ của ELK và làm lệch
   toàn bộ mũi tên. Mọi id đưa vào layout engine đều phải có namespace.
6. Cạnh quay lại (FAIL → làm lại) cần cờ `feedback` tường minh, nếu không ELK tự đảo chiều tuỳ ý.

## Điều CHƯA được kiểm chứng (đọc kỹ)

- **LLM thật có sinh được Diagram đạt không?** Môi trường dựng thí nghiệm không có API key. 10 Diagram ở
  `samples/` do người (tôi) soạn tay, nên kết quả này chỉ chứng minh **layout + render + chấm điểm khả thi**,
  chưa chứng minh **AI tự sinh khả thi**. `generate.py` đã viết sẵn nhưng chưa chạy. Đây là bước kế tiếp.
- **Ngưỡng chấm được hiệu chỉnh sau khi xem ảnh** (đặc biệt `maxDetour <= 4.0`). Không phải ngưỡng đặt trước thuần túy.
- **Cảm giác "tay viết, ấm"**: máy dựng không có font chữ viết tay (ảnh sketch dùng font serif thay thế). Nét vẽ
  rough.js đã có, chữ chưa. Cần thử Caveat/Patrick Hand (có hỗ trợ tiếng Việt) rồi cho người thật xem.
- **Chưa có người chấm.** Phần "người lạ xem có hiểu không" (thang 1-5) chưa làm; mọi nhận xét "đọc rõ" ở trên là của tôi.
- Lỗi thẩm mỹ còn lại: group (b03, b05) thừa khoảng trống bên trái do ELK chừa chỗ cho nhãn group.
- Mẫu chỉ có 10 Board từ MỘT tài liệu, toàn nội dung quy trình/tổ chức. Chưa thử nội dung kiểu kiến trúc hệ thống,
  vòng lặp phức tạp, hay Board có 9 node dày đặc.
- Phần Sketch→Snap hiện chỉ là chuyển giữa hai biến thể; chưa có hiệu ứng "nét tay tự căn thẳng" như ý tưởng ban đầu.
- Chưa có giọng đọc (TTS) và đồng bộ lời giảng với nét vẽ; lời giảng chỉ hiện dạng chữ.
