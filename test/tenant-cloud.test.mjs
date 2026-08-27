import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  CLOUD_API_ROOT,
  fetchUsageCost,
  parseIpAllowList,
  provisionTenantService,
  resolveOrganizationId,
  tenantCloudFromEnv,
} from "../src/tenant-cloud.mjs";

const client = {
  apiRoot: CLOUD_API_ROOT,
  keyId: "key-id",
  keySecret: "key-secret",
  organizationId: "org-1",
};

function jsonResponse(result) {
  return new Response(JSON.stringify({ status: 200, result }), { status: 200 });
}

test("the cloud module reads only ALPHAGRAPH_TENANT_CLOUD_* variables — no fallback path exists", async () => {
  const source = await readFile(new URL("../src/tenant-cloud.mjs", import.meta.url), "utf8");
  const code = source
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const reads = [...new Set([...code.matchAll(/env\.([A-Z0-9_]+)/g)].map((match) => match[1]))].sort();
  assert.deepEqual(reads, [
    "ALPHAGRAPH_TENANT_CLOUD_KEY_ID",
    "ALPHAGRAPH_TENANT_CLOUD_KEY_SECRET",
    "ALPHAGRAPH_TENANT_CLOUD_ORG_ID",
  ]);
  // 接続先はコントロールプレーン固定。資格情報が他のホストへ向かう組み立てが無い
  assert.equal(CLOUD_API_ROOT, "https://api.clickhouse.cloud");
});

test("missing key variables are refused with the no-reuse warning", () => {
  assert.throws(() => tenantCloudFromEnv({}), /ALPHAGRAPH_TENANT_CLOUD_KEY_ID/);
  assert.throws(() => tenantCloudFromEnv({ ALPHAGRAPH_TENANT_CLOUD_KEY_ID: "x" }), /never reuse a bot-2509/);
});

test("ingress must be an explicit choice: 'anywhere' or concrete CIDRs, nothing implicit", () => {
  assert.deepEqual(parseIpAllowList("anywhere")[0].source, "0.0.0.0/0");
  const list = parseIpAllowList("203.0.113.7/32, 2001:db8::/48");
  assert.deepEqual(list.map((entry) => entry.source), ["203.0.113.7/32", "2001:db8::/48"]);
  assert.throws(() => parseIpAllowList("0.0.0.0/0; DROP"), /invalid format/);
  assert.throws(() => parseIpAllowList(""), /non-empty/);
});

test("a lone-organization key resolves; an ambiguous one demands the explicit variable", async () => {
  const single = await resolveOrganizationId({ ...client, organizationId: null }, async () => jsonResponse([{ id: "only-org" }]));
  assert.equal(single, "only-org");
  await assert.rejects(
    resolveOrganizationId({ ...client, organizationId: null }, async () => jsonResponse([{ id: "a" }, { id: "b" }])),
    /ALPHAGRAPH_TENANT_CLOUD_ORG_ID/,
  );
});

test("provisioning builds a small idle-stopping service and verifies idleScaling came back on", async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization };
    return jsonResponse({
      service: {
        id: "svc-1",
        name: "alphagraph-tenant",
        idleScaling: true,
        idleTimeoutMinutes: 15,
        endpoints: [{ protocol: "nativesecure", host: "h", port: 9440 }, { protocol: "https", host: "abc.clickhouse.cloud", port: 8443 }],
      },
      password: "returned-once",
    });
  };
  const result = await provisionTenantService(client, {
    provider: "aws",
    region: "ap-northeast-1",
    ipAccessList: parseIpAllowList("203.0.113.7/32"),
  }, fetchImpl);
  assert.equal(sent.url, "https://api.clickhouse.cloud/v1/organizations/org-1/services");
  assert.equal(sent.auth, `Basic ${Buffer.from("key-id:key-secret").toString("base64")}`);
  assert.equal(sent.body.idleScaling, true);
  assert.equal(sent.body.idleTimeoutMinutes, 15);
  assert.equal(sent.body.numReplicas, 1);
  assert.equal(sent.body.minReplicaMemoryGb, 8);
  assert.equal(sent.body.maxReplicaMemoryGb, 8);
  assert.equal(sent.body.dataWarehouseId, undefined);
  assert.equal(result.adminUrl, "https://abc.clickhouse.cloud:8443");
  assert.deepEqual(result.warnings, []);
  assert.equal(result.password, "returned-once");
});

test("a warehouse secondary is read-only, and a service that ignores idle scaling raises a warning", async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return jsonResponse({ service: { id: "svc-2", idleScaling: false, endpoints: [] }, password: "p" });
  };
  const result = await provisionTenantService(client, {
    provider: "gcp",
    region: "asia-northeast1",
    warehouseId: "wh-1",
    ipAccessList: parseIpAllowList("anywhere"),
  }, fetchImpl);
  assert.equal(sent.dataWarehouseId, "wh-1");
  assert.equal(sent.isReadonly, true);
  // #3812の教訓: 「idle停止を頼んだ」と「idle停止が付いた」は別の事実
  assert.ok(result.warnings.some((warning) => /idleScaling/.test(warning)));
  assert.ok(result.warnings.some((warning) => /https endpoint/.test(warning)));
});

test("provisioning validates inputs before any request leaves", async () => {
  let called = 0;
  const spy = async () => { called += 1; return jsonResponse({}); };
  await assert.rejects(provisionTenantService(client, { provider: "digitalocean", region: "x", ipAccessList: [{ source: "1.1.1.1" }] }, spy), /invalid format|at most/);
  await assert.rejects(provisionTenantService(client, { provider: "aws", region: "ap-northeast-1", ipAccessList: [] }, spy), /explicit ipAccessList/);
  assert.equal(called, 0);
});

test("usage cost aggregates per-service records and keeps the grand total", async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /\/v1\/organizations\/org-1\/usageCost\?from_date=2026-08-20&to_date=2026-08-27$/);
    return jsonResponse({
      grandTotalCHC: 12.5,
      costs: [
        { entityType: "service", entityName: "alphagraph-tenant", totalCHC: 5, date: "2026-08-26" },
        { entityType: "service", entityName: "alphagraph-tenant", totalCHC: 7, date: "2026-08-27" },
        { entityType: "datawarehouse", entityName: "wh", totalCHC: 0.5, date: "2026-08-27" },
      ],
    });
  };
  const report = await fetchUsageCost(client, { fromDate: "2026-08-20", toDate: "2026-08-27" }, fetchImpl);
  assert.equal(report.grandTotalCHC, 12.5);
  assert.deepEqual(report.services, [{ entityName: "alphagraph-tenant", totalCHC: 12, days: 2 }]);
  await assert.rejects(fetchUsageCost(client, { fromDate: "20260820", toDate: "2026-08-27" }, fetchImpl), /invalid format/);
});
