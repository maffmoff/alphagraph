import { sign as cryptoSign } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { hashJson, readJson, writeJson } from "./core.mjs";
import { didFromPrivateKey } from "./did.mjs";
import { evaluateCrossSection, fetchDailySeries, fetchUsdtPool } from "./ls-eval.mjs";

const BASE_URL = "https://technocore.chat";
const TRIGGER = /^\s*(?:!ls|ls:|@alphagraph)\s+/i;
const FACTORS = new Set(["momentum", "reversal", "vol", "volume"]);
const PER_AUTHOR_PER_DAY = 3;
const GLOBAL_PER_DAY = 40;
const DAY_MS = 86_400_000;
const CACHE_TTL_MS = DAY_MS;
const DISCLAIMER = "paper research only, not financial advice";

function cleanSingleLine(value, limit = 4096) {
  const cleaned = String(value).replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\u2028\u2029]/gu, " ").replace(/ {2,}/g, " ").trim();
  if (!cleaned) throw new Error("Message text is empty.");
  if (cleaned.length > limit) throw new Error(`Message text exceeds ${limit} characters.`);
  return cleaned;
}

function utcDateOnly(ms) {
  return new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

export function parseLsRequest(text, { nowMs = Date.now() } = {}) {
  const raw = String(text ?? "");
  if (!TRIGGER.test(raw)) return null;
  let rest = raw.replace(TRIGGER, " ");

  const take = (pattern) => {
    const match = rest.match(pattern);
    if (match) rest = rest.replace(pattern, " ");
    return match;
  };

  const from = take(/\bfrom[ =](\d{4}-\d{2}-\d{2})\b/i)?.[1] ?? "2024-01-01";
  const to = take(/\bto[ =](\d{4}-\d{2}-\d{2})\b/i)?.[1] ?? utcDateOnly(nowMs);
  const factorMatch = take(/\b(momentum|reversal|vol|volume)\b/i);
  const lookbackMatch = take(/\b(\d{1,3})\s*d\b/i);
  const factor = factorMatch?.[1]?.toLowerCase() ?? null;
  const lookback = lookbackMatch ? Number(lookbackMatch[1]) : 30;
  const thesis = rest.replace(/\s+/g, " ").trim().slice(0, 900);

  if (!factor || !FACTORS.has(factor)) return { error: "missing_factor" };
  if (!(lookback >= 2 && lookback <= 365)) return { error: "bad_lookback" };
  const startMs = Date.parse(`${from}T00:00:00Z`);
  const endMs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return { error: "bad_range" };
  const warmupDays = Math.max(lookback * 2, 30) + 5;
  const evalDays = Math.floor((endMs - startMs) / DAY_MS);
  if (evalDays < 90) return { error: "range_too_small" };

  return {
    factor,
    lookback,
    start: `${from}T00:00:00Z`,
    end: `${to}T00:00:00Z`,
    fetchStart: new Date(startMs - (warmupDays * DAY_MS)).toISOString(),
    thesis: thesis || "(no thesis text provided)",
  };
}

const fixed = (value, digits = 3) => (value === null || value === undefined ? "n/a" : value.toFixed(digits));

export function formatLsReply(result, { requestSeq, dataHash, reportHash }) {
  const horizons = result.ic.perHorizonMean;
  const line = [
    `alphagraph-ls-v1 ${result.factor} ${result.lookback}d`,
    `universe PIT top${result.universe.target} (mean ${result.universe.meanObserved})`,
    `days ${result.days} (${result.firstDay}..${result.lastDay})`,
    `IC h1 ${fixed(horizons.h1)} h2 ${fixed(horizons.h2)} h3 ${fixed(horizons.h3)} h4 ${fixed(horizons.h4)}`,
    `pooled IC ${fixed(result.ic.pooledMean)} ICSharpe ${fixed(result.ic.icSharpe, 2)}`,
    `L/S q5 spread ${fixed(result.spread.annualizedPct, 1)}%/y sharpe ${fixed(result.spread.sharpe, 2)} (gross)`,
    `data:${String(dataHash).slice(0, 10)} report:${String(reportHash).slice(0, 10)}`,
    "survivorship: pool as of request",
    DISCLAIMER,
    `re:${requestSeq}`,
  ].join(" | ");
  return cleanSingleLine(line);
}

export function formatErrorReply(error, requestSeq) {
  const reasons = {
    missing_factor: "factor must be momentum, reversal, vol, or volume",
    bad_lookback: "lookback must be 2d..365d",
    bad_range: "dates must be from<to (YYYY-MM-DD)",
    range_too_small: "need at least 90 days between from and to",
    rate_limited: `rate limit reached (${PER_AUTHOR_PER_DAY} requests per DID/nick per day)`,
    engine_error: "evaluation failed",
  };
  const reason = reasons[error.code] ?? error.code;
  const detail = error.detail ? ` (${cleanSingleLine(error.detail, 120)})` : "";
  return cleanSingleLine(
    `alphagraph-ls-v1 error re:${requestSeq} ${reason}${detail} | usage: ls: momentum|reversal|vol|volume 30d [from 2024-01-01] [to 2026-08-01] your thesis | ${DISCLAIMER}`,
  );
}

export function signRoomMessage(privateKey, room, text, nonce) {
  const cleaned = cleanSingleLine(text);
  const canonical = `${room}|${nonce}|${cleaned}`;
  const sig = cryptoSign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64url");
  return { did: didFromPrivateKey(privateKey), sig, nonce: String(nonce), text: cleaned };
}

export async function readRoom(room, { since, wait, limit } = {}, fetchImpl = fetch) {
  const url = new URL(`${BASE_URL}/r/${room}`);
  url.searchParams.set("format", "json");
  if (since !== undefined) url.searchParams.set("since", String(since));
  if (wait !== undefined) url.searchParams.set("wait", String(wait));
  if (limit !== undefined) url.searchParams.set("limit", String(limit));
  const response = await fetchImpl(url, { redirect: "error" });
  const body = await response.text();
  if (!response.ok) throw new Error(`Technocore returned HTTP ${response.status}: ${body.slice(0, 200)}`);
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed.messages)) throw new Error("Technocore JSON response is missing messages.");
  return parsed;
}

