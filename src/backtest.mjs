import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  assertNumber,
  assertPlainObject,
  assertString,
  hashJson,
  round,
  sha256,
} from "./core.mjs";

const STRATEGY_ID = /^[a-z0-9][a-z0-9_-]{2,47}$/;
const SUPPORTED_INTERVALS = new Map([
  ["1m", 365 * 24 * 60],
  ["5m", 365 * 24 * 12],
  ["15m", 365 * 24 * 4],
  ["1h", 365 * 24],
  ["4h", 365 * 6],
  ["1d", 365],
]);

export function validateStrategy(input) {
  assertPlainObject(input, "strategy");
  if (input.schema !== "alphagraph-strategy-v1") throw new Error("strategy.schema must be alphagraph-strategy-v1.");
  const id = assertString(input.id, "strategy.id", { max: 48, pattern: STRATEGY_ID });
  const name = assertString(input.name, "strategy.name", { max: 120 });
  const hypothesis = assertString(input.hypothesis, "strategy.hypothesis", { max: 1000 });

  assertPlainObject(input.market, "strategy.market");
  const venue = assertString(input.market.venue, "strategy.market.venue", { max: 40 });
  const symbol = assertString(input.market.symbol, "strategy.market.symbol", {
    max: 30,
    pattern: /^[A-Z0-9._:/-]+$/,
  });
  const interval = assertString(input.market.interval, "strategy.market.interval", { max: 8 });
  if (!SUPPORTED_INTERVALS.has(interval)) {
    throw new Error(`strategy.market.interval must be one of: ${[...SUPPORTED_INTERVALS.keys()].join(", ")}.`);
  }

  assertPlainObject(input.rules, "strategy.rules");
  if (input.rules.type !== "sma-cross") throw new Error("MVP supports only rules.type=sma-cross.");
  const fast = assertNumber(input.rules.fast, "strategy.rules.fast", { min: 2, max: 5000, integer: true });
  const slow = assertNumber(input.rules.slow, "strategy.rules.slow", { min: 3, max: 10000, integer: true });
  if (fast >= slow) throw new Error("strategy.rules.fast must be smaller than strategy.rules.slow.");
  const position = input.rules.position ?? "long_only";
  if (position !== "long_only") throw new Error("MVP supports only rules.position=long_only.");

  assertPlainObject(input.costs, "strategy.costs");
  const feeBps = assertNumber(input.costs.feeBps, "strategy.costs.feeBps", { min: 0, max: 200 });
  const slippageBps = assertNumber(input.costs.slippageBps, "strategy.costs.slippageBps", { min: 0, max: 200 });

  assertPlainObject(input.evaluation, "strategy.evaluation");
  const holdoutFraction = assertNumber(input.evaluation.holdoutFraction, "strategy.evaluation.holdoutFraction", {
    min: 0.2,
    max: 0.5,
  });
  const minHoldoutBars = assertNumber(input.evaluation.minHoldoutBars, "strategy.evaluation.minHoldoutBars", {
    min: 20,
    max: 1000000,
    integer: true,
  });
  const maxDrawdownPct = assertNumber(input.evaluation.maxDrawdownPct, "strategy.evaluation.maxDrawdownPct", {
    min: 1,
    max: 100,
  });

  return {
    schema: "alphagraph-strategy-v1",
    id,
    name,
    hypothesis,
    market: { venue, symbol, interval },
    rules: { type: "sma-cross", fast, slow, position },
    costs: { feeBps, slippageBps },
    evaluation: { holdoutFraction, minHoldoutBars, maxDrawdownPct },
  };
}

function parseTimestamp(raw, lineNumber) {
  const trimmed = raw.trim();
  const numeric = /^\d{10,13}$/.test(trimmed) ? Number(trimmed) : NaN;
  const millis = Number.isFinite(numeric) ? (trimmed.length === 10 ? numeric * 1000 : numeric) : Date.parse(trimmed);
  if (!Number.isFinite(millis)) throw new Error(`CSV line ${lineNumber}: invalid timestamp ${JSON.stringify(raw)}.`);
  return millis;
}

function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  fields.push(field);
  return fields;
}

export function parseOhlcvCsv(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 3) throw new Error("CSV must contain a header and at least two data rows.");
  const header = parseCsvLine(lines[0]).map((item) => item.trim().toLowerCase());
  const required = ["timestamp", "open", "high", "low", "close", "volume"];
  const indexes = Object.fromEntries(required.map((name) => [name, header.indexOf(name)]));
  for (const name of required) {
    if (indexes[name] < 0) throw new Error(`CSV is missing required column: ${name}.`);
  }

  const bars = [];
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const fields = parseCsvLine(lines[lineIndex]);
    const lineNumber = lineIndex + 1;
    const bar = { timestamp: parseTimestamp(fields[indexes.timestamp] ?? "", lineNumber) };
    for (const name of ["open", "high", "low", "close", "volume"]) {
      bar[name] = Number(fields[indexes[name]]);
      if (!Number.isFinite(bar[name])) throw new Error(`CSV line ${lineNumber}: ${name} is not numeric.`);
    }
    if (bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0 || bar.volume < 0) {
      throw new Error(`CSV line ${lineNumber}: prices must be positive and volume cannot be negative.`);
    }
    if (bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.low > bar.high) {
      throw new Error(`CSV line ${lineNumber}: inconsistent OHLC values.`);
    }
    if (bars.length && bar.timestamp <= bars.at(-1).timestamp) {
      throw new Error(`CSV line ${lineNumber}: timestamps must be strictly increasing.`);
    }
    bars.push(bar);
  }
  return bars;
}

