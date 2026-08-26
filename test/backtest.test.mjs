import assert from "node:assert/strict";
import test from "node:test";
import {
  generateSyntheticCsv,
  parseOhlcvCsv,
  runBacktest,
  validateStrategy,
} from "../src/backtest.mjs";
import { sha256 } from "../src/core.mjs";

const strategy = {
  schema: "tradecore-strategy-v1",
  id: "btc-test-v1",
  name: "Test strategy",
  hypothesis: "A deterministic test hypothesis.",
  market: { venue: "test", symbol: "BTCUSDT", interval: "1h" },
  rules: { type: "sma-cross", fast: 8, slow: 24, position: "long_only" },
  costs: { feeBps: 10, slippageBps: 5 },
  evaluation: { holdoutFraction: 0.3, minHoldoutBars: 100, maxDrawdownPct: 30 },
};

test("validates and normalizes the supported strategy", () => {
  assert.deepEqual(validateStrategy(strategy), strategy);
  assert.throws(
    () => validateStrategy({ ...strategy, rules: { ...strategy.rules, fast: 30 } }),
    /fast must be smaller/,
  );
});

test("parses deterministic OHLCV and produces repeatable metrics", () => {
  const csv = generateSyntheticCsv({ bars: 800 });
  const bars = parseOhlcvCsv(csv);
  assert.equal(bars.length, 800);
  const first = runBacktest(strategy, bars, { dataHash: sha256(csv), dataLabel: "fixture" });
  const second = runBacktest(strategy, bars, { dataHash: sha256(csv), dataLabel: "fixture" });
  assert.deepEqual(first.metrics, second.metrics);
  assert.equal(first.strategyHash, second.strategyHash);
  assert.equal(first.metrics.outOfSample.bars, 233);
  assert.equal(first.metrics.benchmark.outOfSample.bars, 233);
  assert.equal(first.metrics.benchmark.outOfSample.transactions, 2);
  assert.equal(typeof first.gate.passedMechanicalGates, "boolean");
  assert.match(first.engine.timing, /next bar open/);
});

test("rejects malformed or time-reversed market data", () => {
  assert.throws(
    () => parseOhlcvCsv("timestamp,open,high,low,close,volume\n2025-01-02,1,2,0.5,1,1\n2025-01-01,1,2,0.5,1,1\n"),
    /strictly increasing/,
  );
  assert.throws(
    () => parseOhlcvCsv("timestamp,open,high,low,close,volume\n2025-01-01,2,1,0.5,2,1\n2025-01-02,2,2,1,2,1\n"),
    /inconsistent OHLC/,
  );
});

test("includes costs on every position change", () => {
  const bars = parseOhlcvCsv(generateSyntheticCsv({ bars: 500 }));
  const free = runBacktest({ ...strategy, costs: { feeBps: 0, slippageBps: 0 } }, bars);
  const costly = runBacktest(strategy, bars);
  assert.ok(costly.metrics.all.netReturnPct <= free.metrics.all.netReturnPct);
});