export async function postSigned(room, text, privateKey, fetchImpl = fetch, nonce = Date.now()) {
  const payload = signRoomMessage(privateKey, room, text, nonce);
  const response = await fetchImpl(`${BASE_URL}/r/${room}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "error",
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Technocore signed post failed HTTP ${response.status}: ${body.slice(0, 200)}`);
  return { status: response.status, body: body.slice(0, 200), did: payload.did, nonce: payload.nonce };
}

export function createRateLimiter(state) {
  state.usage ??= {};
  state.globalUse ??= [];
  return {
    allow(author, nowMs = Date.now()) {
      const floor = nowMs - DAY_MS;
      state.globalUse = state.globalUse.filter((ts) => ts > floor);
      const mine = (state.usage[author] ?? []).filter((ts) => ts > floor);
      state.usage[author] = mine;
      if (state.globalUse.length >= GLOBAL_PER_DAY) return false;
      if (mine.length >= PER_AUTHOR_PER_DAY) return false;
      mine.push(nowMs);
      state.globalUse.push(nowMs);
      return true;
    },
  };
}

async function loadSeriesCache(cacheDir, pool) {
  const cache = new Map();
  if (!cacheDir || !existsSync(cacheDir)) return cache;
  const wanted = new Set(pool);
  for (const file of await readdir(cacheDir)) {
    if (!file.endsWith(".json")) continue;
    const symbol = file.slice(0, -5);
    if (!wanted.has(symbol)) continue;
    try {
      const entry = JSON.parse(await readFile(resolve(cacheDir, file), "utf8"));
      if (Date.now() - Date.parse(entry.fetchedAt) < CACHE_TTL_MS) {
        cache.set(symbol, { rows: entry.rows, sha256: entry.sha256 });
      }
    } catch {
      // Corrupt cache entries are refetched.
    }
  }
  return cache;
}

