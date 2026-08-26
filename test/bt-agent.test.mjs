import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createRateLimiter,
  formatErrorReply,
  formatLsReply,
  parseLsRequest,
  runAgentOnce,
  signRoomMessage,
} from "../src/bt-agent.mjs";
import { evaluateCrossSection, selectUsdtPool, spearman } from "../src/ls-eval.mjs";
import { didFromPrivateKey } from "../src/did.mjs";

const NOW = Date.parse("2026-08-27T12:00:00Z");
const DAY = 86_400_000;

test("parseLsRequest ignores non-trigger messages", () => {
  assert.equal(parseLsRequest("hello lobby"), null);
  assert.equal(parseLsRequest("thinking about ls: stuff"), null);
});

test("parseLsRequest extracts factor, lookback, range, thesis", () => {
  const request = parseLsRequest(
    "ls: reversal 14d from 2024-06-01 to 2026-06-01 crowded pumps mean-revert",
    { nowMs: NOW },
  );
  assert.equal(request.factor, "reversal");
  assert.equal(request.lookback, 14);
  assert.equal(request.start, "2024-06-01T00:00:00Z");
  assert.equal(request.end, "2026-06-01T00:00:00Z");
  assert.match(request.thesis, /mean-revert/);
});

test("parseLsRequest applies defaults and rejects bad input", () => {
  const request = parseLsRequest("!ls momentum liquidity leads price", { nowMs: NOW });
  assert.equal(request.factor, "momentum");
  assert.equal(request.lookback, 30);
  assert.equal(request.end, "2026-08-27T00:00:00Z");
  assert.equal(parseLsRequest("ls: 30d no factor here", { nowMs: NOW }).error, "missing_factor");
  assert.equal(parseLsRequest("ls: momentum 400d x", { nowMs: NOW }).error, "bad_lookback");
  assert.equal(parseLsRequest("ls: momentum 30d from 2026-06-01 to 2026-07-01 x", { nowMs: NOW }).error, "range_too_small");
});

function syntheticSeries({ symbols = 40, days = 320 } = {}) {
  const start = Date.parse("2025-01-01T00:00:00Z");
  const series = new Map();
  let state = 0xc0ffee;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let index = 0; index < symbols; index += 1) {
    const drift = ((index / (symbols - 1)) - 0.5) * 0.004;
    const rows = [];
    let close = 100 * (1 + index);
    for (let day = 0; day < days; day += 1) {
      close *= 1 + drift + ((random() - 0.5) * 0.01);
      rows.push({ openTime: start + (day * DAY), close, volume: 1000 + (random() * 100) });
    }
    series.set(`SYM${String(index).padStart(2, "0")}USDT`, rows);
  }
  return { series, start, end: start + (days * DAY) };
}

test("evaluateCrossSection finds persistent drift with momentum and flips with reversal", () => {
  const { series, start, end } = syntheticSeries();
  const shared = { lookback: 20, start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  const momentum = evaluateCrossSection(series, { ...shared, factor: "momentum" });
  const reversal = evaluateCrossSection(series, { ...shared, factor: "reversal" });
  assert.ok(momentum.days >= 60);
  assert.ok(momentum.ic.pooledMean > 0.05, `expected positive momentum IC, got ${momentum.ic.pooledMean}`);
  assert.ok(reversal.ic.pooledMean < -0.05, `expected negative reversal IC, got ${reversal.ic.pooledMean}`);
  assert.ok(Math.abs(momentum.ic.pooledMean + reversal.ic.pooledMean) < 1e-9);
  assert.ok(momentum.spread.annualizedPct > 0);
});

test("spearman handles ties and monotone data", () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  assert.equal(spearman([1, 1, 1], [5, 6, 7]), 0);
});

test("selectUsdtPool filters stables, leveraged tokens, and sorts by volume", () => {
  const pool = selectUsdtPool([
    { symbol: "BTCUSDT", quoteVolume: "900" },
    { symbol: "ETHUSDT", quoteVolume: "800" },
    { symbol: "USDCUSDT", quoteVolume: "9999" },
    { symbol: "BTCUPUSDT", quoteVolume: "700" },
    { symbol: "ETHBTC", quoteVolume: "600" },
    { symbol: "SOLUSDT", quoteVolume: "1000" },
  ]);
  assert.deepEqual(pool, ["SOLUSDT", "BTCUSDT", "ETHUSDT"]);
});

test("formatLsReply is a single line with round vocabulary", () => {
  const { series, start, end } = syntheticSeries();
  const result = evaluateCrossSection(series, {
    factor: "momentum",
    lookback: 20,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  });
  const reply = formatLsReply(result, { requestSeq: 42, dataHash: "a".repeat(64), reportHash: "b".repeat(64) });
  assert.ok(reply.length <= 4096);
  assert.ok(!/[\r\n]/.test(reply));
  assert.match(reply, /^tradecore-ls-v1 momentum 20d \| universe PIT top50/);
  assert.match(reply, /ICSharpe/);
  assert.match(reply, /re:42$/);
  assert.match(reply, /paper research only/);
});

test("formatErrorReply names the reason and echoes usage", () => {
  const reply = formatErrorReply({ code: "rate_limited" }, 7);
  assert.match(reply, /rate limit reached/);
  assert.match(reply, /usage: ls:/);
});

test("signRoomMessage signs room|nonce|text and verifies against the DID", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = signRoomMessage(privateKey, "tradecore-lab", "hello  world", 123);
  assert.equal(payload.text, "hello world");
  assert.equal(payload.did, didFromPrivateKey(privateKey));
  const canonical = Buffer.from(`tradecore-lab|123|hello world`, "utf8");
  assert.ok(cryptoVerify(null, canonical, publicKey, Buffer.from(payload.sig, "base64url")));
});

test("rate limiter enforces per-author and daily windows", () => {
  const state = {};
  const limiter = createRateLimiter(state);
  assert.ok(limiter.allow("~alice", NOW));
  assert.ok(limiter.allow("~alice", NOW + 1));
  assert.ok(limiter.allow("~alice", NOW + 2));
  assert.equal(limiter.allow("~alice", NOW + 3), false);
  assert.ok(limiter.allow("~bob", NOW + 4));
  assert.ok(limiter.allow("~alice", NOW + DAY + 5));
});

test("runAgentOnce replies to an invalid trigger with a signed error", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const identity = { privateKey, did: didFromPrivateKey(privateKey) };
  const roomPage = {
    room: "tradecore-lab",
    messages: [
      { seq: 11, ts: "2026-08-27T00:00:00Z", from: "~tester", text: "ls: 30d thesis without factor" },
      { seq: 12, ts: "2026-08-27T00:00:01Z", from: "~noise", text: "unrelated chatter" },
    ],
  };
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === "POST") {
      posts.push(JSON.parse(init.body));
      return new Response("ok", { status: 200 });
    }
    return new Response(JSON.stringify(roomPage), { status: 200 });
  };
  const dir = await mkdtemp(`${tmpdir()}/ls-agent-test-`);
  const result = await runAgentOnce({
    room: "tradecore-lab",
    identity,
    statePath: `${dir}/state.json`,
    artifactsDir: null,
    fetchImpl,
  });
  assert.equal(result.processed, 1);
  assert.equal(result.lastSeq, 12);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].did, identity.did);
  assert.match(posts[0].text, /error re:11 factor must be/);
});
