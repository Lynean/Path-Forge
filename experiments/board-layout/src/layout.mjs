// Layout xác định: Diagram (ngữ nghĩa) -> Placed (tọa độ). Không dùng AI.
import ELK from "elkjs/lib/elk.bundled.js";

const elk = new ELK();
export const FS = 18; // cỡ chữ
const CHAR_W = 0.6; // ước lượng độ rộng ký tự / cỡ chữ (an toàn cho tiếng Việt có dấu)
const LINE_H = FS * 1.3;

export function wrap(label, maxChars = 20) {
  const words = label.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > maxChars) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

function size(n, maxChars) {
  const lines = wrap(n.label, maxChars);
  const longest = Math.max(...lines.map((l) => l.length));
  return {
    lines,
    w: Math.max(110, Math.ceil(longest * FS * CHAR_W + 32)),
    h: Math.ceil(lines.length * LINE_H + 24),
  };
}

const ELK_OPTS = {
  algorithm: "layered",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": "36",
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  "elk.spacing.edgeNode": "20",
  "elk.spacing.edgeEdge": "14",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.separateConnectedComponents": "true",
  "elk.spacing.componentComponent": "40",
};

function isPureChain(d) {
  const indeg = new Map(), outdeg = new Map();
  for (const e of d.edges ?? []) {
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    outdeg.set(e.from, (outdeg.get(e.from) ?? 0) + 1);
  }
  return d.nodes.every((n) => (indeg.get(n.id) ?? 0) <= 1 && (outdeg.get(n.id) ?? 0) <= 1);
}

export async function layout(d, wrapMax) {
  if (d.layout === "matrix") return layoutMatrix(d, wrapMax);
  if (d.layout === "nested") return layoutNested(d, wrapMax);
  // Chuỗi thuần dài: khuôn "rắn bò" (hàng 1 đi phải, hàng 2 đi trái) — không để ELK gập dòng
  if (d.layout === "flow" && !(d.groups ?? []).length && d.nodes.length >= 6 && isPureChain(d)) return layoutSnake(d, wrapMax);

  const dir = d.layout === "tree" || d.layout === "nested" || d.direction === "DOWN" ? "DOWN" : "RIGHT";
  const maxChars = wrapMax ?? (d.layout === "tree" ? 24 : 20);
  const nodeBox = new Map(d.nodes.map((n) => [n.id, size(n, maxChars)]));

  const groupEl = new Map();
  for (const g of d.groups ?? []) {
    groupEl.set(g.id, {
      id: `g:${g.id}`,
      children: [],
      layoutOptions: {
        "elk.padding": "[top=44,left=22,bottom=22,right=22]",
        "elk.nodeLabels.placement": "H_LEFT V_TOP INSIDE",
      },
      labels: [{ text: g.label, width: g.label.length * FS * 0.55, height: 22 }],
    });
  }
  const root = {
    id: "__root__", // id nội bộ có namespace: id do AI sinh ra (vd "root") không được đụng vào
    layoutOptions: {
      ...ELK_OPTS, "elk.direction": dir,
    },
    children: [],
    edges: [],
  };
  for (const g of d.groups ?? []) {
    (g.parent ? groupEl.get(g.parent).children : root.children).push(groupEl.get(g.id));
  }
  for (const n of d.nodes) {
    const b = nodeBox.get(n.id);
    const el = { id: `n:${n.id}`, width: b.w, height: b.h };
    (n.group ? groupEl.get(n.group).children : root.children).push(el);
  }
  (d.edges ?? []).forEach((e, i) => {
    root.edges.push({
      id: `${e.from}>${e.to}`,
      // cạnh quay lại (feedback) đưa vào ELK theo chiều thuận để không phá việc chia tầng; đảo lại sau
      sources: [`n:${e.feedback ? e.to : e.from}`],
      targets: [`n:${e.feedback ? e.from : e.to}`],
      labels: e.label
        ? [{ text: e.label, width: e.label.length * FS * 0.5 + 8, height: 20 }]
        : [],
    });
  });

  const out = await elk.layout(root);

  const nodes = [];
  const groups = [];
  const abs = new Map([["__root__", { x: 0, y: 0 }]]); // ELK trả tọa độ con theo cha -> cộng dồn
  (function walk(el, ox, oy, depth) {
    for (const c of el.children ?? []) {
      const x = ox + c.x, y = oy + c.y;
      abs.set(c.id, { x, y });
      if (c.id.startsWith("g:")) {
        const gid = c.id.slice(2);
        groups.push({ id: gid, label: d.groups.find((g) => g.id === gid).label, x, y, w: c.width, h: c.height, depth });
        walk(c, x, y, depth + 1);
      } else {
        const nid = c.id.slice(2);
        const n = d.nodes.find((q) => q.id === nid);
        nodes.push({ ...n, x, y, w: c.width, h: c.height, lines: nodeBox.get(nid).lines });
      }
    }
  })(out, 0, 0, 0);

  const edges = (out.edges ?? []).map((e) => {
    const s = e.sections[0];
    const o = abs.get(e.container ?? "__root__") ?? { x: 0, y: 0 }; // tọa độ cạnh theo container
    let points = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x + o.x, y: p.y + o.y }));
    const src = d.edges.find((x) => `${x.from}>${x.to}` === e.id);
    const { from, to } = src;
    if (src.feedback) points = points.reverse();
    const lab = e.labels?.[0];
    return {
      id: e.id, from, to, points,
      label: src.label, feedback: !!src.feedback,
      labelPos: lab ? { x: lab.x + o.x, y: lab.y + o.y, w: lab.width, h: lab.height } : null,
    };
  });

  return finish(d, nodes, groups, edges, { dir });
}

