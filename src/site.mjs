import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hashJson, sha256 } from "./core.mjs";
import { CITATION_KINDS } from "./paper.mjs";
import { readLedger, verifyChain } from "./ledger.mjs";

// 台帳の静的投影（docs/ledger-design.md 部品4 / docs/mvp.md §4-4）。
// UIは独自の状態を持たない。ページは台帳から決定的に生成され、生成時刻を含まない——
// 誰でも再生成して「画面と台帳の一致」をハッシュで検証できるようにするため。
const KIND_STYLE = new Map([
  ["depends-on", { stroke: "#6b7280", dash: "5 4", label: "依拠" }],
  ["builds-on", { stroke: "#2563eb", dash: "none", label: "発展" }],
  ["refutes", { stroke: "#dc2626", dash: "none", label: "反証" }],
  ["contradicts", { stroke: "#dc2626", dash: "5 4", label: "否定" }],
]);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]
  ));
}

const shortHash = (value) => String(value).slice(0, 12);

// 引用は種別ごとに数える。符号なしの合計は作らない（docs/mvp.md §3）。
export function buildGraph(commitments) {
  const nodes = new Map();
  for (const commitment of commitments) {
    nodes.set(commitment.paperHash, {
      ...commitment,
      cites: commitment.citations ?? [],
      citedBy: [],
      counts: {},
    });
  }
  for (const node of nodes.values()) {
    for (const citation of node.cites) {
      const target = nodes.get(citation.paperHash);
      if (!target) continue; // 台帳外の論文を引いている場合は辺を描かない
      target.citedBy.push({ kind: citation.kind, paperHash: node.paperHash, id: node.id });
      target.counts[citation.kind] = (target.counts[citation.kind] ?? 0) + 1;
    }
  }
  // 深さ = 引用先の最大深さ + 1。循環は入力順で打ち切る（台帳は追記順なので親が先に載る）。
  const depth = new Map();
  const resolveDepth = (hash, seen = new Set()) => {
    if (depth.has(hash)) return depth.get(hash);
    if (seen.has(hash)) return 0;
    seen.add(hash);
    const node = nodes.get(hash);
    const parents = (node?.cites ?? []).filter((citation) => nodes.has(citation.paperHash));
    const value = parents.length ? Math.max(...parents.map((c) => resolveDepth(c.paperHash, seen))) + 1 : 0;
    depth.set(hash, value);
    return value;
  };
  for (const hash of nodes.keys()) resolveDepth(hash);
  return [...nodes.values()].map((node) => ({ ...node, depth: depth.get(node.paperHash) ?? 0 }));
}

const disclosureLabel = (disclosure) => (
  disclosure?.policy === "embargo" ? `猶予${disclosure.embargoDays}日` : "即時公開"
);