async function persistSeriesCache(cacheDir, cache) {
  if (!cacheDir) return;
  await mkdir(cacheDir, { recursive: true });
  const fetchedAt = new Date().toISOString();
  for (const [symbol, entry] of cache) {
    await writeJson(resolve(cacheDir, `${symbol}.json`), { fetchedAt, sha256: entry.sha256, rows: entry.rows });
  }
}

export async function executeLsRequest(request, { fetchImpl = fetch, artifactsDir, cacheDir } = {}) {
  const pool = await fetchUsdtPool(fetchImpl);
  const cache = await loadSeriesCache(cacheDir, pool);
  const preloaded = cache.size;
  const { series, dataHash } = await fetchDailySeries(pool, {
    start: request.fetchStart,
    end: request.end,
    fetchImpl,
    cache,
  });
  if (cache.size > preloaded) await persistSeriesCache(cacheDir, cache);
  const result = evaluateCrossSection(series, {
    factor: request.factor,
    lookback: request.lookback,
    start: request.start,
    end: request.end,
  });
  const artifact = {
    schema: "alphagraph-ls-agent-run-v1",
    createdAt: new Date().toISOString(),
    request,
    pool: { size: pool.length, symbols: pool },
    dataHash,
    result,
  };
  const reportHash = hashJson(artifact);
  let outputPath = null;
  if (artifactsDir) {
    await mkdir(artifactsDir, { recursive: true });
    outputPath = resolve(artifactsDir, `ls-${Date.now()}-${reportHash.slice(0, 10)}.json`);
    await writeJson(outputPath, artifact);
  }
  return { result, dataHash, reportHash, outputPath };
}

export async function loadState(path) {
  if (existsSync(path)) return readJson(path);
  return { lastSeq: 0, usage: {}, globalUse: [] };
}

export async function runAgentOnce(options) {
  const {
    room,
    identity,
    statePath,
    artifactsDir,
    cacheDir,
    fetchImpl = fetch,
    wait = 0,
    log = () => {},
  } = options;
  const state = await loadState(statePath);
  const limiter = createRateLimiter(state);
  const page = await readRoom(room, { since: state.lastSeq || undefined, wait, limit: 200 }, fetchImpl);
  const replies = [];
  for (const message of page.messages) {
    if (message.seq <= (state.lastSeq ?? 0)) continue;
    state.lastSeq = message.seq;
    if (message.from === identity.did) continue;
    if (!TRIGGER.test(message.text ?? "")) continue;
    const request = parseLsRequest(message.text);
    let reply;
    if (request?.error) {
      reply = formatErrorReply({ code: request.error }, message.seq);
    } else if (!limiter.allow(message.from)) {
      reply = formatErrorReply({ code: "rate_limited" }, message.seq);
    } else {
      log(`Running LS eval for seq ${message.seq}: ${request.factor} ${request.lookback}d ${request.start.slice(0, 10)}..${request.end.slice(0, 10)}`);
      try {
        const run = await executeLsRequest(request, { fetchImpl, artifactsDir, cacheDir });
        reply = formatLsReply(run.result, { requestSeq: message.seq, dataHash: run.dataHash, reportHash: run.reportHash });
        log(`Saved artifact: ${run.outputPath}`);
      } catch (error) {
        reply = formatErrorReply({ code: "engine_error", detail: error.message }, message.seq);
      }
    }
    const posted = await postSigned(room, reply, identity.privateKey, fetchImpl);
    replies.push({ seq: message.seq, reply, status: posted.status });
    log(`Replied to seq ${message.seq} (HTTP ${posted.status})`);
  }
  await writeJson(statePath, state);
  return { processed: replies.length, lastSeq: state.lastSeq, replies };
}

export async function watchAgent(options) {
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  log(`ls-agent watching /r/${options.room} as ${options.identity.did}`);
  for (;;) {
    try {
      await runAgentOnce({ ...options, wait: 10, log });
    } catch (error) {
      log(`ls-agent error: ${error.message}; retrying in 15s`);
      await new Promise((resolvePause) => { setTimeout(resolvePause, 15_000); });
    }
  }
}
