import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, stableStringify } from "../src/core.mjs";
import { didFromPrivateKey } from "../src/did.mjs";
import { appendEvent, verifyChain, readLedger } from "../src/ledger.mjs";
import {
  QUOTA_CLASSES,
  TENANT_DATABASE,
  TENANT_ROLE,
  buildBaseDdl,
  buildTenantRevokeDdl,
  buildUsageQuery,
  chDateTimeUtc,
  newTenantCredential,
  planTenantGrant,
  tenantCheckProbes,
  tenantUsername,
} from "../src/tenant.mjs";

const { privateKey } = generateKeyPairSync("ed25519");
const did = didFromPrivateKey(privateKey);

test("tenant usernames are deterministic, hash-derived, and only mint for valid DIDs", () => {
  assert.equal(tenantUsername(did), tenantUsername(did));
  assert.match(tenantUsername(did), /^t_[0-9a-f]{16}$/);
  assert.throws(() => tenantUsername("did:key:zNotAKey"), /Ed25519|base58/);
  assert.throws(() => tenantUsername("alice@example.com"), /did:key/);
});

test("credentials are salted per ClickHouse sha256_hash semantics and never repeat", () => {
  const a = newTenantCredential();
  const b = newTenantCredential();
  assert.equal(a.sha256Hex, sha256(a.password + a.salt));
  assert.notEqual(a.password, b.password);
  assert.notEqual(a.salt, b.salt);
  assert.ok(a.password.length >= 32);
});

test("the grant plan puts no secret material on the ledger", () => {
  const plan = planTenantGrant({ did, days: 7, now: new Date("2026-08-27T00:00:00Z") });
  const ledgerText = stableStringify(plan.ledgerData);
  assert.equal(ledgerText.includes(plan.credential.password), false);
  assert.equal(ledgerText.includes(plan.credential.salt), false);
  assert.equal(ledgerText.includes(plan.credential.sha256Hex), false);
  // 一方でDDL全文へのコミットメントは残る: 発行条件の後付け変更を塞ぐ
  assert.equal(plan.ledgerData.ddlSha256, sha256(plan.ddl.join(";\n")));
  assert.equal(plan.ledgerData.tenantDid, did);
  assert.equal(plan.ledgerData.validUntil, "2026-09-03T00:00:00.000Z");
  const create = plan.ddl[0];
  assert.match(create, /IDENTIFIED WITH sha256_hash BY '[0-9a-f]{64}' SALT '[0-9a-f]{32}'/);
  assert.match(create, /VALID UNTIL '2026-09-03 00:00:00 UTC'/);
  assert.equal(create.includes(plan.credential.password), false, "the plaintext password must never appear in DDL");
});

test("base DDL encodes the #1811 gate: read-only, per-user quota, cutoff, explicit revokes", () => {
  const ddl = buildBaseDdl().join(";\n");
  assert.match(ddl, /readonly = 1 CONST/);
  assert.match(ddl, /allow_ddl = 0 CONST/);
  assert.match(ddl, /KEYED BY user_name/);
  assert.match(ddl, /REVOKE SELECT ON system\.\*/);
  assert.match(ddl, /REVOKE URL, REMOTE, S3/);
  assert.match(ddl, /AS RESTRICTIVE FOR SELECT USING day < today\(\)/);
  const quota = QUOTA_CLASSES.get("standard");
  assert.match(ddl, new RegExp(`MAX queries = ${quota.queriesPerMinute}`));
  // 唯一のGRANTは派生データベースへのSELECTだけ
  const grants = buildBaseDdl().filter((statement) => statement.startsWith("GRANT"));
  assert.deepEqual(grants, [`GRANT SELECT ON ${TENANT_DATABASE}.* TO ${TENANT_ROLE}`]);
});

test("revoke DDL and usage query validate their inputs", () => {
  assert.deepEqual(buildTenantRevokeDdl(tenantUsername(did)), [`DROP USER IF EXISTS ${tenantUsername(did)}`]);
  assert.throws(() => buildTenantRevokeDdl("admin; DROP USER default"), /invalid format/);
  assert.throws(() => buildUsageQuery("2026-8-1"), /invalid format/);
  assert.throws(() => buildUsageQuery("2026-08-27'; DROP TABLE x --"), /invalid format|at most/);
  assert.match(buildUsageQuery("2026-08-27"), /startsWith\(user, 't_'\)/);
});

test("gate probes cover both directions: reads that must work and escapes that must fail", () => {
  const probes = tenantCheckProbes();
  const denied = probes.filter((probe) => probe.expect === "denied").map((probe) => probe.name);
  assert.deepEqual(denied, ["insert-denied", "ddl-denied", "query-log-denied", "url-denied", "remote-denied"]);
  assert.ok(probes.some((probe) => probe.name === "select-data" && probe.expect === "ok"));
});

test("grant and revoke events chain on the ledger with the standard vocabulary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphagraph-tenant-"));
  const plan = planTenantGrant({ did });
  await appendEvent(directory, { type: "TENANT_GRANTED", data: plan.ledgerData, privateKey });
  await appendEvent(directory, {
    type: "TENANT_REVOKED",
    data: { schema: "alphagraph-tenant-revoke-v1", tenantDid: did, username: plan.username, reason: "test", grantSeq: 1 },
    privateKey,
  });
  const result = verifyChain(await readLedger(directory));
  assert.equal(result.valid, true);
  assert.equal(result.events, 2);
});

test("ClickHouse datetime literals are UTC and second-precision", () => {
  assert.equal(chDateTimeUtc("2026-08-27T12:34:56.789Z"), "2026-08-27 12:34:56");
  assert.throws(() => chDateTimeUtc("not a date"), /valid timestamp/);
});