function layoutMatrix(d, wrapMax) {
  const CW = 300, CH = 130, HX = 130, HY = 46, GAP = 16;
  const nodes = [];
  const nrows = d.rows.length, ncols = d.cols.length;
  for (const n of d.nodes) {
    const [r, c] = n.cell;
    const b = size(n, wrapMax ? Math.min(wrapMax, 20) : 20);
    const w = CW - 32; // node điền gần hết ô; chữ đã được wrap để vừa
    nodes.push({
      ...n,
      x: HX + c * (CW + GAP) + (CW - w) / 2,
      y: HY + r * (CH + GAP) + (CH - b.h) / 2,
      w, h: b.h, lines: b.lines,
    });
  }
  const headers = [
    ...d.cols.map((t, c) => ({ text: t, x: HX + c * (CW + GAP), y: 0, w: CW, h: HY - 8 })),
    ...d.rows.map((t, r) => ({ text: t, x: 0, y: HY + r * (CH + GAP), w: HX - 10, h: CH })),
  ];
  const cells = [];
  for (let r = 0; r < nrows; r++)
    for (let c = 0; c < ncols; c++)
      cells.push({ x: HX + c * (CW + GAP), y: HY + r * (CH + GAP), w: CW, h: CH });
  return finish(d, nodes, [], [], { headers, cells });
}

function finish(d, nodes, groups, edges, extra = {}) {
  const xs = [], ys = [];
  const rects = [...nodes, ...groups, ...(extra.cells ?? []), ...(extra.headers ?? [])];
  for (const r of rects) { xs.push(r.x, r.x + r.w); ys.push(r.y, r.y + r.h); }
  for (const e of edges) for (const p of e.points) { xs.push(p.x); ys.push(p.y); }
  const pad = 24;
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  const maxX = Math.max(...xs) + pad, maxY = Math.max(...ys) + pad;
  const sh = (o) => ({ ...o, x: o.x - minX, y: o.y - minY });
  return {
    id: d.id, title: d.title, layout: d.layout, beats: d.beats, src: d.src, dir: extra.dir ?? null,
    width: Math.ceil(maxX - minX), height: Math.ceil(maxY - minY),
    nodes: nodes.map(sh), groups: groups.map(sh),
    edges: edges.map((e) => ({
      ...e,
      points: e.points.map((p) => ({ x: p.x - minX, y: p.y - minY })),
      labelPos: e.labelPos && sh(e.labelPos),
    })),
    headers: (extra.headers ?? []).map(sh),
    cells: (extra.cells ?? []).map(sh),
  };
}

