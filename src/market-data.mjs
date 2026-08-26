import { assertNumber, assertString, sha256 } from "./core.mjs";

const INTERVAL_MS = new Map([
  ["1m", 60_000],
  ["5m", 300_000],
  ["15m", 900_000],
  ["1h", 3_600_000],
  ["4h", 14_400_000],
  ["1d", 86_400_000],
]);

function timestamp(value, label) {
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO-8601 timestamp.`);
  return parsed;
}

function csvNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Binance returned an invalid ${label}.`);
  return parsed;
}

export async function fetchBinanceKlines(options, fetchImpl = fetch) {
  const symbol = assertString(options.symbol, "symbol", {
    max: 30,
    pattern: /^[A-Z0-9]+$/,
  });
  const interval = assertString(options.interval, "interval", { max: 4 });
  const intervalMs = INTERVAL_MS.get(interval);
  if (!intervalMs) throw new Error(`Unsupported Binance interval: ${interval}.`);
  const startMs = timestamp(options.start, "start");
  const endExclusiveMs = timestamp(options.end, "end");
  if (endExclusiveMs <= startMs) throw new Error("end must be after start.");
  const maxBars = assertNumber(options.maxBars ?? 100_000, "maxBars", {
    min: 1,
    max: 1_000_000,
    integer: true,
  });
  const endpoint = "https://data-api.binance.vision/api/v3/klines";
  const rows = [];
  let cursor = startMs;
  let requests = 0;

  while (cursor < endExclusiveMs) {
    const url = new URL(endpoint);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(endExclusiveMs - 1));
    url.searchParams.set("limit", "1000");
    const response = await fetchImpl(url, { redirect: "error" });
    const body = await response.text();
    if (!response.ok) throw new Error(`Binance market-data API returned HTTP ${response.status}: ${body.slice(0, 300)}`);
    let page;
    try {
      page = JSON.parse(body);
    } catch {
      throw new Error("Binance market-data API returned invalid JSON.");
    }
    if (!Array.isArray(page)) throw new Error("Binance market-data API returned an unexpected payload.");
    requests += 1;
    if (!page.length) break;
    for (const item of page) {
      if (!Array.isArray(item) || item.length < 6) throw new Error("Binance returned a malformed kline row.");
      const openTime = csvNumber(item[0], "open time");
      if (openTime < startMs || openTime >= endExclusiveMs) continue;
      if (rows.length && openTime <= rows.at(-1).openTime) throw new Error("Binance klines are duplicated or out of order.");
      rows.push({
        openTime,
        open: csvNumber(item[1], "open"),
        high: csvNumber(item[2], "high"),
        low: csvNumber(item[3], "low"),
        close: csvNumber(item[4], "close"),
        volume: csvNumber(item[5], "volume"),
      });
      if (rows.length > maxBars) throw new Error(`Download exceeds the configured maximum of ${maxBars} bars.`);
    }
    const lastOpen = Number(page.at(-1)?.[0]);
    const nextCursor = lastOpen + intervalMs;
    if (!Number.isFinite(nextCursor) || nextCursor <= cursor) throw new Error("Binance pagination did not advance.");
    cursor = nextCursor;
    if (page.length < 1000) break;
  }
  if (!rows.length) throw new Error("Binance returned no klines for the requested range.");

  const csvRows = ["timestamp,open,high,low,close,volume"];
  for (const row of rows) {
    csvRows.push([
      new Date(row.openTime).toISOString(),
      row.open,
      row.high,
      row.low,
      row.close,
      row.volume,
    ].join(","));
  }
  const csv = `${csvRows.join("\n")}\n`;
  const gaps = [];
  for (let index = 1; index < rows.length; index += 1) {
    const difference = rows[index].openTime - rows[index - 1].openTime;
    if (difference !== intervalMs) gaps.push({ after: new Date(rows[index - 1].openTime).toISOString(), milliseconds: difference });
  }
  return {
    csv,
    provenance: {
      schema: "alphagraph-market-data-v1",
      source: "Binance public spot market-data API",
      endpoint,
      documentation: "https://developers.binance.com/en/docs/products/spot/rest-api",
      symbol,
      interval,
      requested: {
        startInclusive: new Date(startMs).toISOString(),
        endExclusive: new Date(endExclusiveMs).toISOString(),
      },
      received: {
        bars: rows.length,
        start: new Date(rows[0].openTime).toISOString(),
        end: new Date(rows.at(-1).openTime).toISOString(),
        requests,
        unexpectedIntervalGaps: gaps.length,
        firstGaps: gaps.slice(0, 10),
      },
      csvSha256: sha256(csv),
      fetchedAt: new Date().toISOString(),
      warning: "Public market data may be corrected by its provider. Preserve this CSV hash with every report.",
    },
  };
}
