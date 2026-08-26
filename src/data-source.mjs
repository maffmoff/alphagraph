import { assertNumber, assertString, sha256 } from "./core.mjs";

// データ基盤への安全なアクセス。
// 境界（docs/fable-concept.md §8）: 秘密鍵・取引所APIキーを要求しない。
// ここでは方針を文章で守るのではなく、経路を構造的に塞ぐ:
//   1. 公開・無認証のホストだけを許可リストで通す
//   2. 認証情報らしきヘッダ・クエリ・URL userinfo を検出したら送信前に落とす
//   3. このモジュールは process.env を一切読まない（test/data-source.test.mjs が検査する）
// 資格情報を持たないので、盗まれる資格情報も存在しないという状態にする。

export const PUBLIC_SOURCES = new Map([
  ["api.hyperliquid.xyz", {
    name: "Hyperliquid public info API",
    auth: "none",
    // チェーン由来の公開データ。生データ公開レーン＝完全な独立再現が可能。
    redistributable: true,
    license: "public on-chain / public API data",
    documentation: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api",
  }],
  ["data-api.binance.vision", {
    name: "Binance public market-data API",
    auth: "none",
    redistributable: true,
    license: "public market data (provider terms apply to redistribution at scale)",
    documentation: "https://developers.binance.com/en/docs/products/spot/rest-api",
  }],
]);

const CREDENTIAL_HEADERS = new Set([
  "authorization", "cookie", "x-api-key", "x-mbx-apikey", "api-key", "x-auth-token", "proxy-authorization",
]);
const CREDENTIAL_PARAMS = /^(api[_-]?key|secret|signature|token|access[_-]?token|password|passphrase|sig)$/i;

// 送信前の検査。ここを通らないリクエストはこのモジュールから出ない。
export function assertPublicRequest(url, init = {}) {
  const target = url instanceof URL ? url : new URL(String(url));
  if (target.protocol !== "https:") throw new Error(`Refusing a non-HTTPS data request: ${target.protocol}`);
  if (target.username || target.password) throw new Error("Refusing a URL that carries credentials in its userinfo.");
  const source = PUBLIC_SOURCES.get(target.host);
  if (!source) {
    throw new Error(`Refusing a request to a host that is not on the public data allowlist: ${target.host}`);
  }
  for (const key of target.searchParams.keys()) {
    if (CREDENTIAL_PARAMS.test(key)) throw new Error(`Refusing a request with a credential-shaped query parameter: ${key}`);
  }
  for (const key of Object.keys(init.headers ?? {})) {
    if (CREDENTIAL_HEADERS.has(key.toLowerCase())) throw new Error(`Refusing a request with a credential header: ${key}`);
  }
  return source;
}

export async function publicFetch(url, init = {}, fetchImpl = fetch) {
  assertPublicRequest(url, init);
  return fetchImpl(url, { ...init, redirect: "error" });
}

const HL_INTERVAL_MS = new Map([
  ["1m", 60_000], ["5m", 300_000], ["15m", 900_000],
  ["1h", 3_600_000], ["4h", 14_400_000], ["1d", 86_400_000],
]);
const HL_ENDPOINT = "https://api.hyperliquid.xyz/info";
const HL_PAGE_LIMIT = 5000;

function isoToMs(value, label) {
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO-8601 timestamp.`);
  return parsed;
}

function candleNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Hyperliquid returned an invalid ${label}.`);
  return parsed;
}

