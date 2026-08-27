import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  createTenantConnection,
  executeStatements,
  insertJsonRows,
  queryJson,
  runProbe,
  tenantAdminFromEnv,
} from "../src/tenant-admin.mjs";

const connection = createTenantConnection({
  url: "https://tenant.example.clickhouse.cloud:8443/",
  username: "admin",
  password: "secret",
});

test("the admin module reads only ALPHAGRAPH_TENANT_ADMIN_* variables — no fallback path exists", async () => {
  const source = await readFile(new URL("../src/tenant-admin.mjs", import.meta.url), "utf8");
  const code = source
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const reads = [...code.matchAll(/env\.([A-Z0-9_]+)/g)].map((match) => match[1]).sort();
  // 旧secondary事故(#3812)の教訓: 接続先変数の用途分離を検査で固定する。
  // CLICKHOUSE_* や bot-2509 系の変数名がここに現れたら、それは事故の再演。
  assert.deepEqual([...new Set(reads)], [
    "ALPHAGRAPH_TENANT_ADMIN_PASSWORD",
    "ALPHAGRAPH_TENANT_ADMIN_URL",
    "ALPHAGRAPH_TENANT_ADMIN_USER",
  ]);
});

test("connections refuse missing variables, plain HTTP, userinfo, and public-lane hosts", () => {
  assert.throws(() => tenantAdminFromEnv({}), /ALPHAGRAPH_TENANT_ADMIN_URL/);
  assert.throws(
    () => tenantAdminFromEnv({ ALPHAGRAPH_TENANT_ADMIN_URL: "https://x.example" }),
    /ALPHAGRAPH_TENANT_ADMIN_USER/,
  );
  assert.throws(
    () => createTenantConnection({ url: "http://x.example", username: "a", password: "b" }),
    /non-HTTPS/,
  );
  assert.throws(
    () => createTenantConnection({ url: "https://u:p@x.example", username: "a", password: "b" }),
    /userinfo/,
  );
  assert.throws(
    () => createTenantConnection({ url: "https://api.hyperliquid.xyz", username: "a", password: "b" }),
    /public data lane/,
  );
});

test("statements run one at a time with header credentials and stop on the first server error", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ body: init.body, user: init.headers["X-ClickHouse-User"], key: init.headers["X-ClickHouse-Key"] });
    return new Response(seen.length < 2 ? "" : "Code: 497. Not enough privileges", { status: seen.length < 2 ? 200 : 403 });
  };
  await assert.rejects(
    executeStatements(connection, ["CREATE ROLE r", "GRANT x", "NEVER SENT"], fetchImpl),
    /HTTP 403/,
  );
  assert.equal(seen.length, 2);
  assert.equal(seen[0].body, "CREATE ROLE r");
  assert.equal(seen[0].user, "admin");
  assert.equal(seen[0].key, "secret");
});

test("JSON queries append FORMAT JSON and unwrap the data array", async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = init.body;
    return new Response(JSON.stringify({ data: [{ username: "t_ab", queries: "3" }] }), { status: 200 });
  };
  const rows = await queryJson(connection, "SELECT 1", fetchImpl);
  assert.equal(sent, "SELECT 1 FORMAT JSON");
  assert.deepEqual(rows, [{ username: "t_ab", queries: "3" }]);
});

test("row inserts go through the query parameter as JSONEachRow", async () => {
  let seenUrl;
  let seenBody;
  const fetchImpl = async (url, init) => {
    seenUrl = new URL(url);
    seenBody = init.body;
    return new Response("", { status: 200 });
  };
  await insertJsonRows(connection, "alphagraph_data.hl_candles_1d", [{ coin: "BTC", day: "2026-08-26" }], fetchImpl);
  assert.equal(seenUrl.searchParams.get("query"), "INSERT INTO alphagraph_data.hl_candles_1d FORMAT JSONEachRow");
  assert.equal(seenBody, "{\"coin\":\"BTC\",\"day\":\"2026-08-26\"}\n");
  await assert.rejects(insertJsonRows(connection, "system.query_log; --", [{}]), /invalid format/);
  await assert.rejects(insertJsonRows(connection, "alphagraph_data.t", []), /non-empty/);
});

test("probes read server refusals as denied but re-throw transport failures", async () => {
  const refused = await runProbe(connection, "SELECT 1", async () => new Response("Code: 497", { status: 403 }));
  assert.equal(refused.observed, "denied");
  assert.match(refused.error, /HTTP 403/);
  const allowed = await runProbe(connection, "SELECT 1", async () => new Response("1\n", { status: 200 }));
  assert.equal(allowed.observed, "ok");
  assert.equal(allowed.body, "1\n");
  // ネットワーク障害を「遮断が効いている」と読み違えないこと
  await assert.rejects(
    runProbe(connection, "SELECT 1", async () => { throw new TypeError("fetch failed"); }),
    /fetch failed/,
  );
});
