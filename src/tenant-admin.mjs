import { assertString } from "./core.mjs";
import { PUBLIC_SOURCES } from "./data-source.mjs";

// テナント用Warehouseへの管理接続（docs/data-tenancy.md §5 チェック3）。
// 旧secondaryは「CI変数がテナント用を指しidle停止が発動しない」設定ミスで月$1,670を溶かした
// （bot-2509 HiveFi-Labs/bot-2509#3812）。教訓は変数の用途分離を運用ではなく構造で守ること:
//   1. このモジュールが読む環境変数は ALPHAGRAPH_TENANT_ADMIN_* の3つだけ。
//      CLICKHOUSE_* や bot-2509 の変数へのフォールバック経路はコードに存在しない。
//   2. https のみ・URL userinfo 禁止。資格情報はヘッダでしか送らない。
//   3. 生データ公開レーンのホスト（data-source.mjs の許可リスト）には管理資格情報を送れない。
//      二つのレーンが構造的に交差しないことをここで固定する。

export function tenantAdminFromEnv(env = process.env) {
  const url = env.ALPHAGRAPH_TENANT_ADMIN_URL;
  if (!url) {
    throw new Error(
      "Set ALPHAGRAPH_TENANT_ADMIN_URL to the dedicated tenant warehouse endpoint. "
      + "Never point it at the bot-2509 primary or reuse retired secondary variables.",
    );
  }
  const username = env.ALPHAGRAPH_TENANT_ADMIN_USER;
  const password = env.ALPHAGRAPH_TENANT_ADMIN_PASSWORD;
  if (!username || !password) {
    throw new Error("Set ALPHAGRAPH_TENANT_ADMIN_USER and ALPHAGRAPH_TENANT_ADMIN_PASSWORD.");
  }
  return createTenantConnection({ url, username, password });
}

export function createTenantConnection({ url, username, password }) {
  const endpoint = new URL(String(url));
  if (endpoint.protocol !== "https:") throw new Error(`Refusing a non-HTTPS warehouse endpoint: ${endpoint.protocol}`);
  if (endpoint.username || endpoint.password) throw new Error("Refusing a warehouse URL that carries credentials in its userinfo.");
  if (PUBLIC_SOURCES.has(endpoint.host)) {
    throw new Error(`Refusing to send credentials to a public data lane host: ${endpoint.host}`);
  }
  assertString(username, "warehouse username", { max: 100 });
  assertString(password, "warehouse password", { max: 500 });
  return { endpoint: endpoint.toString(), host: endpoint.host, username, password };
}

// HTTPインターフェースで1文ずつ実行する（複文はHTTPでは通らない）。
// サーバが応答したエラーには clickhouse フラグを立て、ネットワーク障害と区別できるようにする
// （tenant-verify は「サーバに拒否された」ことだけを denied と数えるため）。
async function post(connection, { query, body }, fetchImpl, timeoutMs = 60_000) {
  const url = new URL(connection.endpoint);
  if (query) url.searchParams.set("query", query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "X-ClickHouse-User": connection.username,
        "X-ClickHouse-Key": connection.password,
        "content-type": "text/plain; charset=utf-8",
      },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`ClickHouse returned HTTP ${response.status}: ${text.slice(0, 300)}`);
      error.clickhouse = true;
      error.status = response.status;
      throw error;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function executeStatements(connection, statements, fetchImpl = fetch) {
  let executed = 0;
  for (const sql of statements) {
    await post(connection, { body: sql }, fetchImpl);
    executed += 1;
  }
  return { executed };
}

export async function queryJson(connection, sql, fetchImpl = fetch) {
  const text = await post(connection, { body: `${sql} FORMAT JSON` }, fetchImpl);
  try {
    return JSON.parse(text).data ?? [];
  } catch {
    throw new Error("ClickHouse returned invalid JSON for a FORMAT JSON query.");
  }
}

export async function insertJsonRows(connection, table, rows, fetchImpl = fetch) {
  assertString(table, "table", { max: 100, pattern: /^[a-z0-9_]+\.[a-z0-9_]+$/ });
  if (!Array.isArray(rows) || !rows.length) throw new Error("insertJsonRows requires a non-empty array of rows.");
  await post(connection, {
    query: `INSERT INTO ${table} FORMAT JSONEachRow`,
    body: `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  }, fetchImpl);
  return { inserted: rows.length };
}

// ゲート検査の1プローブ。サーバに拒否された（clickhouseフラグ付きエラー）ときだけ
// denied と観測する。ネットワーク障害はそのまま投げて検査全体を中断する——
// 「届かなかった」を「遮断が効いている」と読み違えるのが一番危ない誤判定なので。
export async function runProbe(connection, sql, fetchImpl = fetch) {
  try {
    const body = await post(connection, { body: sql }, fetchImpl);
    return { observed: "ok", body, error: null };
  } catch (error) {
    if (error?.clickhouse) return { observed: "denied", body: null, error: String(error.message).slice(0, 200) };
    throw error;
  }
}
