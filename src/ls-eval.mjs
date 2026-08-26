import { assertNumber, assertString, sha256 } from "./core.mjs";
import { fetchBinanceKlines } from "./market-data.mjs";

const DAY_MS = 86_400_000;
const FACTORS = new Set(["momentum", "reversal", "vol", "volume"]);
const POOL_SIZE = 100;
const UNIVERSE_SIZE = 50;
const MIN_UNIVERSE = 30;
const TRAILING_WINDOW = 30;
const HORIZONS = [1, 2, 3, 4];
const STABLE_OR_FIAT_BASES = new Set([
  "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "EUR", "GBP", "AEUR", "USD1", "USDE", "XUSD",
]);

export function spearman(left, right) {
  const rank = (values) => {
    const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
    const ranks = Array(values.length);
    for (let start = 0; start < ordered.length;) {
      let end = start + 1;
      while (end < ordered.length && ordered[end].value === ordered[start].value) end += 1;
      const average = (start + end - 1) / 2;
      for (let cursor = start; cursor < end; cursor += 1) ranks[ordered[cursor].index] = average;
      start = end;
    }
    return ranks;
  };
  const a = rank(left);
  const b = rank(right);
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let numerator = 0;
  let squareA = 0;
  let squareB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const da = a[index] - meanA;
    const db = b[index] - meanB;
    numerator += da * db;
    squareA += da * da;
    squareB += db * db;
  }
  const denominator = Math.sqrt(squareA * squareB);
  return denominator === 0 ? 0 : numerator / denominator;
}

export function selectUsdtPool(tickers, { poolSize = POOL_SIZE } = {}) {
  const rows = [];
  for (const ticker of tickers) {
    const symbol = String(ticker.symbol ?? "");
    if (!symbol.endsWith("USDT")) continue;
    const base = symbol.slice(0, -4);
    if (!/^[A-Z0-9]{2,12}$/.test(base)) continue;
    if (STABLE_OR_FIAT_BASES.has(base)) continue;
    if (/(UP|DOWN|BULL|BEAR)$/.test(base)) continue;
    const quoteVolume = Number(ticker.quoteVolume);
    if (!Number.isFinite(quoteVolume) || quoteVolume <= 0) continue;
    rows.push({ symbol, quoteVolume });
  }
  rows.sort((a, b) => b.quoteVolume - a.quoteVolume);
  return rows.slice(0, poolSize).map((row) => row.symbol);
}

export async function fetchUsdtPool(fetchImpl = fetch, { poolSize = POOL_SIZE } = {}) {
  const response = await fetchImpl("https://data-api.binance.vision/api/v3/ticker/24hr", { redirect: "error" });
  const body = await response.text();
  if (!response.ok) throw new Error(`Binance ticker API returned HTTP ${response.status}: ${body.slice(0, 200)}`);
  const tickers = JSON.parse(body);
  if (!Array.isArray(tickers)) throw new Error("Binance ticker API returned an unexpected payload.");
  const pool = selectUsdtPool(tickers, { poolSize });
  if (pool.length < MIN_UNIVERSE) throw new Error("Not enough USDT pairs to build a pool.");
  return pool;
}

