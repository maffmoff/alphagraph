// FLOP（Flop Network）の立ち上がり監視。
// 設計の未決7（FLOPの実体確認）と §5 は、発行体側の公開物が出るまで確定できない。
// 人手で見に行くのは取りこぼすので、変化があった時だけ報せる形にする。
//
// 使い方: node tools/flop-watch.mjs [--state PATH] [--quiet]
// 変化があれば exit 1（cron から差分検知に使える）、無変化なら exit 0。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sha256 } from "../src/core.mjs";

const TARGETS = [
  // ノード実装とtestnetの入口。今はすべて404で、200になったら本番。
  { id: "site:testnet", url: "https://flop.finance/testnet/", watch: "status" },
  { id: "site:docs", url: "https://flop.finance/docs/", watch: "status" },
  { id: "site:yellowpaper", url: "https://flop.finance/yellowpaper/", watch: "status" },
  { id: "site:node", url: "https://flop.finance/node/", watch: "status" },
  // 仕様の改訂（figures are provisional と明記されているので動く）。
  { id: "site:teaser", url: "https://flop.finance/teaser/", watch: "body" },
  { id: "site:root", url: "https://flop.finance/", watch: "body" },
  // ノードソフトが出るならここに現れる。
  { id: "github:flop-labs", url: "https://api.github.com/orgs/flop-labs/repos?per_page=100&sort=updated", watch: "repos" },
];

// 本文は日付やアクセスカウンタで揺れることがあるので、比較前に落とす。
function normalizeBody(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "<ts>")
    .replace(/\s+/g, " ")
    .trim();
}

async function probe(target) {
  try {
    const response = await fetch(target.url, {
      redirect: "follow",
      headers: { "user-agent": "alphagraph-flop-watch" },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.text();
    if (target.watch === "status") return { status: response.status, mark: String(response.status) };
    if (target.watch === "repos") {
      const parsed = JSON.parse(body);
      const names = Array.isArray(parsed) ? parsed.map((repo) => repo.name).sort() : [];
      return { status: response.status, mark: names.join(","), detail: names };
    }
    const normalized = normalizeBody(body);
    return { status: response.status, mark: sha256(normalized), bytes: normalized.length };
  } catch (error) {
    return { status: "error", mark: `error:${error.name}`, error: error.message.slice(0, 120) };
  }
}

const args = process.argv.slice(2);
const statePath = resolve(args.includes("--state") ? args[args.indexOf("--state") + 1] : "artifacts/flop-watch.json");
const quiet = args.includes("--quiet");

const previous = existsSync(statePath) ? JSON.parse(await readFile(statePath, "utf8")) : { targets: {} };
const next = { schema: "alphagraph-flop-watch-v1", checkedAt: new Date().toISOString(), targets: {} };
const changes = [];

for (const target of TARGETS) {
  const result = await probe(target);
  next.targets[target.id] = result;
  const before = previous.targets?.[target.id];
  if (!before) {
    if (!quiet) console.log(`  baseline ${target.id.padEnd(20)} ${result.mark.slice(0, 24)}`);
    continue;
  }
  // エラーは一時的なことが多いので、変化として報せない（次回また見る）。
  if (result.status === "error" || before.status === "error") continue;
  if (before.mark !== result.mark) {
    changes.push({ id: target.id, url: target.url, before: before.mark.slice(0, 40), after: result.mark.slice(0, 40) });
  }
}

await mkdir(dirname(statePath), { recursive: true });
await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

if (!changes.length) {
  if (!quiet) console.log(`変化なし (${TARGETS.length} 件を確認 / ${next.checkedAt})`);
  process.exit(0);
}
console.log(`!! FLOP に変化 (${next.checkedAt})`);
for (const change of changes) {
  console.log(`  ${change.id}`);
  console.log(`    ${change.url}`);
  console.log(`    ${change.before} -> ${change.after}`);
}
process.exit(1);