function renderGraph(graph) {
  if (!graph.length) return "<p class=\"empty\">まだ論文がありません。</p>";
  const columns = new Map();
  for (const node of graph) {
    if (!columns.has(node.depth)) columns.set(node.depth, []);
    columns.get(node.depth).push(node);
  }
  const columnWidth = 240;
  const rowHeight = 92;
  const boxWidth = 190;
  const boxHeight = 56;
  const position = new Map();
  for (const [column, members] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    members.forEach((node, row) => {
      position.set(node.paperHash, {
        x: 24 + column * columnWidth,
        y: 40 + row * rowHeight,
      });
    });
  }
  const width = 48 + Math.max(...[...columns.keys()]) * columnWidth + boxWidth;
  const height = 80 + Math.max(...[...columns.values()].map((m) => m.length)) * rowHeight;

  const edges = [];
  for (const node of graph) {
    const from = position.get(node.paperHash);
    for (const citation of node.cites) {
      const to = position.get(citation.paperHash);
      if (!to) continue;
      const style = KIND_STYLE.get(citation.kind) ?? KIND_STYLE.get("depends-on");
      // 引用は「引く側 → 引かれる側」。左に親、右に子が並ぶので線は右から左へ。
      const x1 = from.x;
      const y1 = from.y + boxHeight / 2;
      const x2 = to.x + boxWidth;
      const y2 = to.y + boxHeight / 2;
      const midpoint = (x1 + x2) / 2;
      edges.push(
        `<path d="M ${x1} ${y1} C ${midpoint} ${y1}, ${midpoint} ${y2}, ${x2} ${y2}" `
        + `fill="none" stroke="${style.stroke}" stroke-width="1.6" stroke-dasharray="${style.dash}" `
        + `marker-end="url(#arrow-${citation.kind})"><title>${escapeHtml(node.id)} ${escapeHtml(style.label)} ${escapeHtml(citation.paperHash.slice(0, 12))}</title></path>`,
      );
    }
  }

  const boxes = graph.map((node) => {
    const { x, y } = position.get(node.paperHash);
    const counts = Object.entries(node.counts).sort(([a], [b]) => a.localeCompare(b));
    const badge = counts.length
      ? counts.map(([kind, count]) => `${KIND_STYLE.get(kind)?.label ?? kind}${count}`).join(" ")
      : "";
    return `<g transform="translate(${x} ${y})">`
      + `<rect width="${boxWidth}" height="${boxHeight}" rx="8" class="node node-${escapeHtml(node.type)}"/>`
      + `<text x="12" y="22" class="node-id">${escapeHtml(node.id)}</text>`
      + `<text x="12" y="40" class="node-meta">${escapeHtml(node.type)} · ${escapeHtml(disclosureLabel(node.disclosure))}${badge ? ` · ${escapeHtml(badge)}` : ""}</text>`
      + "</g>";
  });

  const markers = [...KIND_STYLE.entries()].map(([kind, style]) => (
    `<marker id="arrow-${kind}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">`
    + `<path d="M 0 0 L 8 4 L 0 8 z" fill="${style.stroke}"/></marker>`
  )).join("");

  return `<div class="graph-scroll"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="引用グラフ">`
    + `<defs>${markers}</defs>${edges.join("")}${boxes.join("")}</svg></div>`;
}

function renderLegend() {
  const items = [...KIND_STYLE.entries()].map(([kind, style]) => {
    const sign = CITATION_KINDS.get(kind)?.sign ?? 0;
    const signLabel = sign > 0 ? "+" : sign < 0 ? "−" : "±0";
    return `<li><span class="swatch" style="border-color:${style.stroke};border-style:${style.dash === "none" ? "solid" : "dashed"}"></span>`
      + `<b>${escapeHtml(style.label)}</b> <code>${escapeHtml(kind)}</code> <span class="sign">${signLabel}</span> `
      + `${escapeHtml(CITATION_KINDS.get(kind)?.note ?? "")}</li>`;
  });
  return `<ul class="legend">${items.join("")}</ul>`;
}

const STYLE = `
:root{--bg:#fbfbfa;--fg:#1c1b1a;--muted:#6b7280;--line:#e5e3df;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#131313;--fg:#eceae6;--muted:#9a9691;--line:#2c2b29;--card:#1b1b1a}}
*{box-sizing:border-box}
body{margin:0;padding:32px 24px 64px;background:var(--bg);color:var(--fg);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:1040px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:36px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.lede{color:var(--muted);margin:0 0 24px}
.chain{display:flex;gap:20px;flex-wrap:wrap;padding:12px 16px;background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:8px}
.chain div{font-size:13px}.chain b{display:block;color:var(--muted);font-weight:500;font-size:11px;letter-spacing:.04em;text-transform:uppercase}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;color:var(--muted);font-weight:500;font-size:11px;letter-spacing:.04em;text-transform:uppercase;padding:6px 10px;border-bottom:1px solid var(--line)}
td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
.graph-scroll{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px}
svg text{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;fill:var(--fg)}
.node{fill:var(--card);stroke:var(--line);stroke-width:1.5}
.node-strategy{stroke:#b45309}.node-empirical{stroke:#2563eb}.node-dataset{stroke:#059669}
.node-refutation{stroke:#dc2626}.node-methods{stroke:#7c3aed}
.node-id{font-weight:600}.node-meta{fill:var(--muted);font-size:10.5px}
.legend{list-style:none;padding:0;margin:12px 0 0;font-size:13px}
.legend li{margin:5px 0;color:var(--muted)}
.legend b{color:var(--fg)}.legend .sign{font-family:ui-monospace,monospace}
.swatch{display:inline-block;width:22px;height:0;border-top-width:2px;border-top-style:inherit;vertical-align:middle;margin-right:8px}
.sealed{color:var(--muted)}.empty{color:var(--muted)}
footer{margin-top:40px;color:var(--muted);font-size:12.5px;border-top:1px solid var(--line);padding-top:14px}
a{color:inherit}
`;

