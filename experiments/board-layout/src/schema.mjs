// Diagram = ngữ nghĩa thuần (AI sinh ra). Không có tọa độ.
// Hợp đồng này là thứ duy nhất LLM phải tuân theo; layout/render là xác định.

export const KINDS = [
  "step", "actor", "system", "data", "note",
  "gate_auto", "gate_human", "ok", "warn", "stop",
];
export const LAYOUTS = ["flow", "tree", "nested", "matrix"];
export const LIMITS = { maxNodes: 9, maxLabel: 40, maxBeats: 8 };

/** @returns {string[]} danh sách lỗi (rỗng = hợp lệ) */
export function validate(d) {
  const errs = [];
  const err = (m) => errs.push(`${d.id ?? "?"}: ${m}`);
  if (!d.id || !d.title) err("thiếu id/title");
  if (!LAYOUTS.includes(d.layout)) err(`layout "${d.layout}" không hợp lệ`);
  const nodes = d.nodes ?? [];
  if (nodes.length === 0) err("không có node");
  if (nodes.length > LIMITS.maxNodes) err(`quá nhiều node (${nodes.length} > ${LIMITS.maxNodes}) — nên tách Board`);
  const ids = new Set();
  for (const n of nodes) {
    if (ids.has(n.id)) err(`trùng id ${n.id}`);
    ids.add(n.id);
    if (!KINDS.includes(n.kind)) err(`node ${n.id}: kind "${n.kind}" không hợp lệ`);
    if (!n.label || n.label.length > LIMITS.maxLabel) err(`node ${n.id}: label rỗng hoặc > ${LIMITS.maxLabel} ký tự`);
    if (!n.src) err(`node ${n.id}: thiếu src (truy vết nguồn)`);
  }
  const groupIds = new Set((d.groups ?? []).map((g) => g.id));
  for (const g of d.groups ?? []) {
    if (g.parent && !groupIds.has(g.parent)) err(`group ${g.id}: parent không tồn tại`);
  }
  for (const n of nodes) {
    if (n.group && !groupIds.has(n.group)) err(`node ${n.id}: group không tồn tại`);
    if (d.layout === "matrix" && !n.cell) err(`node ${n.id}: matrix cần cell [row,col]`);
  }
  for (const e of d.edges ?? []) {
    if (!ids.has(e.from) || !ids.has(e.to)) err(`edge ${e.from}>${e.to}: node không tồn tại`);
  }
  if (d.layout === "nested" && (d.edges ?? []).length)
    err("layout nested chỉ biểu đạt quan hệ 'chứa trong' — luồng/mũi tên thuộc một Board khác (mỗi Board một ý)");
  const beats = d.beats ?? [];
  if (beats.length === 0 || beats.length > LIMITS.maxBeats) err(`số beat phải trong 1..${LIMITS.maxBeats}`);
  const revealed = new Set();
  for (const b of beats) {
    if (!b.say) err("beat thiếu lời giảng");
    for (const r of b.reveal ?? []) {
      if (!ids.has(r) && !groupIds.has(r) && !String(r).includes(">")) err(`beat reveal "${r}" không tồn tại`);
      revealed.add(r);
    }
  }
  for (const n of nodes) if (!revealed.has(n.id)) err(`node ${n.id} không xuất hiện trong beat nào`);
  return errs;
}
