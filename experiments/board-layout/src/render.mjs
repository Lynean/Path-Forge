// Renderer: Placed -> SVG. Hai biến thể của CÙNG một dữ liệu:
//   sketch = nét phấn rough.js, chữ viết tay   |   snap = đường thẳng gọn, chữ in
import rough from "roughjs";
import { FS } from "./layout.mjs";

const gen = rough.generator();

export const BOARD_BG = "#1f2d28";
const CHALK = "#f3efe0";
export const KIND_COLOR = {
  step: CHALK, actor: "#ffd966", system: "#8ecae6", data: "#c9b6e4", note: "#b8b8b8",
  gate_auto: "#95d5b2", gate_human: "#ff8fa3", ok: "#95d5b2", warn: "#ffb703", stop: "#ff6b6b",
};
const HATCH = new Set(["gate_auto", "gate_human", "stop", "warn", "ok"]);
const FONT_SKETCH = `'Caveat','Patrick Hand','Segoe Print','Comic Sans MS',cursive`;
const FONT_SNAP = `Inter,'Segoe UI',system-ui,sans-serif`;

const mix = (hex, bg, t) => {
  const c = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [a, b] = [c(hex), c(bg)];
  return "#" + a.map((v, i) => Math.round(v * t + b[i] * (1 - t)).toString(16).padStart(2, "0")).join("");
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const f = (n) => +n.toFixed(1);

function pathEls(drawable, extraClass = "") {
  return gen
    .toPaths(drawable)
    .map((p) => `<path class="stroke ${extraClass}" pathLength="1" d="${p.d}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" fill="${p.fill ?? "none"}"/>`)
    .join("");
}

function beatIndex(P) {
  const pos = new Map();
  P.beats.forEach((b, i) => (b.reveal ?? []).forEach((id) => { if (!pos.has(id)) pos.set(id, i); }));
  const nodeBeat = (id) => pos.get(id) ?? 0;
  const groupBeat = (g) => {
    if (pos.has(g.id)) return pos.get(g.id);
    const members = P.nodes.filter((n) => n.group === g.id).map((n) => nodeBeat(n.id));
    return members.length ? Math.min(...members) : 0;
  };
  const edgeBeat = (e) => pos.get(e.id) ?? Math.max(nodeBeat(e.from), nodeBeat(e.to));
  return { nodeBeat, groupBeat, edgeBeat };
}

function textLines(lines, cx, cy, color, anchor = "middle") {
  const lh = FS * 1.3;
  const y0 = cy - ((lines.length - 1) * lh) / 2;
  return lines
    .map((l, i) => `<text class="lbl" x="${f(cx)}" y="${f(y0 + i * lh)}" fill="${color}" text-anchor="${anchor}" dominant-baseline="central">${esc(l)}</text>`)
    .join("");
}

function arrowHead(p, q, variant, color, seed) {
  // q = điểm cuối, p = điểm trước đó
  const ang = Math.atan2(q.y - p.y, q.x - p.x), L = 13, spread = 0.45;
  const a = { x: q.x - L * Math.cos(ang - spread), y: q.y - L * Math.sin(ang - spread) };
  const b = { x: q.x - L * Math.cos(ang + spread), y: q.y - L * Math.sin(ang + spread) };
  if (variant === "sketch") {
    const o = { stroke: color, strokeWidth: 2, roughness: 0.8, seed };
    return pathEls(gen.line(a.x, a.y, q.x, q.y, o)) + pathEls(gen.line(b.x, b.y, q.x, q.y, { ...o, seed: seed + 1 }));
  }
  return `<path class="stroke" pathLength="1" d="M${f(a.x)} ${f(a.y)}L${f(q.x)} ${f(q.y)}L${f(b.x)} ${f(b.y)}" stroke="${color}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
}

export function renderSVG(P, variant) {
  const { nodeBeat, groupBeat, edgeBeat } = beatIndex(P);
  const sketch = variant === "sketch";
  const font = sketch ? FONT_SKETCH : FONT_SNAP;
  const parts = [];
  const el = (beat, cls, inner, attrs = "") =>
    parts.push(`<g class="el ${cls}" data-beat="${beat}" ${attrs}>${inner}</g>`);

  // Ma trận: ô + tiêu đề
  for (const c of P.cells ?? []) {
    const o = { stroke: "#6f8a7e", strokeWidth: 1.4, roughness: 1, seed: hash(`${c.x}${c.y}`) };
    el(0, "cell", sketch ? pathEls(gen.rectangle(c.x, c.y, c.w, c.h, o)) : `<rect class="stroke" pathLength="1" x="${f(c.x)}" y="${f(c.y)}" width="${f(c.w)}" height="${f(c.h)}" rx="8" fill="none" stroke="#6f8a7e" stroke-width="1.4"/>`);
  }
  for (const h of P.headers ?? [])
    el(0, "hdr", `<text class="lbl hdr" x="${f(h.x + h.w / 2)}" y="${f(h.y + h.h / 2)}" fill="${CHALK}" text-anchor="middle" dominant-baseline="central" font-weight="700">${esc(h.text)}</text>`);

  // Groups (vẽ từ ngoài vào trong)
  for (const g of [...P.groups].sort((a, b) => a.depth - b.depth)) {
    const color = ["#7fa99b", "#d9c27a", "#c98fb0"][g.depth % 3];
    const o = { stroke: color, strokeWidth: 1.6, roughness: 1.1, strokeLineDash: [9, 7], seed: hash(g.id) };
    const shape = sketch
      ? pathEls(gen.rectangle(g.x, g.y, g.w, g.h, o))
      : `<rect class="stroke" x="${f(g.x)}" y="${f(g.y)}" width="${f(g.w)}" height="${f(g.h)}" rx="14" fill="none" stroke="${color}" stroke-width="1.6" stroke-dasharray="9 7"/>`;
    el(groupBeat(g), "group", shape + `<text class="lbl grp" x="${f(g.x + 14)}" y="${f(g.y + 24)}" fill="${color}" font-weight="700">${esc(g.label)}</text>`);
  }

  // Edges
  for (const e of P.edges) {
    const color = "#e8e2cf";
    const pts = e.points;
    let line;
    if (sketch) {
      line = pathEls(gen.linearPath(pts.map((p) => [p.x, p.y]), { stroke: color, strokeWidth: 2, roughness: 1, seed: hash(e.id) }));
    } else {
      line = `<path class="stroke" pathLength="1" d="M${pts.map((p) => `${f(p.x)} ${f(p.y)}`).join("L")}" stroke="${color}" stroke-width="2.2" fill="none" stroke-linejoin="round"/>`;
    }
    line += arrowHead(pts[pts.length - 2], pts[pts.length - 1], variant, color, hash(e.id) + 3);
    if (e.label && e.labelPos) {
      const lp = e.labelPos;
      line += `<text class="lbl elab" x="${f(lp.x + lp.w / 2)}" y="${f(lp.y + lp.h / 2)}" fill="#ffe08a" text-anchor="middle" dominant-baseline="central" font-size="${FS - 3}">${esc(e.label)}</text>`;
    }
    el(edgeBeat(e), "edge", line);
  }

  // Nodes
  for (const n of P.nodes) {
    const color = KIND_COLOR[n.kind] ?? CHALK;
    const hatch = HATCH.has(n.kind);
    const dash = n.kind === "note";
    let shape;
    if (sketch) {
      const o = {
        stroke: color, strokeWidth: n.kind === "gate_human" ? 2.8 : 2.2, roughness: 1.2, seed: hash(n.id),
        ...(hatch ? { fill: mix(color, BOARD_BG, 0.38), fillStyle: "hachure", hachureGap: 11, fillWeight: 0.7, hachureAngle: -40 } : {}),
        ...(dash ? { strokeLineDash: [7, 6] } : {}),
      };
      shape = pathEls(gen.rectangle(n.x, n.y, n.w, n.h, o));
    } else {
      shape = `<rect class="stroke" x="${f(n.x)}" y="${f(n.y)}" width="${f(n.w)}" height="${f(n.h)}" rx="10" stroke="${color}" stroke-width="${n.kind === "gate_human" ? 2.8 : 2.2}" fill="${hatch ? color : "none"}" fill-opacity="0.14"${dash ? ' stroke-dasharray="7 6"' : ""}/>`;
    }
    const txt = textLines(n.lines, n.x + n.w / 2, n.y + n.h / 2, CHALK);
    el(nodeBeat(n.id), `node k-${n.kind}`, shape + txt, `data-id="${n.id}" data-x="${f(n.x)}" data-y="${f(n.y)}" data-w="${f(n.w)}" data-h="${f(n.h)}"`);
  }

  return `<svg class="board ${variant}" data-variant="${variant}" viewBox="0 0 ${P.width} ${P.height}" xmlns="http://www.w3.org/2000/svg" style="--font:${font}" font-family="${font}" font-size="${FS}" role="img" aria-label="${esc(P.title)}"><rect width="100%" height="100%" fill="${BOARD_BG}"/>${parts.join("")}</svg>`;
}

const LEGEND = [
  ["actor", "người / vai trò"], ["system", "AI / hệ thống"], ["data", "artifact / dữ liệu"],
  ["gate_auto", "cổng cơ học (CI)"], ["gate_human", "cổng phán đoán (người)"], ["note", "ghi chú"],
];

export function renderHTML(boards) {
  const legend = LEGEND.map(([k, t]) => `<span><i style="background:${KIND_COLOR[k]}"></i>${t}</span>`).join("");
  const cards = boards
    .map((b, i) => {
      const badge = b.pass ? `<b class="ok">ĐẠT</b>` : `<b class="bad">CHƯA ĐẠT</b>`;
      const m = b.metrics;
      return `<section class="card" id="${b.P.id}" data-beats='${esc(JSON.stringify(b.P.beats.map((x) => x.say)))}'>
  <header><h2>${i + 1}. ${esc(b.P.title)}</h2>${badge}<small>${b.P.layout} · chồng ${m.nodeOverlap} · xuyên ${m.edgeThroughNode} · cắt ${m.edgeCrossings} · tràn chữ ${b.overflow ?? "?"}</small></header>
  <div class="stage">${b.sketch}${b.snap}</div>
  <div class="caption">&nbsp;</div>
  <footer><button data-act="play">▶ Giảng (sketch)</button><button data-act="snap">Snap</button><button data-act="all">Hiện hết</button></footer>
</section>`;
    })
    .join("\n");
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Board layout — thí nghiệm 1</title>
<style>
:root{--bg:#14201c;--fg:#f3efe0;--mut:#9db3a8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,system-ui,sans-serif;padding:24px 16px}
h1{font-size:20px;margin:0 0 6px}.legend{display:flex;flex-wrap:wrap;gap:6px 16px;color:var(--mut);font-size:13px;margin-bottom:20px}
.legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.grid{display:grid;gap:20px;max-width:1100px;margin:0 auto}
.card{background:#1a2924;border:1px solid #2c4037;border-radius:14px;padding:14px}
.card header{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px}.card h2{font-size:16px;margin:0}
.card small{color:var(--mut);margin-left:auto}b.ok{color:#95d5b2}b.bad{color:#ff6b6b}
.stage{margin:10px 0;background:#1f2d28;border-radius:10px;overflow:auto}svg.board{display:block;width:100%;height:auto;max-height:560px}
svg.snap{display:none}.stage.snapped svg.snap{display:block}.stage.snapped svg.sketch{display:none}
.caption{min-height:28px;color:#ffe08a;font-size:15px}
footer{display:flex;gap:8px}button{background:#2c4037;color:var(--fg);border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer;min-height:40px}
button:hover{background:#3a5448}.el.hide{opacity:0}.lbl{pointer-events:none}
</style></head><body>
<h1>Thí nghiệm 1 — AI dựng bố cục bảng phấn</h1>
<div class="legend">${legend}</div>
<div class="grid">${cards}</div>
<script>
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
document.querySelectorAll('.card').forEach(card=>{
  const stage=card.querySelector('.stage'),cap=card.querySelector('.caption'),beats=JSON.parse(card.dataset.beats);
  const svgs=[...card.querySelectorAll('svg')];let run=0;
  const els=()=>svgs.flatMap(s=>[...s.querySelectorAll('.el')]);
  const showAll=()=>{run++;els().forEach(e=>{e.classList.remove('hide');e.style.opacity=1;e.querySelectorAll('.stroke').forEach(p=>{p.style.transition='none';p.style.strokeDasharray='';p.style.strokeDashoffset=''})});cap.textContent=''};
  card.querySelector('[data-act=all]').onclick=showAll;
  card.querySelector('[data-act=snap]').onclick=()=>{stage.classList.toggle('snapped');showAll()};
  card.querySelector('[data-act=play]').onclick=async()=>{
    stage.classList.remove('snapped');const me=++run;
    els().forEach(e=>{e.style.opacity=0;e.querySelectorAll('.stroke').forEach(p=>{p.style.transition='none';p.style.strokeDasharray='1';p.style.strokeDashoffset='1'})});
    for(let i=0;i<beats.length;i++){
      if(me!==run)return;cap.textContent=beats[i];
      const cur=svgs[0].querySelectorAll('.el[data-beat="'+i+'"]');
      cur.forEach(e=>{e.style.opacity=1;e.querySelectorAll('.stroke').forEach(p=>{void p.getBoundingClientRect();p.style.transition='stroke-dashoffset .9s ease';p.style.strokeDashoffset='0'})});
      await sleep(1900);
    }
  };
});
</script></body></html>`;
}