function page(title, body) {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>
`;
}

export async function buildSite(ledgerDirectory, outputDirectory) {
  const events = await readLedger(ledgerDirectory);
  const chain = verifyChain(events);
  const sealed = events.filter((event) => event.type === "PAPER_SEALED");
  const sealedAt = new Map(sealed.map((event) => [event.data.paperHash, { at: event.at, seq: event.seq }]));
  const graph = buildGraph(sealed.map((event) => event.data));

  const rows = graph.map((node) => {
    const meta = sealedAt.get(node.paperHash);
    const counts = Object.entries(node.counts).sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, count]) => `${KIND_STYLE.get(kind)?.label ?? kind} ${count}`).join(" / ");
    const disclosure = disclosureLabel(node.disclosure);
    return "<tr>"
      + `<td><code>${escapeHtml(node.id)}</code></td>`
      + `<td>${escapeHtml(node.type)}</td>`
      + `<td>${escapeHtml(disclosure)}</td>`
      + `<td class="sealed">${escapeHtml(meta?.at ?? "")}<br><span class="sealed">seq ${escapeHtml(meta?.seq ?? "")}</span></td>`
      + `<td><code>${escapeHtml(shortHash(node.paperHash))}</code></td>`
      + `<td>${escapeHtml(node.cites.map((c) => `${KIND_STYLE.get(c.kind)?.label ?? c.kind}→${shortHash(c.paperHash)}`).join(" ")) || "—"}</td>`
      + `<td>${escapeHtml(counts) || "—"}</td>`
      + `<td>${node.dataPins?.length ?? 0}</td>`
      + "</tr>";
  });

  const body = "<h1>AlphaGraph — 台帳の投影</h1>"
    + "<p class=\"lede\">このページは台帳から決定的に生成されます。生成時刻を含まないので、"
    + "誰でも再生成してハッシュ一致を確かめられます。載っているのは封緘の公開部分だけで、"
    + "主張・機構・検証方法は猶予期間が明けるまで出ません。</p>"
    + "<div class=\"chain\">"
    + `<div><b>連鎖</b>${chain.valid ? "検証OK" : "破損"}</div>`
    + `<div><b>イベント数</b>${chain.events}</div>`
    + `<div><b>head</b><code>${escapeHtml(shortHash(chain.headHash))}</code></div>`
    + `<div><b>論文</b>${graph.length}</div>`
    + "</div>"
    + "<h2>引用グラフ</h2>"
    + renderGraph(graph)
    + renderLegend()
    + "<h2>封緘された論文</h2>"
    + "<table><thead><tr><th>id</th><th>型</th><th>公開</th><th>封緘</th><th>paperHash</th>"
    + "<th>引用する</th><th>引用される</th><th>データ釘</th></tr></thead>"
    + `<tbody>${rows.join("") || "<tr><td colspan=\"8\" class=\"empty\">まだありません</td></tr>"}</tbody></table>`
    + "<footer>引用は種別ごとに数えます。符号なしの被引用数は算出しません——"
    + "反証で引用された論文が高評価になる倒錯を型で塞ぐためです。</footer>";

  const html = page("AlphaGraph — 台帳の投影", body);
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = resolve(outputDirectory, "index.html");
  await writeFile(outputPath, html, "utf8");
  return {
    outputPath,
    papers: graph.length,
    events: chain.events,
    chainValid: chain.valid,
    headHash: chain.headHash,
    // 生成物のハッシュ。同じ台帳からは常に同じ値になる。
    pageSha256: sha256(html),
    ledgerProjection: hashJson(sealed.map((event) => event.data)),
  };
}
