import assert from "node:assert/strict";
import test from "node:test";
import { generateSyntheticCsv, parseOhlcvCsv, runBacktest } from "../src/backtest.mjs";
import { sha256 } from "../src/core.mjs";
import { REPRO_CONTRACT_HASH, canonicalizeReport, compareReports, reproHashes } from "../src/repro.mjs";

const strategy = {
  schema: "alphagraph-strategy-v1",
  id: "btc-test-v1",
  name: "Test strategy",
  hypothesis: "A deterministic test hypothesis.",
  market: { venue: "test", symbol: "BTCUSDT", interval: "1h" },
  rules: { type: "sma-cross", fast: 8, slow: 24, position: "long_only" },
  costs: { feeBps: 10, slippageBps: 5 },
  evaluation: { holdoutFraction: 0.3, minHoldoutBars: 100, maxDrawdownPct: 30 },
};

function report({ bars = 800, label = "fixture", overrides = {} } = {}) {
  const csv = generateSyntheticCsv({ bars });
  const built = runBacktest(strategy, parseOhlcvCsv(csv), { dataHash: sha256(csv), dataLabel: label });
  return { ...built, ...overrides };
}

test("the canonical form drops every non-deterministic field", () => {
  const canonical = canonicalizeReport(report());
  assert.equal("createdAt" in canonical, false);
  assert.equal("proposal" in canonical, false);
  assert.equal("reproduction" in canonical, false);
  assert.equal("label" in canonical.data, false);
  assert.equal("provenance" in canonical.data, false);
  assert.equal(canonical.data.sha256.length, 64);
});

test("an honest re-run reproduces the author hash despite different metadata", () => {
  const author = report({ label: "author-data.csv" });
  const candidate = report({ label: "downloaded.csv" });
  // 実行時刻・保存ファイル名・封緘ラッパは著者と再現者で必ず異なる。
  author.createdAt = "2026-01-01T00:00:00.000Z";
  candidate.createdAt = "2026-06-30T23:59:59.999Z";
  author.proposal = { file: "proposal.json", sha256: "a".repeat(64), strategyHash: author.strategyHash };
  author.reproduction = reproHashes(author);
  assert.notEqual(JSON.stringify(author), JSON.stringify(candidate));

  const result = compareReports(author, candidate);
  assert.equal(result.verdict, "match");
  assert.equal(result.reproduced, true);
  assert.deepEqual(result.differences, []);
  assert.equal(result.contractHash, REPRO_CONTRACT_HASH);
});

test("embedding the reproduction block does not change the canonical hash", () => {
  const plain = report();
  const stamped = { ...plain, reproduction: reproHashes(plain) };
  assert.equal(reproHashes(stamped).canonicalHash, reproHashes(plain).canonicalHash);
});

test("a different engine version is environment drift, not a failed reproduction", () => {
  const author = report();
  const candidate = report();
  candidate.engine = { ...candidate.engine, version: "0.3.0" };
  const result = compareReports(author, candidate);
  assert.equal(result.verdict, "environment-drift");
  assert.equal(result.reproduced, false);
  assert.deepEqual(result.differences, ["engine.version"]);
});

test("a changed number is a mismatch and names the differing path", () => {
  const author = report();
  const candidate = report();
  candidate.metrics = {
    ...candidate.metrics,
    outOfSample: { ...candidate.metrics.outOfSample, sharpe: candidate.metrics.outOfSample.sharpe + 1 },
  };
  const result = compareReports(author, candidate);
  assert.equal(result.verdict, "mismatch");
  assert.ok(result.differences.includes("metrics.outOfSample.sharpe"));
});

test("a different sealed code or dataset is not a grade-1 reproduction at all", () => {
  const author = report();
  const candidate = report({ bars: 900 });
  assert.equal(compareReports(author, candidate).verdict, "different-subject");

  const forked = report();
  forked.strategy = { ...forked.strategy, rules: { ...forked.strategy.rules, fast: 9 } };
  forked.strategyHash = `${"0".repeat(63)}1`;
  assert.equal(compareReports(author, forked).verdict, "different-subject");
});

test("the contract itself is hash-pinned", () => {
  assert.equal(REPRO_CONTRACT_HASH.length, 64);
  assert.equal(reproHashes(report()).contractHash, REPRO_CONTRACT_HASH);
});
