import assert from "node:assert/strict";
import test from "node:test";
import { fetchBinanceKlines } from "../src/market-data.mjs";

function kline(timestamp, open) {
  return [timestamp, String(open), String(open + 2), String(open - 2), String(open + 1), "10"];
}

test("downloads paginated Binance klines and records provenance", async () => {
  const start = Date.parse("2025-01-01T00:00:00Z");
  const firstPage = Array.from({ length: 1000 }, (_, index) => kline(start + (index * 3_600_000), 100 + index));
  const secondPage = [kline(start + (1000 * 3_600_000), 1100)];
  let calls = 0;
  const result = await fetchBinanceKlines({
    symbol: "BTCUSDT",
    interval: "1h",
    start: new Date(start).toISOString(),
    end: new Date(start + (1001 * 3_600_000)).toISOString(),
  }, async () => {
    calls += 1;
    return Response.json(calls === 1 ? firstPage : secondPage);
  });
  assert.equal(calls, 2);
  assert.equal(result.provenance.received.bars, 1001);
  assert.equal(result.provenance.received.unexpectedIntervalGaps, 0);
  assert.match(result.csv, /^timestamp,open,high,low,close,volume/);
  assert.equal(result.provenance.csvSha256.length, 64);
});

test("rejects provider errors and non-advancing data", async () => {
  await assert.rejects(
    fetchBinanceKlines({
      symbol: "BTCUSDT",
      interval: "1h",
      start: "2025-01-01T00:00:00Z",
      end: "2025-01-02T00:00:00Z",
    }, async () => new Response("blocked", { status: 403 })),
    /HTTP 403/,
  );
});
