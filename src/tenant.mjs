import { randomBytes } from "node:crypto";
import { assertNumber, assertString, sha256 } from "./core.mjs";
import { publicKeyFromDid } from "./did.mjs";

// 計算持ち込みレーンのPhase 1（docs/data-tenancy.md §6）。
// このモジュールは接続を持たない純ロジック: DDLと台帳イベントの中身を決めるだけ。
// 原則（同 §4）: credentialの発行そのものを台帳イベントにする。ただし台帳は公開されるので、
// パスワードはもちろん、そのハッシュとsaltも台帳には決して載せない（オフライン攻撃の材料になる）。

export const TENANT_DATABASE = "alphagraph_data";
export const TENANT_ROLE = "alphagraph_reader";
export const TENANT_PROFILE = "alphagraph_tenant_profile";
export const TENANT_QUOTA = "alphagraph_tenant_quota";

// bot-2509 実測値の再利用（docs/data-tenancy.md §3）: 8GB/query・120s・60q/min。
// dry-runで観測してから絞る二段階運用が前提なので、初期値は緩め・上限は明示。
export const QUOTA_CLASSES = new Map([
  ["standard", {
    queriesPerMinute: 60,
    maxMemoryBytesPerQuery: 8_000_000_000,
    maxExecutionSeconds: 120,
    readBytesPerDay: 500_000_000_000,
  }],
]);

// ClickHouseのDateTimeリテラル（UTC固定）。VALID UNTIL は ' UTC' を明示して
// サーバのタイムゾーン設定に依存させない。
export function chDateTimeUtc(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Expected a valid timestamp.");
  return date.toISOString().slice(0, 19).replace("T", " ");
}

// ユーザー名は DID から決定的に導く（docs/data-tenancy.md §4 の t_<did短縮>）。
// base58の切り詰めではなくハッシュにするのは、大文字小文字を潰しても衝突しないようにするため。
// DID⇄ユーザー名の対応は TENANT_GRANTED イベントに両方載るので、監査は台帳から辿れる。
export function tenantUsername(did) {
  publicKeyFromDid(did); // Ed25519 did:key 以外はここで弾く
  return `t_${sha256(String(did)).slice(0, 16)}`;
}

// 短命credential（同 §4-2）。#1811のsaltなしsha256_password指摘を最初から満たすため、
// 平文パスワードをDDLに書かず、クライアント側で salt 付きハッシュにしてから渡す。
// ClickHouseの検証規約: sha256_hash = SHA256(password || salt)。
export function newTenantCredential() {
  const password = randomBytes(24).toString("base64url");
  const salt = randomBytes(16).toString("hex");
  return { password, salt, sha256Hex: sha256(password + salt) };
}

