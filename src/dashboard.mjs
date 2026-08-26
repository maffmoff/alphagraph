import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function metric(value, suffix = "") {
  return value === null || value === undefined ? "—" : `${Number(value).toFixed(2)}${suffix}`;
}

export function renderDashboard(reports) {
  const ordered = [...reports].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const rows = ordered.map((report) => {
    const metrics = report.metrics.outOfSample;
    const benchmark = report.metrics.benchmark?.outOfSample;
    const versusBenchmark = benchmark?.netReturnPct === null || benchmark?.netReturnPct === undefined
      ? null
      : metrics.netReturnPct - benchmark.netReturnPct;
    const status = report.gate.passedMechanicalGates ? "PASS" : "REVIEW";
    return `<tr>
      <td><span class="status ${status.toLowerCase()}">${status}</span></td>
      <td><strong>${escapeHtml(report.strategy.name)}</strong><small>${escapeHtml(report.strategy.id)}</small></td>
      <td>${escapeHtml(report.strategy.market.symbol)} · ${escapeHtml(report.strategy.market.interval)}</td>
      <td>${metric(metrics.netReturnPct, "%")}</td>
      <td>${metric(versusBenchmark, " pp")}</td>
      <td>${metric(metrics.sharpe)}</td>
      <td>${metric(metrics.maxDrawdownPct, "%")}</td>
      <td>${metrics.bars}</td>
      <td><code>${escapeHtml((report.data.sha256 ?? "unknown").slice(0, 10))}</code></td>
    </tr>`;
  }).join("\n");
  const passing = ordered.filter((report) => report.gate.passedMechanicalGates).length;
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>TradeCore — Proof of Useful Strategy</title>
  <style>
    :root{color-scheme:dark;--bg:#070a0f;--panel:#101721;--line:#273446;--text:#eef5ff;--muted:#8fa2b8;--lime:#b8ff64;--amber:#ffc857}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#163540 0,transparent 35%),var(--bg);color:var(--text);font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.wrap{max-width:1180px;margin:auto;padding:56px 24px}header{display:flex;justify-content:space-between;align-items:end;gap:24px;margin-bottom:32px}h1{margin:0;font-size:clamp(30px,5vw,64px);letter-spacing:-.06em}h1 span{color:var(--lime)}p{color:var(--muted);max-width:700px}.stats{display:flex;gap:12px}.card{border:1px solid var(--line);background:#0d141dcc;border-radius:14px;padding:12px 18px;min-width:110px}.card strong{display:block;font-size:24px;color:var(--lime)}.card small,td small{display:block;color:var(--muted)}.table{overflow:auto;border:1px solid var(--line);border-radius:16px;background:var(--panel)}table{width:100%;border-collapse:collapse;min-width:900px}th,td{text-align:left;padding:16px;border-bottom:1px solid var(--line)}th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.status{font-weight:800;font-size:12px;padding:5px 8px;border-radius:999px}.pass{background:#1c3b25;color:var(--lime)}.review{background:#3f321b;color:var(--amber)}code{color:#77d9ff}footer{margin-top:24px;color:var(--muted);font-size:12px}@media(max-width:700px){header{display:block}.stats{margin-top:20px}.wrap{padding:32px 16px}}
  </style>
</head>
<body><main class="wrap">
  <header><div><h1>Trade<span>Core</span></h1><p>AIが戦略を主張する場所ではなく、別DIDが再現・反証するための公開研究台帳。表示値は将来の利益を保証しません。</p></div><div class="stats"><div class="card"><strong>${ordered.length}</strong><small>reports</small></div><div class="card"><strong>${passing}</strong><small>mechanical pass</small></div></div></header>
  <section class="table"><table><thead><tr><th>Gate</th><th>Strategy</th><th>Market</th><th>OOS Return</th><th>vs B&amp;H</th><th>Sharpe</th><th>Max DD</th><th>Bars</th><th>Data hash</th></tr></thead><tbody>${rows || '<tr><td colspan="9">No reports yet.</td></tr>'}</tbody></table></section>
  <footer>Paper research only · No live execution · Every accepted result still needs independent DID reproduction and forward testing.</footer>
</main></body></html>`;
}

export async function buildDashboard(reportDirectory, outputPath) {
  let files = [];
  try {
    files = (await readdir(reportDirectory)).filter((file) => file.endsWith(".json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const reports = [];
  for (const file of files) {
    const report = JSON.parse(await readFile(join(reportDirectory, file), "utf8"));
    if (report.schema === "tradecore-backtest-v1") reports.push(report);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderDashboard(reports), "utf8");
  return { outputPath, reports: reports.length };
}
