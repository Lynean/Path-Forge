"""Sinh Diagram JSON từ một đoạn tri thức bằng LLM (OpenRouter).

CHƯA ĐƯỢC CHẠY THỬ: môi trường dựng thí nghiệm không có OPENROUTER_API_KEY.
Phần layout / render / chấm điểm (src/*.mjs) đã chạy trên các Diagram do người soạn tay.
Đây chính là bước còn lại cần kiểm chứng: LLM có sinh ra Diagram đạt schema + đạt bộ chấm không.

    OPENROUTER_API_KEY=... python3 generate.py doc.txt > samples/generated.json
    node src/run.mjs samples/generated.json out-generated
"""
import json
import os
import sys
import urllib.request

MODEL = os.environ.get("MODEL", "google/gemini-3.1-flash-lite")

SYSTEM = """Bạn là biên tập viên giáo trình. Biến đoạn tri thức thành các Board "thầy giảng bảng phấn".
Chỉ trả về JSON: một mảng Board. KHÔNG có tọa độ, KHÔNG có markdown.

Quy tắc:
- Mỗi Board dạy MỘT ý, giảng được trong 1-3 phút. Tối đa 9 node/Board; nhiều hơn thì tách Board.
- Sắp Board từ ý đơn giản nhất đến phức tạp nhất.
- label <= 40 ký tự, tiếng Việt, ngắn gọn. Không viết cả câu.
- Mọi node phải có "src": vị trí trong tài liệu gốc (mục/trang). Không bịa điều tài liệu không nói.
- layout chọn theo NỘI DUNG:
    flow   = quy trình, thứ tự bước, rẽ nhánh (mũi tên có hướng)
    tree   = phân cấp, phân loại, cơ cấu tổ chức
    nested = quan hệ "chứa trong" (vòng đồng tâm). KHÔNG có edges.
    matrix = so sánh 2x2 (cần "rows", "cols", và node.cell=[r,c])
- kind: step|actor|system|data|note|gate_auto|gate_human|ok|warn|stop
- Vòng lặp quay lại (vd FAIL -> làm lại): thêm "feedback": true vào edge đó, khai báo SAU cạnh đi tới.
- "beats": 2-6 bước giảng theo thứ tự. Mỗi beat: {"say": lời thầy nói, "reveal": [id node/group sẽ hiện]}.
  Mọi node phải xuất hiện trong ít nhất một beat.

Schema Board:
{"id","title","layout","direction"?:"RIGHT|DOWN","groups"?:[{"id","label","parent"?}],
 "nodes":[{"id","label","kind","group"?,"cell"?,"src"}],
 "edges":[{"from","to","label"?,"feedback"?}],"rows"?,"cols"?,
 "beats":[{"say","reveal":[...]}]}
"""


def call(text: str) -> list:
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": text}],
        "response_format": {"type": "json_object"},
        "max_tokens": 8192,
    }).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions", body,
        {"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}", "Content-Type": "application/json"},
    )
    out = json.load(urllib.request.urlopen(req, timeout=120))
    data = json.loads(out["choices"][0]["message"]["content"])
    return data if isinstance(data, list) else data.get("boards", [data])


if __name__ == "__main__":
    json.dump(call(open(sys.argv[1], encoding="utf-8").read()), sys.stdout, ensure_ascii=False, indent=2)
