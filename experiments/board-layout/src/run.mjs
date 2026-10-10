// Chạy cả pipeline: validate -> layout -> chấm điểm hình học -> render -> chụp màn hình + đo tràn chữ.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { validate } from "./schema.mjs";
import { layout } from "./layout.mjs";
import { measure, passes } from "./metrics.mjs";
import { renderSVG, renderHTML } from "./render.mjs";

const [, , input = "samples/agentic-engineering.json", outDir = "out"] = process.argv;
const diagrams = JSON.parse(fs.readFileSync(input, "utf8"));
fs.mkdirSync(outDir, { recursive: true });

const boards = [];
for (const d of diagrams) {
  const errs = validate(d);
  if (errs.length) {
    console.log(`✗ ${d.id} schema:`, errs.join("; "));
    continue;
  }
  // Vòng lặp "dàn thử -> chấm điểm -> chọn": thử vài mức xuống dòng của nhãn, lấy phương án đạt đầu tiên
  let best = null;
  const tries = [];
  for (const dir of [null, "DOWN"]) for (const wrapMax of [undefined, 16, 13, 11]) tries.push({ dir, wrapMax });
  for (const t of tries) {
    const P = await layout(t.dir ? { ...d, direction: t.dir } : d, t.wrapMax);
    const metrics = measure(P);
    const ok = passes(metrics);
    if (!best || (ok && !best.ok) || (!ok && !best.ok && metrics.issues.length < best.metrics.issues.length)) best = { P, metrics, ok, wrapMax: t.wrapMax, dir: t.dir };
    if (ok) break;
  }
  const { P, metrics, wrapMax, dir } = best;
  boards.push({ P, metrics, wrapMax, dir, sketch: renderSVG(P, "sketch"), snap: renderSVG(P, "snap") });
}

// Đo tràn chữ bằng trình duyệt thật (font thật), cho cả hai biến thể
const exe = fs.readdirSync("/opt/pw-browsers").filter((n) => /^chromium-\d+$/.test(n)).map((n) => `/opt/pw-browsers/${n}/chrome-linux/chrome`)[0];
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1.5 });
fs.writeFileSync(path.join(outDir, "index.html"), renderHTML(boards.map((b) => ({ ...b, overflow: "…" }))));
await page.goto("file://" + path.resolve(outDir, "index.html"));
await page.evaluate(() => document.querySelectorAll(".stage").forEach((s) => s.classList.add("snapped")));
const overflow = await page.evaluate(() => {
  const res = {};
  for (const card of document.querySelectorAll(".card")) {
    let n = 0;
    for (const svg of card.querySelectorAll("svg")) {
      const show = svg.style.display;
      svg.style.display = "block";
      for (const g of svg.querySelectorAll("g.node")) {
        const [x, y, w, h] = ["x", "y", "w", "h"].map((k) => +g.dataset[k]);
        for (const t of g.querySelectorAll("text")) {
          const b = t.getBBox();
          if (b.x < x + 2 || b.x + b.width > x + w - 2 || b.y < y || b.y + b.height > y + h) n++;
        }
      }
      svg.style.display = show;
    }
    res[card.id] = n;
  }
  return res;
});
for (const b of boards) b.overflow = overflow[b.P.id];
for (const b of boards) b.pass = passes(b.metrics, b.overflow);

fs.writeFileSync(path.join(outDir, "index.html"), renderHTML(boards));
await page.goto("file://" + path.resolve(outDir, "index.html"));
await page.evaluate(() => document.querySelectorAll(".stage").forEach((s) => s.classList.remove("snapped")));
for (const b of boards) {
  const card = await page.$(`#${b.P.id} .stage`);
  await card.screenshot({ path: path.join(outDir, `${b.P.id}-sketch.png`) });
}
await page.evaluate(() => document.querySelectorAll(".stage").forEach((s) => s.classList.add("snapped")));
for (const b of boards) {
  const card = await page.$(`#${b.P.id} .stage`);
  await card.screenshot({ path: path.join(outDir, `${b.P.id}-snap.png`) });
}
await browser.close();

console.log("\nid   layout  chồng xuyên cắt  ngoàiGroup tràn  tỉ lệ  wrap  kết quả");
for (const b of boards) {
  const m = b.metrics;
  console.log(`${b.P.id}  ${b.P.layout.padEnd(7)} ${String(m.nodeOverlap).padStart(4)} ${String(m.edgeThroughNode).padStart(5)} ${String(m.edgeCrossings).padStart(4)} ${String(m.nodeOutsideGroup).padStart(10)} ${String(b.overflow).padStart(4)}  ${String(m.aspect).padStart(5)}  ${String((b.wrapMax ?? "-") + (b.dir ? "↓" : "")).padStart(4)}  ${b.pass ? "ĐẠT" : "CHƯA"}`);
  for (const i of m.issues) console.log("       -", i);
}
const ok = boards.filter((b) => b.pass).length;
console.log(`\nĐạt tự động: ${ok}/${boards.length}`);
fs.writeFileSync(path.join(outDir, "metrics.json"), JSON.stringify(boards.map((b) => ({ id: b.P.id, ...b.metrics, overflow: b.overflow, pass: b.pass })), null, 2));
