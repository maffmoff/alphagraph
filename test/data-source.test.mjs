import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PUBLIC_SOURCES, assertPublicRequest, fetchHyperliquidCandles, publicFetch } from "../src/data-source.mjs";

test("the module cannot read credentials because it never touches the environment", async () => {
  const source = await readFile(new URL("../src/data-source.mjs", import.meta.url), "utf8");
  // 方針ではなく構造で守る: 資格情報を読む経路そのものがモジュール内に存在しない。
  // 検査対象はコードだけ（コメントは自身の禁止事項を書くため除去してから見る）。
  // 改行を正規化してから見る。JSの `.` は \r にマッチしないので、CRLFのまま行コメントを
  // 剥がそうとすると剥がれない（Windowsでの実測）。.gitattributes で変換自体は止めてあるが、
  // 利用者のgit設定に依存しないよう、ここでも正規化する。
  const code = source
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.equal(/process\.env/.test(code), false, "data-source.mjs must never read process.env");
  // 鍵を扱う経路が無いことを見る（CREDENTIAL_PARAMS の否定リストは検査対象ではなく防具）。
  assert.equal(/loadIdentity|privateKey|signText|generateKeyPair/.test(code), false, "data-source.mjs must not handle secrets");
});

test("only allowlisted public hosts are reachable", () => {
  assert.throws(() => assertPublicRequest("https://api.example.com/data"), /not on the public data allowlist/);
  assert.throws(() => assertPublicRequest("http://api.hyperliquid.xyz/info"), /non-HTTPS/);
  assert.equal(assertPublicRequest("https://api.hyperliquid.xyz/info").auth, "none");
  assert.equal(PUBLIC_SOURCES.get("api.hyperliquid.xyz").redistributable, true);
});

test("credential-shaped requests are refused before they are sent", async () => {
  assert.throws(() => assertPublicRequest("https://u:p@api.hyperliquid.xyz/info"), /userinfo/);
  assert.throws(
    () => assertPublicRequest("https://api.hyperliquid.xyz/info", { headers: { Authorization: "Bearer x" } }),
    /credential header/,
  );
  assert.throws(
    () => assertPublicRequest("https://api.hyperliquid.xyz/info", { headers: { "X-API-Key": "x" } }),
    /credential header/,
  );
  assert.throws(
    () => assertPublicRequest("https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&signature=deadbeef"),
    /credential-shaped query parameter/,
  );
  // ゲートを通らないので fetch は一度も呼ばれない。
  let called = 0;
  const spy = async () => { called += 1; return new Response("{}"); };
  await assert.rejects(publicFetch("https://api.example.com/x", {}, spy), /allowlist/);
  assert.equal(called, 0);
});

test("candles are converted to CSV with a pinned content hash", async () => {
  const page = [
    { t: 1_700_000_000_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
    { t: 1_700_086_400_000, o: 1.5, h: 2.5, l: 1, c: 2, v: 20 },
  ];
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return new Response(JSON.stringify(requests === 1 ? page : []), { status: 200 });
  };
  const result = await fetchHyperliquidCandles({
    coin: "BTC",
    interval: "1d",
    start: "2023-11-14T22:13:20.000Z",
    end: "2023-11-17T00:00:00.000Z",
  }, fetchImpl);
  assert.equal(result.provenance.received.bars, 2);
  assert.equal(result.provenance.auth, "none");
  assert.equal(result.provenance.redistributable, true);
  assert.equal(result.provenance.csvSha256.length, 64);
  assert.ok(result.csv.startsWith("timestamp,open,high,low,close,volume\n"));
});
