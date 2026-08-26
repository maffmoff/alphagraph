import assert from "node:assert/strict";
import test from "node:test";
import { renderDashboard } from "../src/dashboard.mjs";

test("renders report summaries and escapes untrusted strategy text", () => {
  const html = renderDashboard([{
    schema: "tradecore-backtest-v1",
    createdAt: "2026-08-26T00:00:00.000Z",
    strategy: {
      id: "unsafe-v1",
      name: "<script>alert(1)</script>",
      market: { symbol: "BTCUSDT", interval: "1h" },
    },
    data: { sha256: "0123456789abcdef" },
    metrics: {
      outOfSample: { netReturnPct: 2, sharpe: 1.2, maxDrawdownPct: 4, bars: 300 },
      benchmark: { outOfSample: { netReturnPct: 1.5 } },
    },
    gate: { passedMechanicalGates: true },
  }]);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /mechanical pass/);
});