// 一度だけ流す土台DDL。GRANTはdefault-denyなので SELECT ON alphagraph_data.* 以外は
// 何も持たないが、#1811ゲート（同 §5）の遮断項目は明示的なREVOKEとして書き残す:
// 意図がDDLに残り、将来誰かが広いGRANTを足しても partial revoke として打ち消される。
export function buildBaseDdl() {
  const quota = QUOTA_CLASSES.get("standard");
  return [
    `CREATE DATABASE IF NOT EXISTS ${TENANT_DATABASE}`,
    // 当社整備の派生データ（Phase 1はHL日次スナップショットのみ・再配布可能なものだけ）
    `CREATE TABLE IF NOT EXISTS ${TENANT_DATABASE}.hl_candles_1d (
  coin LowCardinality(String),
  day Date,
  open Float64,
  high Float64,
  low Float64,
  close Float64,
  volume Float64,
  source LowCardinality(String),
  csv_sha256 FixedString(64),
  inserted_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(inserted_at) ORDER BY (coin, day)`,
    // データの来歴はテナントからも読める。台帳の provenance 成果物と csv_sha256 で突き合う
    `CREATE TABLE IF NOT EXISTS ${TENANT_DATABASE}.dataset_provenance (
  dataset LowCardinality(String),
  coin String,
  bar_interval LowCardinality(String),
  bars UInt32,
  start_at DateTime,
  end_at DateTime,
  csv_sha256 FixedString(64),
  fetched_at DateTime,
  provenance_json String,
  inserted_at DateTime DEFAULT now()
) ENGINE = MergeTree ORDER BY (dataset, coin, fetched_at)`,
    `CREATE ROLE IF NOT EXISTS ${TENANT_ROLE}`,
    `GRANT SELECT ON ${TENANT_DATABASE}.* TO ${TENANT_ROLE}`,
    // 他テナントのクエリ文字列＝研究仮説そのものが漏れる経路（§5 チェック1）
    `REVOKE SELECT ON system.* FROM ${TENANT_ROLE}`,
    // QUOTA外のデータ持ち出し・持ち込み経路（§5 チェック2）
    `REVOKE URL, REMOTE, S3, FILE, HDFS, MYSQL, POSTGRES, ODBC, JDBC ON *.* FROM ${TENANT_ROLE}`,
    `REVOKE CREATE TEMPORARY TABLE ON *.* FROM ${TENANT_ROLE}`,
    `CREATE SETTINGS PROFILE IF NOT EXISTS ${TENANT_PROFILE} SETTINGS `
      + "readonly = 1 CONST, allow_ddl = 0 CONST, allow_introspection_functions = 0 CONST, "
      + `max_memory_usage = ${quota.maxMemoryBytesPerQuery} MAX ${quota.maxMemoryBytesPerQuery}, `
      + `max_execution_time = ${quota.maxExecutionSeconds} MAX ${quota.maxExecutionSeconds}, `
      + `max_result_rows = 10000000 MAX 10000000 TO ${TENANT_ROLE}`,
    // DIDごとのQUOTA＝レート制限（fable-concept §5）。KEYED BY user_name なので
    // QUOTAオブジェクトは一つでも計上はテナント別
    `CREATE QUOTA IF NOT EXISTS ${TENANT_QUOTA} KEYED BY user_name `
      + `FOR INTERVAL 1 minute MAX queries = ${quota.queriesPerMinute}, `
      + `FOR INTERVAL 1 day MAX read_bytes = ${quota.readBytesPerDay} TO ${TENANT_ROLE}`,
    // TIMESERIES_CUTOFF の転用（§3）: materialize済みの日次のみ＝当日分は構造的に見えない
    `CREATE ROW POLICY IF NOT EXISTS alphagraph_tenant_all ON ${TENANT_DATABASE}.hl_candles_1d `
      + `AS PERMISSIVE FOR SELECT USING 1 TO ${TENANT_ROLE}`,
    `CREATE ROW POLICY IF NOT EXISTS alphagraph_tenant_cutoff ON ${TENANT_DATABASE}.hl_candles_1d `
      + `AS RESTRICTIVE FOR SELECT USING day < today() TO ${TENANT_ROLE}`,
  ];
}

export function buildTenantGrantDdl({ username, credential, validUntil }) {
  assertString(username, "username", { max: 40, pattern: /^t_[0-9a-f]{16}$/ });
  assertString(credential.sha256Hex, "credential hash", { max: 64, pattern: /^[0-9a-f]{64}$/ });
  assertString(credential.salt, "credential salt", { max: 64, pattern: /^[0-9a-f]{32}$/ });
  return [
    `CREATE USER ${username} IDENTIFIED WITH sha256_hash BY '${credential.sha256Hex}' SALT '${credential.salt}' `
      + `VALID UNTIL '${chDateTimeUtc(validUntil)} UTC' SETTINGS PROFILE '${TENANT_PROFILE}'`,
    `GRANT ${TENANT_ROLE} TO ${username}`,
    `ALTER USER ${username} DEFAULT ROLE ${TENANT_ROLE}`,
  ];
}

export function buildTenantRevokeDdl(username) {
  assertString(username, "username", { max: 40, pattern: /^t_[0-9a-f]{16}$/ });
  return [`DROP USER IF EXISTS ${username}`];
}