function movingAverage(values, length) {
  const output = Array(values.length).fill(null);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= length) sum -= values[index - length];
    if (index >= length - 1) output[index] = sum / length;
  }
  return output;
}

function sampleStd(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function calculateMetrics(records, periodsPerYear) {
  if (!records.length) {
    return {
      bars: 0,
      netReturnPct: null,
      annualizedReturnPct: null,
      annualizedVolatilityPct: null,
      sharpe: null,
      maxDrawdownPct: null,
      exposurePct: null,
      transactions: 0,
    };
  }
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  const returns = [];
  let exposed = 0;
  let transactions = 0;
  for (const record of records) {
    equity *= 1 + record.netReturn;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - (equity / peak));
    returns.push(record.netReturn);
    if (record.position !== 0) exposed += 1;
    if (record.turnover > 0) transactions += 1;
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const volatility = sampleStd(returns);
  const annualizedReturn = equity > 0 ? (equity ** (periodsPerYear / returns.length)) - 1 : -1;
  return {
    bars: records.length,
    start: new Date(records[0].timestamp).toISOString(),
    end: new Date(records.at(-1).timestamp).toISOString(),
    netReturnPct: round((equity - 1) * 100, 6),
    annualizedReturnPct: round(annualizedReturn * 100, 6),
    annualizedVolatilityPct: round(volatility * Math.sqrt(periodsPerYear) * 100, 6),
    sharpe: volatility > 0 ? round((mean / volatility) * Math.sqrt(periodsPerYear), 6) : null,
    maxDrawdownPct: round(maxDrawdown * 100, 6),
    exposurePct: round((exposed / records.length) * 100, 4),
    transactions,
  };
}

function calculateBuyAndHold(records, periodsPerYear, costRate) {
  const benchmark = records.map((record, index) => {
    const turnover = (index === 0 ? 1 : 0) + (index === records.length - 1 ? 1 : 0);
    return {
      timestamp: record.timestamp,
      position: 1,
      turnover,
      netReturn: ((1 + record.marketReturn) * (1 - (turnover * costRate))) - 1,
    };
  });
  return calculateMetrics(benchmark, periodsPerYear);
}

function scoreReport(outOfSample, evaluation) {
  const failures = [];
  if (outOfSample.bars < evaluation.minHoldoutBars) failures.push("insufficient_holdout_bars");
  if (outOfSample.netReturnPct === null || outOfSample.netReturnPct <= 0) failures.push("non_positive_net_return");
  if (outOfSample.maxDrawdownPct === null || outOfSample.maxDrawdownPct > evaluation.maxDrawdownPct) {
    failures.push("drawdown_limit_exceeded");
  }
  const sharpe = outOfSample.sharpe ?? -3;
  const returnPoints = Math.max(0, Math.min(35, (outOfSample.netReturnPct ?? -100) * 1.75));
  const sharpePoints = Math.max(0, Math.min(35, sharpe * 17.5));
  const drawdownPoints = Math.max(0, 20 * (1 - ((outOfSample.maxDrawdownPct ?? 100) / evaluation.maxDrawdownPct)));
  const samplePoints = Math.max(0, Math.min(10, (outOfSample.bars / evaluation.minHoldoutBars) * 10));
  return {
    passedMechanicalGates: failures.length === 0,
    score: round(returnPoints + sharpePoints + drawdownPoints + samplePoints, 2),
    failures,
    warning: "Mechanical score only. It is not evidence of future profit and does not replace independent reproduction or forward testing.",
  };
}

export function runBacktest(strategyInput, bars, { dataHash = null, dataLabel = "unknown" } = {}) {
  const strategy = validateStrategy(strategyInput);
  if (!Array.isArray(bars) || bars.length < strategy.rules.slow + 3) {
    throw new Error(`Dataset needs at least ${strategy.rules.slow + 3} bars for this strategy.`);
  }
  const closes = bars.map((bar) => bar.close);
  const fast = movingAverage(closes, strategy.rules.fast);
  const slow = movingAverage(closes, strategy.rules.slow);
  const costRate = (strategy.costs.feeBps + strategy.costs.slippageBps) / 10000;
  const records = [];
  let position = 0;

  for (let index = 1; index < bars.length; index += 1) {
    const signalIndex = index - 1;
    const finalBar = index === bars.length - 1;
    const desired = finalBar || fast[signalIndex] === null || slow[signalIndex] === null
      ? 0
      : (fast[signalIndex] > slow[signalIndex] ? 1 : 0);
    const turnover = Math.abs(desired - position);
    position = desired;
    const marketReturn = finalBar ? 0 : (bars[index + 1].open / bars[index].open) - 1;
    const grossReturn = position * marketReturn;
    const netReturn = ((1 + grossReturn) * (1 - (turnover * costRate))) - 1;
    records.push({
      timestamp: bars[index].timestamp,
      position,
      turnover,
      marketReturn,
      grossReturn,
      netReturn,
    });
  }

  const eligibleStart = Math.max(0, strategy.rules.slow - 1);
  const eligible = records.slice(eligibleStart);
  const holdoutCount = Math.max(strategy.evaluation.minHoldoutBars, Math.ceil(eligible.length * strategy.evaluation.holdoutFraction));
  if (holdoutCount >= eligible.length) {
    throw new Error(`Dataset leaves no in-sample section after reserving ${holdoutCount} holdout bars.`);
  }
  const splitIndex = eligible.length - holdoutCount;
  const inSampleRecords = eligible.slice(0, splitIndex);
  const outOfSampleRecords = eligible.slice(splitIndex);
  const periodsPerYear = SUPPORTED_INTERVALS.get(strategy.market.interval);
  const inSample = calculateMetrics(inSampleRecords, periodsPerYear);
  const outOfSample = calculateMetrics(outOfSampleRecords, periodsPerYear);
  const all = calculateMetrics(eligible, periodsPerYear);
  const benchmark = {
    inSample: calculateBuyAndHold(inSampleRecords, periodsPerYear, costRate),
    outOfSample: calculateBuyAndHold(outOfSampleRecords, periodsPerYear, costRate),
    all: calculateBuyAndHold(eligible, periodsPerYear, costRate),
  };

  return {
    schema: "alphagraph-backtest-v1",
    createdAt: new Date().toISOString(),
    engine: {
      name: "alphagraph",
      version: "0.2.0",
      timing: "Signal uses bar close; position changes at the next bar open. Final position is liquidated at the last open.",
    },
    strategy,
    strategyHash: hashJson(strategy),
    data: {
      label: dataLabel,
      sha256: dataHash,
      bars: bars.length,
      start: new Date(bars[0].timestamp).toISOString(),
      end: new Date(bars.at(-1).timestamp).toISOString(),
    },
    split: {
      method: "locked chronological holdout",
      holdoutFractionRequested: strategy.evaluation.holdoutFraction,
      holdoutBars: holdoutCount,
      outOfSampleStart: outOfSample.start,
    },
    assumptions: {
      position: "long or cash; no leverage and no short selling",
      feeBpsPerPositionChange: strategy.costs.feeBps,
      slippageBpsPerPositionChange: strategy.costs.slippageBps,
      dividendsFundingBorrowTaxes: "not modeled",
    },
    metrics: { inSample, outOfSample, all, benchmark },
    gate: scoreReport(outOfSample, strategy.evaluation),
    requiredNextEvidence: [
      "Independent reproduction by another DID using the same strategy and data hashes.",
      "Forward paper trading on data unavailable when the strategy was proposed.",
      "Human risk approval before any broker or exchange connection.",
    ],
  };
}

export async function backtestFromCsv(strategy, path) {
  const raw = await readFile(path);
  const bars = parseOhlcvCsv(raw.toString("utf8"));
  return runBacktest(strategy, bars, { dataHash: sha256(raw), dataLabel: basename(path) });
}

export function generateSyntheticCsv({ bars = 1000, start = "2025-01-01T00:00:00.000Z", intervalMs = 3600000 } = {}) {
  assertNumber(bars, "bars", { min: 100, max: 1000000, integer: true });
  let state = 0x51f15e;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  let previousClose = 42000;
  const rows = ["timestamp,open,high,low,close,volume"];
  const startMs = Date.parse(start);
  for (let index = 0; index < bars; index += 1) {
    const regime = Math.floor(index / 120) % 3;
    const drift = regime === 0 ? 0.0007 : regime === 1 ? -0.00045 : 0.0001;
    const shock = (random() - 0.5) * 0.018;
    const open = previousClose;
    const close = open * (1 + drift + shock);
    const high = Math.max(open, close) * (1 + random() * 0.004);
    const low = Math.min(open, close) * (1 - random() * 0.004);
    const volume = 100 + random() * 900;
    rows.push([
      new Date(startMs + (index * intervalMs)).toISOString(),
      open.toFixed(6),
      high.toFixed(6),
      low.toFixed(6),
      close.toFixed(6),
      volume.toFixed(4),
    ].join(","));
    previousClose = close;
  }
  return `${rows.join("\n")}\n`;
}