function std(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function computeFactor(factor, lookback, closes, volumes, index) {
  if (index < lookback) return null;
  if (factor === "momentum") return (closes[index] / closes[index - lookback]) - 1;
  if (factor === "reversal") return -((closes[index] / closes[index - lookback]) - 1);
  if (factor === "vol") {
    const returns = [];
    for (let cursor = index - lookback + 1; cursor <= index; cursor += 1) {
      returns.push((closes[cursor] / closes[cursor - 1]) - 1);
    }
    return -std(returns);
  }
  if (factor === "volume") {
    if (index < lookback * 2) return null;
    let recent = 0;
    let prior = 0;
    for (let cursor = 0; cursor < lookback; cursor += 1) {
      recent += volumes[index - cursor] * closes[index - cursor];
      prior += volumes[index - lookback - cursor] * closes[index - lookback - cursor];
    }
    return prior > 0 ? (recent / prior) - 1 : null;
  }
  throw new Error(`Unsupported factor: ${factor}`);
}

export function evaluateCrossSection(series, options) {
  const factor = assertString(options.factor, "factor", { max: 20 });
  if (!FACTORS.has(factor)) throw new Error(`factor must be one of: ${[...FACTORS].join(", ")}.`);
  const lookback = assertNumber(options.lookback, "lookback", { min: 2, max: 365, integer: true });
  const startMs = Date.parse(options.start);
  const endMs = Date.parse(options.end);

  const symbols = [...series.keys()].sort();
  const dayset = new Set();
  for (const rows of series.values()) {
    for (const row of rows) dayset.add(row.openTime);
  }
  const days = [...dayset].sort((a, b) => a - b);
  const bySymbol = new Map();
  for (const symbol of symbols) {
    const rows = series.get(symbol);
    const indexByDay = new Map();
    rows.forEach((row, index) => indexByDay.set(row.openTime, index));
    bySymbol.set(symbol, {
      indexByDay,
      closes: rows.map((row) => row.close),
      volumes: rows.map((row) => row.volume),
    });
  }

  const maxHorizon = Math.max(...HORIZONS);
  const dailyPooledIc = [];
  const perHorizonIc = new Map(HORIZONS.map((h) => [h, []]));
  const spreadDaily = [];
  const universeSizes = [];
  const evalDays = [];

  for (const day of days) {
    if (day < startMs || day >= endMs) continue;
    const candidates = [];
    for (const symbol of symbols) {
      const { indexByDay, closes, volumes } = bySymbol.get(symbol);
      const index = indexByDay.get(day);
      if (index === undefined) continue;
      if (index < Math.max(lookback * (factor === "volume" ? 2 : 1), TRAILING_WINDOW) + 1) continue;
      if (index + maxHorizon >= closes.length) continue;
      let dollarVolume = 0;
      for (let cursor = 0; cursor < TRAILING_WINDOW; cursor += 1) {
        dollarVolume += closes[index - cursor] * volumes[index - cursor];
      }
      const returns = [];
      for (let cursor = index - TRAILING_WINDOW + 1; cursor <= index; cursor += 1) {
        returns.push((closes[cursor] / closes[cursor - 1]) - 1);
      }
      const vol30 = Math.max(std(returns), 1e-6);
      const value = computeFactor(factor, lookback, closes, volumes, index);
      if (value === null || !Number.isFinite(value)) continue;
      const targets = HORIZONS.map((h) => ((closes[index + h] / closes[index]) - 1) / vol30);
      candidates.push({ symbol, dollarVolume, value, targets, next1: (closes[index + 1] / closes[index]) - 1 });
    }
    candidates.sort((a, b) => b.dollarVolume - a.dollarVolume);
    const universe = candidates.slice(0, UNIVERSE_SIZE);
    if (universe.length < MIN_UNIVERSE) continue;

    const pooledPredictions = [];
    const pooledTargets = [];
    for (const [horizonIndex, horizon] of HORIZONS.entries()) {
      const predictions = universe.map((row) => row.value);
      const targets = universe.map((row) => row.targets[horizonIndex]);
      perHorizonIc.get(horizon).push(spearman(predictions, targets));
      pooledPredictions.push(...predictions);
      pooledTargets.push(...targets);
    }
    dailyPooledIc.push(spearman(pooledPredictions, pooledTargets));

    const sorted = [...universe].sort((a, b) => b.value - a.value);
    const bucket = Math.max(1, Math.floor(sorted.length / 5));
    const longs = sorted.slice(0, bucket);
    const shorts = sorted.slice(-bucket);
    const longReturn = longs.reduce((sum, row) => sum + row.next1, 0) / longs.length;
    const shortReturn = shorts.reduce((sum, row) => sum + row.next1, 0) / shorts.length;
    spreadDaily.push((longReturn - shortReturn) / 2);
    universeSizes.push(universe.length);
    evalDays.push(day);
  }

  if (dailyPooledIc.length < 60) {
    throw new Error(`Only ${dailyPooledIc.length} evaluable days; need at least 60. Widen the date range.`);
  }

  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const icMean = mean(dailyPooledIc);
  const icStd = std(dailyPooledIc);
  const spreadMean = mean(spreadDaily);
  const spreadStd = std(spreadDaily);

  return {
    schema: "tradecore-ls-eval-v1",
    factor,
    lookback,
    horizons: HORIZONS,
    days: dailyPooledIc.length,
    firstDay: new Date(evalDays[0]).toISOString().slice(0, 10),
    lastDay: new Date(evalDays.at(-1)).toISOString().slice(0, 10),
    universe: {
      target: UNIVERSE_SIZE,
      minObserved: Math.min(...universeSizes),
      meanObserved: Math.round(mean(universeSizes) * 10) / 10,
      selection: `point-in-time top ${UNIVERSE_SIZE} by trailing ${TRAILING_WINDOW}d dollar volume within the request-time pool`,
    },
    ic: {
      pooledMean: round6(icMean),
      pooledStd: round6(icStd),
      icSharpe: icStd > 0 ? round6(icMean / icStd) : null,
      perHorizonMean: Object.fromEntries(HORIZONS.map((h) => [`h${h}`, round6(mean(perHorizonIc.get(h)))])),
      note: "Daily pooled Spearman IC across 4 horizons; overlapping horizon windows autocorrelate the daily series.",
    },
    spread: {
      construction: "equal-weight top vs bottom quintile by factor, next-1d raw returns, half gross",
      dailyMeanPct: round6(spreadMean * 100),
      annualizedPct: round6(spreadMean * 365 * 100),
      sharpe: spreadStd > 0 ? round6((spreadMean / spreadStd) * Math.sqrt(365)) : null,
      costsNote: "Gross of trading costs.",
    },
    biases: [
      "Candidate pool is selected at request time: delisted symbols are absent (survivorship bias).",
      "Target is vol-adjusted (trailing 30d) close-to-close return; no execution costs modeled in IC.",
    ],
  };
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

export async function fetchDailySeries(pool, { start, end, fetchImpl = fetch, cache = null } = {}) {
  const series = new Map();
  const hashes = [];
  for (const symbol of pool) {
    let entry = cache?.get?.(symbol) ?? null;
    if (!entry) {
      const result = await fetchBinanceKlines({
        symbol,
        interval: "1d",
        start,
        end,
        maxBars: 3000,
      }, fetchImpl).catch(() => null);
      if (!result) continue;
      const rows = [];
      const lines = result.csv.trim().split("\n").slice(1);
      for (const line of lines) {
        const [timestamp, , , , close, volume] = line.split(",");
        rows.push({ openTime: Date.parse(timestamp), close: Number(close), volume: Number(volume) });
      }
      entry = { rows, sha256: result.provenance.csvSha256 };
      cache?.set?.(symbol, entry);
    }
    if (entry.rows.length < 120) continue;
    series.set(symbol, entry.rows);
    hashes.push(`${symbol}:${entry.sha256}`);
  }
  if (series.size < MIN_UNIVERSE) {
    throw new Error(`Only ${series.size} symbols with usable history; need at least ${MIN_UNIVERSE}.`);
  }
  return { series, dataHash: sha256(hashes.sort().join("\n")) };
}
