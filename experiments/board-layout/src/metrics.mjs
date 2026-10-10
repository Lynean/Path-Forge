// Bộ chấm điểm bố cục tự động (hình học). Tiêu chí đặt trước khi chạy thí nghiệm:
//   nodeOverlap = 0, edgeThroughNode = 0, nodeOutsideGroup = 0, edgeCrossings <= 1, textOverflow = 0
//   (bổ sung sau lần chạy đầu, khi mắt thấy lỗi mà số đo không thấy): backEdges = 0, maxDetour <= 4.0 (hiệu chỉnh sau khi xem ảnh: vòng xấu thật ≈4.5×, khuỷu của cây ≈3.5× vẫn đọc tốt)

const inset = (r, k) => ({ x: r.x + k, y: r.y + k, w: r.w - 2 * k, h: r.h - 2 * k });
const rectsIntersect = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function ccw(a, b, c) {
  return (c.y - a.y) * (b.x - a.x) - (b.y - a.y) * (c.x - a.x);
}
function segsCross(a, b, c, d) {
  const d1 = ccw(a, b, c), d2 = ccw(a, b, d), d3 = ccw(c, d, a), d4 = ccw(c, d, b);
  return d1 * d2 < 0 && d3 * d4 < 0; // giao cắt thật sự (bỏ qua chạm đầu mút / song song)
}
function segHitsRect(p, q, r) {
  const inside = (pt) => pt.x > r.x && pt.x < r.x + r.w && pt.y > r.y && pt.y < r.y + r.h;
  if (inside(p) || inside(q)) return true;
  const c = [
    { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
  ];
  for (let i = 0; i < 4; i++) if (segsCross(p, q, c[i], c[(i + 1) % 4])) return true;
  return false;
}

export function measure(P) {
  const issues = [];
  let nodeOverlap = 0, edgeThroughNode = 0, nodeOutsideGroup = 0, edgeCrossings = 0;

  for (let i = 0; i < P.nodes.length; i++)
    for (let j = i + 1; j < P.nodes.length; j++)
      if (rectsIntersect(P.nodes[i], P.nodes[j])) {
        nodeOverlap++;
        issues.push(`chồng: ${P.nodes[i].id} × ${P.nodes[j].id}`);
      }

  for (const n of P.nodes) {
    if (!n.group) continue;
    const g = P.groups.find((x) => x.id === n.group);
    if (n.x < g.x || n.y < g.y || n.x + n.w > g.x + g.w || n.y + n.h > g.y + g.h) {
      nodeOutsideGroup++;
      issues.push(`node ${n.id} lọt ra ngoài group ${g.id}`);
    }
  }

  for (const e of P.edges)
    for (const n of P.nodes) {
      if (n.id === e.from || n.id === e.to) continue;
      for (let k = 0; k < e.points.length - 1; k++)
        if (segHitsRect(e.points[k], e.points[k + 1], inset(n, 2))) {
          edgeThroughNode++;
          issues.push(`mũi tên ${e.id} đi xuyên node ${n.id}`);
          break;
        }
    }

  for (let i = 0; i < P.edges.length; i++)
    for (let j = i + 1; j < P.edges.length; j++) {
      const a = P.edges[i], b = P.edges[j];
      if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue;
      let hit = false;
      for (let s = 0; s < a.points.length - 1 && !hit; s++)
        for (let t = 0; t < b.points.length - 1 && !hit; t++)
          if (segsCross(a.points[s], a.points[s + 1], b.points[t], b.points[t + 1])) hit = true;
      if (hit) {
        edgeCrossings++;
        issues.push(`mũi tên cắt nhau: ${a.id} × ${b.id}`);
      }
    }

  // Đọc theo luồng: cạnh chạy ngược chiều (không đánh dấu feedback) và đường đi vòng
  let backEdges = 0, maxDetour = 1;
  const cx = (n) => n.x + n.w / 2, cy = (n) => n.y + n.h / 2;
  for (const e of P.edges) {
    const a = P.nodes.find((n) => n.id === e.from), b = P.nodes.find((n) => n.id === e.to);
    let len = 0;
    for (let k = 0; k < e.points.length - 1; k++) len += Math.hypot(e.points[k + 1].x - e.points[k].x, e.points[k + 1].y - e.points[k].y);
    // khoảng cách Manhattan giữa hai hộp (không tính phần bên trong hộp) = độ dài tối thiểu của một mũi tên
    const dx = Math.max(0, Math.abs(cx(b) - cx(a)) - (a.w + b.w) / 2), dy = Math.max(0, Math.abs(cy(b) - cy(a)) - (a.h + b.h) / 2);
    const straight = Math.max(30, dx + dy);
    const ratio = len / straight;
    if (!e.feedback) {
      maxDetour = Math.max(maxDetour, ratio);
      const back = P.dir === "DOWN" ? cy(b) < cy(a) - 4 : P.dir === "RIGHT" ? cx(b) < cx(a) - 4 : false;
      if (back) { backEdges++; issues.push(`mũi tên ${e.id} chạy ngược chiều đọc`); }
      if (ratio > 4.0) issues.push(`mũi tên ${e.id} đi vòng (dài gấp ${ratio.toFixed(1)} lần)`);
    }
  }
  const aspect = P.width / P.height;
  const scale = 1000 / P.width; // chữ hiển thị bao nhiêu % khi bảng rộng 1000px
  if (aspect > 5 || aspect < 0.3) issues.push(`tỉ lệ khung xấu: ${aspect.toFixed(1)}:1`);
  if (scale < 0.75) issues.push(`chữ quá nhỏ khi hiển thị (scale ${scale.toFixed(2)})`);
  return { nodeOverlap, edgeThroughNode, nodeOutsideGroup, edgeCrossings, backEdges, maxDetour: +maxDetour.toFixed(1), aspect: +aspect.toFixed(2), scale: +scale.toFixed(2), issues };
}

export function passes(m, textOverflow = 0) {
  return (
    m.nodeOverlap === 0 && m.edgeThroughNode === 0 && m.nodeOutsideGroup === 0 &&
    m.edgeCrossings <= 1 && textOverflow === 0 &&
    m.aspect <= 5 && m.aspect >= 0.3 && m.scale >= 0.75 && m.backEdges === 0 && m.maxDetour <= 4.0
  );
}