// ---- Khuôn "rắn bò": chuỗi thuần dài. Hàng lẻ đi ngược lại để mũi tên luôn ngắn và thứ tự đọc liền mạch.
function layoutSnake(d, wrapMax) {
  const COLS = 3, GX = 80, GY = 64;
  const order = [];
  const next = new Map(d.edges.map((e) => [e.from, e.to]));
  const hasIn = new Set(d.edges.map((e) => e.to));
  let cur = d.nodes.find((n) => !hasIn.has(n.id))?.id;
  while (cur) { order.push(cur); cur = next.get(cur); }
  const sizes = new Map(d.nodes.map((n) => [n.id, size(n, wrapMax ?? 20)]));
  const cw = Math.max(...[...sizes.values()].map((b) => b.w));
  const ch = Math.max(...[...sizes.values()].map((b) => b.h));
  const nodes = [], pos = new Map();
  order.forEach((id, i) => {
    const r = Math.floor(i / COLS);
    const c = r % 2 === 0 ? i % COLS : COLS - 1 - (i % COLS);
    const b = sizes.get(id);
    const n = { ...d.nodes.find((q) => q.id === id), x: c * (cw + GX), y: r * (ch + GY), w: cw, h: ch, lines: b.lines };
    nodes.push(n); pos.set(id, { n, r, c });
  });
  const edges = d.edges.map((e) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    const A = a.n, B = b.n;
    let pts;
    if (a.r === b.r) {
      const right = B.x > A.x;
      pts = [{ x: right ? A.x + A.w : A.x, y: A.y + A.h / 2 }, { x: right ? B.x : B.x + B.w, y: B.y + B.h / 2 }];
    } else pts = [{ x: A.x + A.w / 2, y: A.y + A.h }, { x: B.x + B.w / 2, y: B.y }];
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    return {
      id: `${e.from}>${e.to}`, from: e.from, to: e.to, points: pts, label: e.label, feedback: false,
      labelPos: e.label ? { x: mid.x - 30, y: mid.y - 24, w: 60, h: 20 } : null,
    };
  });
  return finish(d, nodes, [], edges, { dir: null });
}

// ---- Khuôn "vòng đồng tâm" (nested): chỉ biểu đạt "chứa trong". Vòng ngoài ở trên, lõi ở trong cùng.
function layoutNested(d, wrapMax) {
  const PAD = 24, TOP = 46, GAP = 22;
  const sizes = new Map(d.nodes.map((n) => [n.id, size(n, wrapMax ?? 22)]));
  const kids = (pid) => (d.groups ?? []).filter((g) => (g.parent ?? null) === pid);
  const own = (gid) => d.nodes.filter((n) => (n.group ?? null) === gid);
  const rowSize = (ns) => ({
    w: ns.reduce((a, n) => a + sizes.get(n.id).w, 0) + Math.max(0, ns.length - 1) * GAP,
    h: ns.length ? Math.max(...ns.map((n) => sizes.get(n.id).h)) : 0,
  });
  const nodes = [], groups = [];
  // build(gid) -> {w,h,place(x,y,depth)}
  function build(gid) {
    const ns = own(gid), ks = kids(gid).map((g) => ({ g, b: build(g.id) }));
    const row = rowSize(ns);
    const kw = ks.reduce((a, k) => a + k.b.w, 0) + Math.max(0, ks.length - 1) * GAP;
    const kh = ks.length ? Math.max(...ks.map((k) => k.b.h)) : 0;
    const iw = Math.max(row.w, kw), ih = row.h + (ns.length && ks.length ? GAP : 0) + kh;
    const top = gid === null ? 0 : TOP, pad = gid === null ? 0 : PAD;
    const w = iw + 2 * pad, h = ih + top + pad;
    return {
      w, h,
      place(x, y, depth) {
        if (gid !== null) groups.push({ id: gid, label: d.groups.find((g) => g.id === gid).label, x, y, w, h, depth });
        let cx = x + pad + (iw - row.w) / 2;
        for (const n of ns) {
          const b = sizes.get(n.id);
          nodes.push({ ...n, x: cx, y: y + top + (row.h - b.h) / 2, w: b.w, h: b.h, lines: b.lines });
          cx += b.w + GAP;
        }
        let kx = x + pad + (iw - kw) / 2;
        const ky = y + top + row.h + (ns.length ? GAP : 0);
        for (const k of ks) { k.b.place(kx, ky + (kh - k.b.h) / 2, depth + 1); kx += k.b.w + GAP; }
      },
    };
  }
  const root = build(null);
  root.place(0, 0, -1);
  return finish(d, nodes, groups, [], { dir: null });
}
