import assert from "node:assert/strict";
import test from "node:test";
import { generateSyntheticCsv, parseOhlcvCsv, runBacktest } from "../src/backtest.mjs";
import { sha256 } from "../src/core.mjs";
import { REPRO_CONTRACT_HASH, reproHashes } from "../src/repro.mjs";

// 等級1再現の環境間不変量（golden parity）。
// 固定入力に対する正規形ハッシュを定数で釘付けし、OS・Node版・CPUが変わっても
// 同じ値が出ることをCIのマトリクスで常時証明する。浮動小数の差はここで即座に落ちる。
// この定数が変わってよいのは、engine.version の意図的な更新か、正規形の契約を
// 変えた時だけ。その場合は台帳イベントとして扱い、定数の再固定を明示的に行う。
const GOLDEN = {
  csvSha256: "8c1e578e7ba72c257b01f77bd6e5e053ee4a18772a550fe675c719a6658de3d6",
  contractHash: "3edce959b890e880357c27f6d997134e4e248221e3790d271573e1434680209e",
  metricsHash: "c1ca512b245d2c4fac6aae0f7a0a4a3cf3c5cfa04b077e1f116ab7c95dd4c0fb",
  canonicalHash: "92d17c2c3f79428699c08e05140911dae5df47982755386bdd525b9cf59fb846",
  outOfSampleSharpe: 3.974947,
};

const strategy = {
  schema: "alphagraph-strategy-v1",
  id: "golden-sma-v1",
  name: "Golden fixture strategy",
  hypothesis: "Fixed fixture for cross-environment determinism.",
  market: { venue: "test", symbol: "BTCUSDT", interval: "1h" },
  rules: { type: "sma-cross", fast: 8, slow: 24, position: "long_only" },
  costs: { feeBps: 10, slippageBps: 5 },
  evaluation: { holdoutFraction: 0.3, minHoldoutBars: 100, maxDrawdownPct: 30 },
};

test("the golden fixture hashes are invariant across environments", () => {
  const csv = generateSyntheticCsv({ bars: 2400 });
  const dataHash = sha256(csv);
  assert.equal(dataHash, GOLDEN.csvSha256, "synthetic data generation drifted");

  const report = runBacktest(strategy, parseOhlcvCsv(csv), { dataHash, dataLabel: "golden" });
  assert.equal(report.metrics.outOfSample.sharpe, GOLDEN.outOfSampleSharpe, "floating point result drifted");

  const hashes = reproHashes(report);
  assert.equal(hashes.contractHash, GOLDEN.contractHash, "the reproduction contract changed");
  assert.equal(hashes.metricsHash, GOLDEN.metricsHash, "metrics hash drifted");
  assert.equal(hashes.canonicalHash, GOLDEN.canonicalHash, "canonical hash drifted");
  assert.equal(REPRO_CONTRACT_HASH, GOLDEN.contractHash);
});