async function hyperliquidInfo(body, fetchImpl = fetch) {
  const response = await publicFetch(HL_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, fetchImpl);
  const text = await response.text();
  if (!response.ok) throw new Error(`Hyperliquid info API returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Hyperliquid info API returned invalid JSON.");
  }
}

// perpユニバース（ラウンドのユニバース固定にも使う）。無認証の公開エンドポイント。
export async function fetchHyperliquidUniverse(fetchImpl = fetch) {
  const meta = await hyperliquidInfo({ type: "meta" }, fetchImpl);
  const universe = Array.isArray(meta?.universe) ? meta.universe : null;
  if (!universe) throw new Error("Hyperliquid meta response is missing its universe.");
  const coins = universe
    .filter((entry) => entry && typeof entry.name === "string" && entry.isDelisted !== true)
    .map((entry) => ({ name: entry.name, szDecimals: entry.szDecimals ?? null, maxLeverage: entry.maxLeverage ?? null }));
  return {
    coins,
    provenance: {
      schema: "alphagraph-universe-v1",
      source: PUBLIC_SOURCES.get("api.hyperliquid.xyz").name,
      endpoint: HL_ENDPOINT,
      request: { type: "meta" },
      count: coins.length,
      sha256: sha256(JSON.stringify(coins)),
      fetchedAt: new Date().toISOString(),
    },
  };
}

export async function fetchHyperliquidCandles(options, fetchImpl = fetch) {
  const coin = assertString(options.coin, "coin", { max: 30, pattern: /^[A-Za-z0-9@_-]+$/ });
  const interval = assertString(options.interval, "interval", { max: 4 });
  const intervalMs = HL_INTERVAL_MS.get(interval);
  if (!intervalMs) throw new Error(`Unsupported Hyperliquid interval: ${interval}.`);
  const startMs = isoToMs(options.start, "start");
  const endExclusiveMs = isoToMs(options.end, "end");
  if (endExclusiveMs <= startMs) throw new Error("end must be after start.");
  const maxBars = assertNumber(options.maxBars ?? 100_000, "maxBars", { min: 1, max: 1_000_000, integer: true });

  const rows = [];
  let cursor = startMs;
  let requests = 0;
  while (cursor < endExclusiveMs) {
    const page = await hyperliquidInfo({
      type: "candleSnapshot",
      req: { coin, interval, startTime: cursor, endTime: endExclusiveMs - 1 },
    }, fetchImpl);
    if (!Array.isArray(page)) throw new Error("Hyperliquid candleSnapshot returned an unexpected payload.");
    requests += 1;
    if (!page.length) break;
    for (const item of page) {
      const openTime = candleNumber(item?.t, "open time");
      if (openTime < startMs || openTime >= endExclusiveMs) continue;
      if (rows.length && openTime <= rows.at(-1).openTime) continue;
      rows.push({
        openTime,
        open: candleNumber(item.o, "open"),
        high: candleNumber(item.h, "high"),
        low: candleNumber(item.l, "low"),
        close: candleNumber(item.c, "close"),
        volume: candleNumber(item.v, "volume"),
      });
      if (rows.length > maxBars) throw new Error(`Download exceeds the configured maximum of ${maxBars} bars.`);
    }
    const lastOpen = candleNumber(page.at(-1)?.t, "open time");
    const nextCursor = lastOpen + intervalMs;
    if (!Number.isFinite(nextCursor) || nextCursor <= cursor) throw new Error("Hyperliquid pagination did not advance.");
    cursor = nextCursor;
    if (page.length < HL_PAGE_LIMIT) break;
  }
  if (!rows.length) throw new Error("Hyperliquid returned no candles for the requested range.");

  const csvRows = ["timestamp,open,high,low,close,volume"];
  for (const row of rows) {
    csvRows.push([new Date(row.openTime).toISOString(), row.open, row.high, row.low, row.close, row.volume].join(","));
  }
  const csv = `${csvRows.join("\n")}\n`;
  const gaps = [];
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].openTime - rows[index - 1].openTime !== intervalMs) {
      gaps.push({ after: new Date(rows[index - 1].openTime).toISOString(), milliseconds: rows[index].openTime - rows[index - 1].openTime });
    }
  }
  const source = PUBLIC_SOURCES.get("api.hyperliquid.xyz");
  return {
    csv,
    provenance: {
      schema: "alphagraph-market-data-v1",
      source: source.name,
      endpoint: HL_ENDPOINT,
      documentation: source.documentation,
      auth: source.auth,
      redistributable: source.redistributable,
      license: source.license,
      symbol: coin,
      interval,
      requested: { startInclusive: new Date(startMs).toISOString(), endExclusive: new Date(endExclusiveMs).toISOString() },
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