// 発行の計画を一括で作る。ledgerData には秘密（password/salt/hash）を一切入れない。
// ddlSha256 はDDL全文（ハッシュ・saltを含む）へのコミットメント: 後から「別条件で作った」
// と言い換える経路を塞ぎつつ、台帳からは秘密が復元できない。
export function planTenantGrant({ did, days = 14, now = new Date() }) {
  const username = tenantUsername(did);
  const validDays = assertNumber(days, "days", { min: 1, max: 90, integer: true });
  const validUntil = new Date(now.getTime() + (validDays * 86_400_000));
  const credential = newTenantCredential();
  const ddl = buildTenantGrantDdl({ username, credential, validUntil });
  const quota = QUOTA_CLASSES.get("standard");
  const ledgerData = {
    schema: "alphagraph-tenant-grant-v1",
    tenantDid: String(did),
    username,
    role: TENANT_ROLE,
    profile: TENANT_PROFILE,
    quota: { name: TENANT_QUOTA, class: "standard", ...quota },
    access: `read-only SELECT on ${TENANT_DATABASE}.*`,
    validUntil: validUntil.toISOString(),
    credentialDelivery: "out-of-band; the public ledger never carries the password, its salt, or its hash",
    ddlSha256: sha256(ddl.join(";\n")),
  };
  return { username, credential, validUntil, ddl, ledgerData };
}

export function buildTenantRevokeData({ did, reason, grantSeq }) {
  return {
    schema: "alphagraph-tenant-revoke-v1",
    tenantDid: String(did),
    username: tenantUsername(did),
    reason: assertString(reason ?? "unspecified", "reason", { max: 200 }),
    grantSeq: grantSeq ?? null,
  };
}

// 監査は公開（docs/data-tenancy.md §4-5）: system.query_log の日次集計を USAGE_REPORTED に積む。
// 「防止でなく検出」——量の異常も無活動も、台帳を読む誰もが同じ数字を見られる状態にする。
export function buildUsageQuery(date) {
  assertString(date, "date", { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ });
  return "SELECT user AS username, "
    + "countIf(type = 'QueryFinish') AS queries, "
    + "countIf(type = 'ExceptionBeforeStart' OR type = 'ExceptionWhileProcessing') AS failed, "
    + "sum(read_rows) AS readRows, sum(read_bytes) AS readBytes "
    + `FROM system.query_log WHERE event_date = '${date}' AND type != 'QueryStart' `
    + "AND startsWith(user, 't_') GROUP BY user ORDER BY user";
}

export function buildUsageData({ date, rows, endpointHost }) {
  return {
    schema: "alphagraph-tenant-usage-v1",
    date,
    source: "system.query_log",
    endpointHost,
    tenants: rows.map((row) => ({
      username: assertString(row.username, "username", { max: 40 }),
      queries: Number(row.queries),
      failed: Number(row.failed),
      readRows: Number(row.readRows),
      readBytes: Number(row.readBytes),
    })),
  };
}

// 「自分のDIDで一周」の検証項目。expectが denied の行は #1811 ゲート（§5）の遮断が
// 実サービスで効いていることの実測になる。方針をDDLで書いただけでは一周にならない。
export function tenantCheckProbes() {
  return [
    { name: "select-data", expect: "ok", sql: `SELECT count() FROM ${TENANT_DATABASE}.hl_candles_1d` },
    { name: "select-provenance", expect: "ok", sql: `SELECT count() FROM ${TENANT_DATABASE}.dataset_provenance` },
    { name: "cutoff-today-hidden", expect: "ok", expectBody: "1", sql: `SELECT countIf(day >= today()) = 0 FROM ${TENANT_DATABASE}.hl_candles_1d` },
    { name: "insert-denied", expect: "denied", sql: `INSERT INTO ${TENANT_DATABASE}.hl_candles_1d (coin, day) VALUES ('X', today())` },
    { name: "ddl-denied", expect: "denied", sql: `CREATE TABLE ${TENANT_DATABASE}.smuggle (x String) ENGINE = MergeTree ORDER BY x` },
    { name: "query-log-denied", expect: "denied", sql: "SELECT count() FROM system.query_log" },
    { name: "url-denied", expect: "denied", sql: "SELECT * FROM url('https://example.invalid/x.csv', 'CSV', 'x String')" },
    { name: "remote-denied", expect: "denied", sql: "SELECT * FROM remote('127.0.0.1', system.one)" },
  ];
}
