import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../src/ledger.mjs";
import { buildGraph, buildSite, networkMetrics } from "../src/site.mjs";

const hash = (character) => character.repeat(64);

const commitment = (id, type, citations = [], disclosure = { policy: "immediate" }) => ({
  paperHash: hash(id.slice(-1)),
  type,
  id,
  disclosure,
  citations,
  dataPins: [{ seriesId: "hl:BTC:1d", sha256: hash("f"), redistributable: true }],
});

test("the graph counts citations per kind and never as a bare total", () => {
  const target = commitment("ag-a", "empirical");
  const supporter = commitment("ag-b", "strategy", [{ kind: "builds-on", paperHash: target.paperHash }]);
  const attacker = commitment("ag-c", "refutation", [{ kind: "refutes", paperHash: target.paperHash }]);
  const graph = buildGraph([target, supporter, attacker]);
  const node = graph.find((entry) => entry.id === "ag-a");
  assert.deepEqual(node.counts, { "builds-on": 1, refutes: 1 });
  // 合計を持たない: 反証と発展を足した数字はどこにも存在しない。
  assert.equal("total" in node, false);
  assert.equal("citationCount" in node, false);
});

test("depth follows the citation lineage", () => {
  const root = commitment("ag-a", "dataset");
  const middle = commitment("ag-b", "empirical", [{ kind: "depends-on", paperHash: root.paperHash }]);
  const leaf = commitment("ag-c", "strategy", [{ kind: "builds-on", paperHash: middle.paperHash }]);
  const graph = buildGraph([root, middle, leaf]);
  const depth = Object.fromEntries(graph.map((node) => [node.id, node.depth]));
  assert.deepEqual(depth, { "ag-a": 0, "ag-b": 1, "ag-c": 2 });
});

test("a citation to a paper outside the ledger draws no edge", () => {
  const node = commitment("ag-a", "strategy", [{ kind: "depends-on", paperHash: hash("9") }]);
  const graph = buildGraph([node]);
  assert.equal(graph.length, 1);
  assert.equal(graph[0].depth, 0);
});

test("the instrument measures connection and reproduction, not paper count", () => {
  const root = commitment("ag-a", "dataset");
  const child = commitment("ag-b", "empirical", [{ kind: "depends-on", paperHash: root.paperHash }]);
  const lonely = commitment("ag-c", "strategy");
  const graph = buildGraph([root, child, lonely]);

  const empty = networkMetrics(graph, []);
  assert.equal(empty.papers, 3);
  assert.equal(empty.connected, 2);
  assert.equal(empty.isolated, 1);
  assert.equal(empty.connectedRate, 66.7);
  assert.equal(empty.reproducedRate, 0);

  const measured = networkMetrics(graph, [
    { verdict: "match", paperHash: root.paperHash },
    // 不成立の再現は再現率に数えない。試行としては残る。
    { verdict: "mismatch", paperHash: child.paperHash },
    // 台帳外の論文への再現も数えない。
    { verdict: "match", paperHash: hash("9") },
  ]);
  assert.equal(measured.reproducedPapers, 1);
  assert.equal(measured.reproducedRate, 33.3);
  assert.equal(measured.reproductionAttempts, 3);
});

test("a citation that only points outward still counts the citing paper as connected", () => {
  const root = commitment("ag-a", "dataset");
  const child = commitment("ag-b", "empirical", [{ kind: "depends-on", paperHash: root.paperHash }]);
  const metrics = networkMetrics(buildGraph([root, child]), []);
  assert.equal(metrics.isolated, 0);
});

test("the projection is deterministic and escapes untrusted ledger text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphagraph-site-"));
  const output = await mkdtemp(join(tmpdir(), "alphagraph-out-"));
  try {
    const { privateKey } = generateKeyPairSync("ed25519");
    const hostile = {
      ...commitment("ag-a", "dataset"),
      // 台帳は追記されたものをそのまま持つので、投影側で必ず逃がす。
      citations: [{ kind: "depends-on", paperHash: hash("b"), note: "<script>alert(1)</script>" }],
    };
    await appendEvent(directory, { type: "PAPER_SEALED", data: hostile, privateKey, at: "2026-01-01T00:00:00.000Z" });
    await appendEvent(directory, {
      type: "PAPER_SEALED",
      data: commitment("ag-b", "strategy", [{ kind: "builds-on", paperHash: hostile.paperHash }], { policy: "embargo", embargoDays: 90 }),
      privateKey,
      at: "2026-01-02T00:00:00.000Z",
    });

    const first = await buildSite(directory, output);
    const second = await buildSite(directory, output);
    assert.equal(first.pageSha256, second.pageSha256, "the same ledger must project to the same page");
    assert.equal(first.papers, 2);
    assert.equal(first.chainValid, true);

    const html = await readFile(first.outputPath, "utf8");
    assert.equal(html.includes("<script>alert(1)</script>"), false);
    assert.ok(html.includes("猶予90日"));
    assert.ok(html.includes("即時公開"));
    // 生成時刻を含まない（含めば再生成のたびにハッシュが変わる）。
    assert.equal(/generated|生成日時/.test(html), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});
