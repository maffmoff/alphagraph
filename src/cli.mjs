import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import process from "node:process";
import { runAgentOnce, watchAgent } from "./bt-agent.mjs";
import { backtestFromCsv, generateSyntheticCsv, validateStrategy } from "./backtest.mjs";
import { buildDashboard } from "./dashboard.mjs";
import { fetchBinanceKlines } from "./market-data.mjs";
import {
  createAttestation,
  loadIdentity,
  passphraseFromKeychain,
  publishTechnocoreAttestation,
  verifyAttestation,
} from "./did.mjs";
import { hashJson, readJson, writeJson } from "./core.mjs";
import { REPRO_CONTRACT_HASH, compareReports, reproHashes } from "./repro.mjs";
import { citationLedger, sealPaper, verifyReveal } from "./paper.mjs";
import { appendEvent, readLedger, verifyChain } from "./ledger.mjs";
import { buildSite } from "./site.mjs";
import { fetchRoomSince, selectNewEvaluations } from "./eval-intake.mjs";
import { fetchHyperliquidCandles, fetchHyperliquidUniverse } from "./data-source.mjs";
import {
  TENANT_DATABASE,
  buildBaseDdl,
  buildTenantRevokeData,
  buildTenantRevokeDdl,
  buildUsageData,
  buildUsageQuery,
  planTenantGrant,
  tenantCheckProbes,
  tenantUsername,
} from "./tenant.mjs";
import {
  createTenantConnection,
  executeStatements,
  insertJsonRows,
  queryJson,
  runProbe,
  tenantAdminFromEnv,
} from "./tenant-admin.mjs";

const HELP = `AlphaGraph — Proof of Useful Strategy

Usage:
  alphagraph propose --strategy FILE [--output FILE]
  alphagraph demo-data [--output FILE] [--bars NUMBER]
  alphagraph fetch-binance --symbol SYMBOL --interval INTERVAL --start ISO --end ISO [--output FILE]
  alphagraph backtest --proposal FILE --data CSV [--output FILE]
  alphagraph reproduce --report FILE --data CSV [--output FILE] [--identity PEM] [--paper HASH] [--ledger DIR]
  alphagraph seal --paper FILE --identity PEM [--ledger DIR] [--output FILE] [--commitment FILE]
  alphagraph reveal --paper FILE --identity PEM [--ledger DIR] [--output DIR] [--early]
  alphagraph ledger-verify [--ledger DIR]
  alphagraph citations [--ledger DIR]
  alphagraph site [--ledger DIR] [--output DIR]
  alphagraph eval-intake --room ROOM --identity PEM [--ledger DIR] [--state FILE]
  alphagraph hl-universe [--output FILE]
  alphagraph fetch-hl --coin COIN --interval INTERVAL --start ISO --end ISO [--output FILE]
  alphagraph tenant-init [--output FILE] [--execute]
  alphagraph tenant-grant --did DID --identity PEM [--days N] [--ledger DIR] [--execute]
  alphagraph tenant-revoke --did DID --identity PEM [--reason TEXT] [--ledger DIR] [--execute]
  alphagraph tenant-load-hl --coin COIN --start ISO --end ISO [--execute]
  alphagraph tenant-usage --identity PEM [--date YYYY-MM-DD] [--ledger DIR]
  alphagraph tenant-verify --credentials FILE [--url URL] [--output FILE]
  alphagraph attest --artifact FILE --identity PEM --role ROLE --verdict VERDICT --statement TEXT [options]
  alphagraph verify --artifact FILE --attestation FILE
  alphagraph dashboard [--reports DIR] [--output FILE]
  alphagraph publish --attestation FILE --confirm PUBLISH
  alphagraph demo
  alphagraph keygen --output PEM
  alphagraph bt-agent --room ROOM --identity PEM [once]

Attest options:
  --keychain-service SERVICE   Read the PEM passphrase from macOS Keychain.
  --keychain-account ACCOUNT   Optional Keychain account selector.
  --technocore-room ROOM       Add a signed Technocore write preview; does not publish.
  --artifact-url URL           Public durable URL to include in the preview.
  --output FILE                Attestation output path.

Passphrase fallback:
  If --keychain-service is omitted, set ALPHAGRAPH_PASSPHRASE in the environment.
  (TRADECORE_PASSPHRASE is still accepted for existing keys.)

Tenant lane (docs/data-tenancy.md):
  --execute talks to the dedicated tenant warehouse configured ONLY by
  ALPHAGRAPH_TENANT_ADMIN_URL / _USER / _PASSWORD. Never point those at the
  bot-2509 primary. Credential files written by tenant-grant stay local;
  the public ledger records the grant but never a secret.

Safety:
  Backtests and the dashboard are research artifacts, not trading instructions.
  Technocore is written only by the publish command with --confirm PUBLISH.
`;

// 値を取らない真偽フラグ。ここに無い --key は値を要求する。
const BOOLEAN_FLAGS = new Set(["early", "execute"]);

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      result._.push(argument);
      continue;
    }
    const key = argument.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      result[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function defaultOutput(prefix, id, hash) {
  return resolve("artifacts", prefix, `${id}-${hash.slice(0, 10)}.json`);
}

async function propose(args) {
  if (!args.strategy) throw new Error("propose requires --strategy FILE.");
  const strategy = validateStrategy(await readJson(args.strategy));
  const strategyHash = hashJson(strategy);
  const proposal = {
    schema: "alphagraph-proposal-v1",
    createdAt: new Date().toISOString(),
    strategy,
    strategyHash,
    lock: {
      rule: "The strategy and evaluation settings above must not change after results are observed.",
      nextStep: "Publish or DID-attest this hash before the holdout or forward-test outcome is known.",
    },
  };
  const output = resolve(args.output ?? defaultOutput("proposals", strategy.id, strategyHash));
  await writeJson(output, proposal);
  return { message: "Strategy proposal locked.", output, strategyHash };
}

async function demoData(args) {
  const output = resolve(args.output ?? "data/btcusdt-1h-synthetic.csv");
  const bars = args.bars ? Number(args.bars) : 1200;
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, generateSyntheticCsv({ bars }), "utf8");
  return { message: "Synthetic fixture created. It is not real market data.", output, bars };
}

async function fetchBinance(args) {
  for (const required of ["symbol", "interval", "start", "end"]) {
    if (!args[required]) throw new Error(`fetch-binance requires --${required}.`);
  }
  const output = resolve(args.output ?? `data/${args.symbol.toLowerCase()}-${args.interval}.csv`);
  const result = await fetchBinanceKlines({
    symbol: args.symbol.toUpperCase(),
    interval: args.interval,
    start: args.start,
    end: args.end,
  });
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, result.csv, "utf8");
  const provenanceOutput = `${output}.source.json`;
  await writeJson(provenanceOutput, result.provenance);
  return {
    message: "Public Binance spot klines downloaded. No API key or trading account was used.",
    output,
    provenance: provenanceOutput,
    bars: result.provenance.received.bars,
    sha256: result.provenance.csvSha256,
  };
}

async function backtest(args) {
  if (!args.proposal || !args.data) throw new Error("backtest requires --proposal FILE and --data CSV.");
  const proposal = await readJson(args.proposal);
  if (proposal.schema !== "alphagraph-proposal-v1") throw new Error("Expected a alphagraph-proposal-v1 artifact.");
  const strategy = validateStrategy(proposal.strategy);
  if (hashJson(strategy) !== proposal.strategyHash) throw new Error("Proposal strategy hash does not match its contents.");
  const report = await backtestFromCsv(strategy, args.data);
  if (args.provenance) {
    const provenance = await readJson(args.provenance);
    if (provenance.schema !== "alphagraph-market-data-v1") throw new Error("Unsupported provenance schema.");
    if (provenance.csvSha256 !== report.data.sha256) throw new Error("Provenance CSV hash does not match the tested data.");
    if (provenance.symbol !== strategy.market.symbol || provenance.interval !== strategy.market.interval) {
      throw new Error("Provenance market does not match the strategy market.");
    }
    report.data.provenance = provenance;
    report.data.quality = {
      status: provenance.received.unexpectedIntervalGaps === 0 ? "pass" : "review",
      unexpectedIntervalGaps: provenance.received.unexpectedIntervalGaps,
      note: provenance.received.unexpectedIntervalGaps === 0
        ? "No interval gaps were detected."
        : "The provider dataset contains interval gaps; review the disclosed timestamps before accepting the result.",
    };
  }
  report.proposal = {
    file: basename(args.proposal),
    sha256: hashJson(proposal),
    strategyHash: proposal.strategyHash,
  };
  report.reproduction = reproHashes(report);
  const output = resolve(args.output ?? defaultOutput("reports", strategy.id, report.data.sha256));
  await writeJson(output, report);
  return {
    message: "Backtest completed. Mechanical gates are not an investment recommendation.",
    output,
    passedMechanicalGates: report.gate.passedMechanicalGates,
    score: report.gate.score,
    outOfSample: report.metrics.outOfSample,
  };
}

function identityPassphrase(args) {
  if (args["keychain-service"]) {
    return passphraseFromKeychain(args["keychain-service"], args["keychain-account"]);
  }
  return process.env.ALPHAGRAPH_PASSPHRASE ?? process.env.TRADECORE_PASSPHRASE;
}

async function reproduce(args) {
  if (!args.report || !args.data) throw new Error("reproduce requires --report FILE and --data CSV.");
  const authorReport = await readJson(args.report);
  const strategy = validateStrategy(authorReport.strategy);
  if (hashJson(strategy) !== authorReport.strategyHash) {
    throw new Error("Report strategy hash does not match its contents.");
  }
  const candidate = await backtestFromCsv(strategy, args.data);
  const comparison = compareReports(authorReport, candidate);
  const record = {
    schema: "alphagraph-reproduction-v1",
    grade: 1,
    contract: { schema: "alphagraph-repro-contract-v1", hash: REPRO_CONTRACT_HASH },
    ...comparison,
  };
  const output = resolve(args.output ?? defaultOutput("reproductions", strategy.id, comparison.candidate.canonicalHash));
  await writeJson(output, record);
  // 再現は台帳に積まれて初めてネットワークの計器に乗る（docs/fable-concept.md §7）。
  // --identity があれば REPRODUCTION_RECORDED を追記する。--paper で対象論文に結び付ける。
  let ledgerEvent = null;
  if (args.identity) {
    const identity = await loadIdentity(args.identity, identityPassphrase(args));
    const appended = await appendEvent(resolve(args.ledger ?? "ledger"), {
      type: "REPRODUCTION_RECORDED",
      data: {
        grade: 1,
        paperHash: args.paper ?? null,
        subject: comparison.subject,
        verdict: comparison.verdict,
        contractHash: REPRO_CONTRACT_HASH,
        author: comparison.author,
        candidate: comparison.candidate,
        reproducerDid: identity.did,
      },
      privateKey: identity.privateKey,
    });
    ledgerEvent = appended.path;
  }
  if (!comparison.reproduced) process.exitCode = 1;
  return {
    ledgerEvent,
    message: comparison.reproduced
      ? "Grade-1 reproduction succeeded. Sign it with: alphagraph attest --verdict reproduced"
      : `Grade-1 reproduction failed (${comparison.verdict}).`,
    output,
    verdict: comparison.verdict,
    note: comparison.note,
    differences: comparison.differences,
  };
}

async function seal(args) {
  if (!args.paper || !args.identity) throw new Error("seal requires --paper FILE and --identity PEM.");
  const identity = await loadIdentity(args.identity, identityPassphrase(args));
  const sealed = sealPaper(await readJson(args.paper));
  const ledgerDir = resolve(args.ledger ?? "ledger");
  // 台帳に載るのは commitment（ハッシュ・型・公開予定・引用・データ釘）だけ。
  // 主張も方法も出ない。これが封緘＝commit-reveal の commit 側。
  const { event, path } = await appendEvent(ledgerDir, {
    type: "PAPER_SEALED",
    data: sealed.commitment,
    privateKey: identity.privateKey,
  });
  const record = {
    schema: "alphagraph-sealed-paper-v1",
    paperHash: sealed.paperHash,
    sealedBy: identity.did,
    ledger: { seq: event.seq, eventHash: event.hash, at: event.at },
    commitment: sealed.commitment,
    paper: sealed.paper,
  };
  const output = resolve(args.output ?? defaultOutput("sealed", sealed.paper.id, sealed.paperHash));
  await writeJson(output, record);
  // 告知用の公開成果物。台帳イベントの data と同一なので、そのハッシュは
  // 誰でも台帳から再計算できる（event.canonical に hashJson(data) が入っている）。
  // 封緘済みレコードの方は全文を含むため、そのハッシュを告知に使っても台帳から辿れない。
  const commitmentPath = resolve(args.commitment ?? defaultOutput("commitments", sealed.paper.id, hashJson(sealed.commitment)));
  await writeJson(commitmentPath, sealed.commitment);
  return {
    message: "Paper sealed. Only the commitment is on the ledger; the full text stays local until reveal.",
    output,
    commitment: commitmentPath,
    ledgerEvent: path,
    paperHash: sealed.paperHash,
    commitmentHash: hashJson(sealed.commitment),
    did: identity.did,
    seq: event.seq,
  };
}

// reveal＝commit-reveal の reveal 側（docs/fable-concept.md §2、docs/ledger-design.md 部品2）。
// 猶予期間の満了時に全文を公開し、台帳が封緘時のハッシュとの一致を検証する。
// 一致しない全文は受け付けない——後から主張を書き換える経路を塞ぐのが封緘の目的なので、
// ここを緩めると制度全体が意味を失う。
async function reveal(args) {
  if (!args.paper || !args.identity) throw new Error("reveal requires --paper FILE and --identity PEM.");
  const identity = await loadIdentity(args.identity, identityPassphrase(args));
  const paper = await readJson(args.paper);
  const ledgerDir = resolve(args.ledger ?? "ledger");
  const events = await readLedger(ledgerDir);
  const sealedEvent = events.find(
    (event) => event.type === "PAPER_SEALED" && event.data.paperHash === hashJson(paper),
  );
  if (!sealedEvent) {
    throw new Error("No PAPER_SEALED event on this ledger matches the submitted full text. Reveal is refused.");
  }
  const check = verifyReveal(paper, sealedEvent.data.paperHash);
  if (!check.valid) throw new Error(`Revealed text hashes to ${check.paperHash}, not the sealed ${check.expected}.`);
  if (events.some((event) => event.type === "PAPER_REVEALED" && event.data.paperHash === check.paperHash)) {
    throw new Error("This paper has already been revealed on the ledger.");
  }
  // 猶予期間中の早期公開は著者の権利だが（猶予は上限であって義務ではない・§2）、
  // 事故で出してしまうと取り返しがつかない。明示的な --early を要求する。
  // 起点は封緘時とする（未決1: 起点をラウンド退出時にする案が未決）。
  if (sealedEvent.data.disclosure?.policy === "embargo" && !("early" in args)) {
    const endsAt = Date.parse(sealedEvent.at) + (sealedEvent.data.disclosure.embargoDays * 86_400_000);
    if (Date.now() < endsAt) {
      const daysLeft = Math.ceil((endsAt - Date.now()) / 86_400_000);
      throw new Error(
        `Embargo has ${daysLeft} day(s) left (until ${new Date(endsAt).toISOString()}). `
        + "Revealing early is allowed but must be deliberate: pass --early.",
      );
    }
  }

  // 全文は公開ディレクトリへ。ここに置かれたものが「公開された」の実体になる。
  const publicDir = resolve(args.output ?? "papers");
  const publicPath = resolve(publicDir, `${sealedEvent.data.id}.json`);
  await writeJson(publicPath, paper);

  const { event, path } = await appendEvent(ledgerDir, {
    type: "PAPER_REVEALED",
    data: {
      paperHash: check.paperHash,
      id: sealedEvent.data.id,
      sealedSeq: sealedEvent.seq,
      sealedAt: sealedEvent.at,
      publishedPath: `papers/${sealedEvent.data.id}.json`,
      revealedBy: identity.did,
    },
    privateKey: identity.privateKey,
  });
  return {
    message: "Full text published and matched against the seal. The paper is now citable in full.",
    paper: publicPath,
    ledgerEvent: path,
    paperHash: check.paperHash,
    seq: event.seq,
  };
}

async function ledgerVerify(args) {
  const ledgerDir = resolve(args.ledger ?? "ledger");
  const result = verifyChain(await readLedger(ledgerDir));
  if (!result.valid) process.exitCode = 1;
  return { message: result.valid ? "Ledger chain is intact." : "Ledger chain is BROKEN.", ledger: ledgerDir, ...result };
}

async function citations(args) {
  const ledgerDir = resolve(args.ledger ?? "ledger");
  const events = await readLedger(ledgerDir);
  const graph = citationLedger(events.filter((event) => event.type === "PAPER_SEALED").map((event) => event.data));
  return {
    message: "Citation graph folded from the ledger. Counts are kept per kind; unsigned totals are never used.",
    papers: graph.length,
    nodes: graph.map((node) => ({
      id: node.id ?? null,
      paperHash: node.paperHash.slice(0, 12),
      type: node.type ?? "external",
      cites: node.cites.map((citation) => `${citation.kind}:${citation.paperHash.slice(0, 12)}`),
      citedBy: node.counts,
    })),
  };
}

async function site(args) {
  const result = await buildSite(resolve(args.ledger ?? "ledger"), resolve(args.output ?? "site"));
  return { message: "Ledger projected to a deterministic static page. Re-generating from the same ledger yields the same hash.", ...result };
}

// Technocore の署名付き反応を EVALUATION_SIGNED として台帳に積む（src/eval-intake.mjs）。
async function evalIntake(args) {
  if (!args.room || !args.identity) throw new Error("eval-intake requires --room ROOM and --identity PEM.");
  const identity = await loadIdentity(args.identity, identityPassphrase(args));
  const ledgerDir = resolve(args.ledger ?? "ledger");
  const statePath = resolve(args.state ?? "artifacts/eval-intake-state.json");
  let state = { rooms: {} };
  try { state = await readJson(statePath); } catch { /* 初回 */ }
  const sinceSeq = state.rooms?.[args.room] ?? 0;

  const { lastSeq, messages } = await fetchRoomSince(args.room, sinceSeq);
  const ledgerEvents = await readLedger(ledgerDir);
  const fresh = selectNewEvaluations(ledgerEvents, messages);
  const appended = [];
  for (const evaluation of fresh) {
    const { event } = await appendEvent(ledgerDir, {
      type: "EVALUATION_SIGNED",
      data: evaluation,
      privateKey: identity.privateKey,
    });
    appended.push({ seq: event.seq, paperHash: evaluation.paperHash.slice(0, 12), verdict: evaluation.verdict, from: evaluation.evaluatorDid.slice(0, 24) });
  }
  state.rooms = { ...state.rooms, [args.room]: lastSeq };
  await writeJson(statePath, state);
  return {
    message: appended.length
      ? "Signed reactions recorded as EVALUATION_SIGNED. They are server-attested, not independently verifiable (fable-concept §6)."
      : "No new signed evaluations in this room.",
    room: args.room,
    scannedUpTo: lastSeq,
    recorded: appended,
  };
}

async function hlUniverse(args) {
  const result = await fetchHyperliquidUniverse();
  const output = resolve(args.output ?? "data/hl-universe.json");
  await writeJson(output, { schema: "alphagraph-universe-v1", provenance: result.provenance, coins: result.coins });
  return { message: "Hyperliquid perp universe downloaded from the public info API. No credentials were used.", output, coins: result.coins.length };
}

async function fetchHl(args) {
  for (const required of ["coin", "interval", "start", "end"]) {
    if (!args[required]) throw new Error(`fetch-hl requires --${required}.`);
  }
  const result = await fetchHyperliquidCandles({
    coin: args.coin,
    interval: args.interval,
    start: args.start,
    end: args.end,
  });
  const output = resolve(args.output ?? `data/hl-${args.coin.toLowerCase()}-${args.interval}.csv`);
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, result.csv, "utf8");
  const provenanceOutput = `${output}.source.json`;
  await writeJson(provenanceOutput, result.provenance);
  return {
    message: "Public Hyperliquid candles downloaded. No API key, wallet, or signature was used.",
    output,
    provenance: provenanceOutput,
    bars: result.provenance.received.bars,
    sha256: result.provenance.csvSha256,
  };
}

// ---- 計算持ち込みレーン Phase 1（docs/data-tenancy.md §6）----

// 台帳上のテナント状態: 同じユーザー名の GRANTED/REVOKED を時系列で畳む。
function latestTenantGrant(events, username) {
  let active = null;
  for (const event of events) {
    if (event.type === "TENANT_GRANTED" && event.data.username === username) active = event;
    if (event.type === "TENANT_REVOKED" && event.data.username === username) active = null;
  }
  return active;
}

async function writeSecretFile(path, text) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
}

async function tenantInit(args) {
  const ddl = buildBaseDdl();
  const output = resolve(args.output ?? "artifacts/tenant/base.sql");
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, `${ddl.join(";\n\n")};\n`, "utf8");
  let executed = null;
  if ("execute" in args) executed = (await executeStatements(tenantAdminFromEnv(), ddl)).executed;
  return {
    message: executed === null
      ? "Tenant base DDL written. Apply it with --execute once ALPHAGRAPH_TENANT_ADMIN_* points at the dedicated warehouse."
      : "Tenant base DDL applied to the dedicated warehouse.",
    output,
    statements: ddl.length,
    executed,
  };
}

async function tenantGrant(args) {
  if (!args.did || !args.identity) throw new Error("tenant-grant requires --did DID and --identity PEM.");
  const identity = await loadIdentity(args.identity, identityPassphrase(args));
  const ledgerDir = resolve(args.ledger ?? "ledger");
  const plan = planTenantGrant({ did: args.did, days: args.days ? Number(args.days) : undefined });
  const active = latestTenantGrant(await readLedger(ledgerDir), plan.username);
  if (active && Date.parse(active.data.validUntil) > Date.now()) {
    throw new Error(
      `An unexpired grant for ${plan.username} is already on the ledger (seq ${active.seq}, `
      + `valid until ${active.data.validUntil}). Revoke it before granting again.`,
    );
  }
  // 実行してから記録する: 台帳が「発行された」と言うのにDBにユーザーがいない状態を作らない。
  let executed = null;
  let warehouseUrl = null;
  if ("execute" in args) {
    const connection = tenantAdminFromEnv();
    executed = (await executeStatements(connection, plan.ddl)).executed;
    warehouseUrl = connection.endpoint;
  }
  const { event, path } = await appendEvent(ledgerDir, {
    type: "TENANT_GRANTED",
    data: plan.ledgerData,
    privateKey: identity.privateKey,
  });
  // DDLはsalt付きハッシュを含むので、credential同様gitの外・所有者のみ読める形で置く。
  const ddlPath = resolve("artifacts", "tenant", `${plan.username}.grant.sql`);
  await writeSecretFile(ddlPath, `${plan.ddl.join(";\n\n")};\n`);
  const credentialPath = resolve("artifacts", "tenant", `${plan.username}.credential.json`);
  await writeSecretFile(credentialPath, `${JSON.stringify({
    schema: "alphagraph-tenant-credential-v1",
    username: plan.username,
    tenantDid: plan.ledgerData.tenantDid,
    password: plan.credential.password,
    validUntil: plan.ledgerData.validUntil,
    url: warehouseUrl,
    warning: "Local secret. Deliver out-of-band. It must never enter git or the ledger.",
  }, null, 2)}\n`);
  return {
    message: "Tenant grant recorded as TENANT_GRANTED. The credential stays local; the ledger holds no secret.",
    username: plan.username,
    tenantDid: plan.ledgerData.tenantDid,
    validUntil: plan.ledgerData.validUntil,
    seq: event.seq,
    ledgerEvent: path,
    ddl: ddlPath,
    credentials: credentialPath,
    executed,
  };
}

async function tenantRevoke(args) {
  if (!args.did || !args.identity) throw new Error("tenant-revoke requires --did DID and --identity PEM.");
  const identity = await loadIdentity(args.identity, identityPassphrase(args));
  const ledgerDir = resolve(args.ledger ?? "ledger");
  const username = tenantUsername(args.did);
  const active = latestTenantGrant(await readLedger(ledgerDir), username);
  if (!active) throw new Error(`No unrevoked TENANT_GRANTED event for ${username} is on the ledger.`);
  const ddl = buildTenantRevokeDdl(username);
  let executed = null;
  if ("execute" in args) executed = (await executeStatements(tenantAdminFromEnv(), ddl)).executed;
  const { event, path } = await appendEvent(ledgerDir, {
    type: "TENANT_REVOKED",
    data: buildTenantRevokeData({ did: args.did, reason: args.reason, grantSeq: active.seq }),
    privateKey: identity.privateKey,
  });
  return {
    message: "Tenant revoked and recorded as TENANT_REVOKED.",
    username,
    grantSeq: active.seq,
    seq: event.seq,
    ledgerEvent: path,
    executed,
  };
}

// 生データ公開レーン（無認証・再配布可）から取得したHL日次スナップショットを、
// 計算持ち込みレーンのWarehouseへ搭載する。来歴は dataset_provenance にも入れて
// テナント自身が csv_sha256 を突き合わせられるようにする。
async function tenantLoadHl(args) {
  for (const required of ["coin", "start", "end"]) {
    if (!args[required]) throw new Error(`tenant-load-hl requires --${required}.`);
  }
  const result = await fetchHyperliquidCandles({ coin: args.coin, interval: "1d", start: args.start, end: args.end });
  const provenance = result.provenance;
  const chTime = (iso) => iso.slice(0, 19).replace("T", " ");
  const rows = result.csv.trim().split("\n").slice(1).map((line) => {
    const [timestamp, open, high, low, close, volume] = line.split(",");
    return {
      coin: provenance.symbol,
      day: timestamp.slice(0, 10),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
      source: "hyperliquid-public-info-api",
      csv_sha256: provenance.csvSha256,
    };
  });
  const dataPath = resolve("artifacts", "tenant", `hl-${provenance.symbol.toLowerCase()}-1d.jsonl`);
  await mkdir(resolve(dataPath, ".."), { recursive: true });
  await writeFile(dataPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const provenancePath = `${dataPath}.source.json`;
  await writeJson(provenancePath, provenance);
  let inserted = null;
  if ("execute" in args) {
    const connection = tenantAdminFromEnv();
    inserted = (await insertJsonRows(connection, `${TENANT_DATABASE}.hl_candles_1d`, rows)).inserted;
    await insertJsonRows(connection, `${TENANT_DATABASE}.dataset_provenance`, [{
      dataset: "hl_candles_1d",
      coin: provenance.symbol,
      bar_interval: "1d",
      bars: provenance.received.bars,
      start_at: chTime(provenance.received.start),
      end_at: chTime(provenance.received.end),
      csv_sha256: provenance.csvSha256,
      fetched_at: chTime(provenance.fetchedAt),
      provenance_json: JSON.stringify(provenance),
    }]);
  }
  return {
    message: "Redistributable derived snapshot prepared from the public data lane. No credentials touched the fetch.",
    bars: rows.length,
    output: dataPath,
    provenance: provenancePath,
    sha256: provenance.csvSha256,
    inserted,
  };
}

async function tenantUsage(args) {
  if (!args.identity) throw new Error("tenant-usage requires --identity PEM.");
  const identity = await loadIdentity(args.identity, identityPassphrase(args));
  const date = args.date ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const connection = tenantAdminFromEnv();
  const rows = await queryJson(connection, buildUsageQuery(date));
  const data = buildUsageData({ date, rows, endpointHost: connection.host });
  const { event, path } = await appendEvent(resolve(args.ledger ?? "ledger"), {
    type: "USAGE_REPORTED",
    data,
    privateKey: identity.privateKey,
  });
  return {
    message: data.tenants.length
      ? "Per-tenant usage recorded as USAGE_REPORTED. Detection over prevention: anyone can read these numbers."
      : "No tenant queries on that day. The zero is recorded too; silence is also auditable.",
    date,
    tenants: data.tenants,
    seq: event.seq,
    ledgerEvent: path,
  };
}

// 「自分のDIDで一周」の締め: テナント資格情報で実サービスに当たり、
// 設計した遮断（#1811ゲート）が観測できることを確かめて報告書を残す。
async function tenantVerify(args) {
  if (!args.credentials) throw new Error("tenant-verify requires --credentials FILE (written by tenant-grant).");
  const credential = await readJson(args.credentials);
  if (credential.schema !== "alphagraph-tenant-credential-v1") throw new Error("Unsupported tenant credential schema.");
  const url = args.url ?? credential.url;
  if (!url) throw new Error("Pass --url; this credential file does not record the warehouse endpoint.");
  const connection = createTenantConnection({ url, username: credential.username, password: credential.password });
  const probes = [];
  for (const probe of tenantCheckProbes()) {
    const result = await runProbe(connection, probe.sql);
    const pass = result.observed === probe.expect
      && (!probe.expectBody || String(result.body).trim() === probe.expectBody);
    probes.push({ name: probe.name, expected: probe.expect, observed: result.observed, pass, error: result.error });
  }
  const allPassed = probes.every((probe) => probe.pass);
  const report = {
    schema: "alphagraph-tenant-check-v1",
    checkedAt: new Date().toISOString(),
    username: credential.username,
    tenantDid: credential.tenantDid ?? null,
    endpointHost: connection.host,
    allPassed,
    probes,
  };
  const output = resolve(args.output ?? defaultOutput("tenant-checks", credential.username, hashJson(report)));
  await writeJson(output, report);
  if (!allPassed) process.exitCode = 1;
  return {
    message: allPassed
      ? "Every gate probe behaved as designed. This report can be attested and cited."
      : "Tenant gate probes FAILED. Do not onboard anyone until every probe passes.",
    output,
    allPassed,
    probes,
  };
}

async function attest(args) {
  for (const required of ["artifact", "identity", "role", "verdict", "statement"]) {
    if (!args[required]) throw new Error(`attest requires --${required}.`);
  }
  const artifact = await readJson(args.artifact);
  const identity = await loadIdentity(args.identity, identityPassphrase(args));
  const attestation = createAttestation(artifact, {
    privateKey: identity.privateKey,
    role: args.role,
    verdict: args.verdict,
    statement: args.statement,
    technocoreRoom: args["technocore-room"],
    artifactUrl: args["artifact-url"],
  });
  const output = resolve(args.output ?? defaultOutput("attestations", basename(args.artifact, ".json"), attestation.artifact.sha256));
  await writeJson(output, attestation);
  return {
    message: attestation.technocore
      ? "Attestation signed; Technocore write is preview-only and has not been published."
      : "Attestation signed locally.",
    output,
    did: attestation.did,
    artifactHash: attestation.artifact.sha256,
    technocorePreview: attestation.technocore?.message ?? null,
  };
}

async function verify(args) {
  if (!args.artifact || !args.attestation) throw new Error("verify requires --artifact FILE and --attestation FILE.");
  const result = verifyAttestation(await readJson(args.attestation), await readJson(args.artifact));
  if (!result.valid) process.exitCode = 1;
  return { message: result.valid ? "Attestation is valid." : "Attestation is INVALID.", ...result };
}

async function dashboard(args) {
  const reports = resolve(args.reports ?? "artifacts/reports");
  const output = resolve(args.output ?? "site/index.html");
  const result = await buildDashboard(reports, output);
  return { message: "Static research dashboard built.", ...result };
}

async function publish(args) {
  if (!args.attestation) throw new Error("publish requires --attestation FILE.");
  if (args.confirm !== "PUBLISH") throw new Error("Publishing requires the exact flag --confirm PUBLISH.");
  const attestation = await readJson(args.attestation);
  const result = await publishTechnocoreAttestation(attestation);
  const receipt = {
    schema: "alphagraph-technocore-receipt-v1",
    publishedAt: new Date().toISOString(),
    did: attestation.did,
    artifact: attestation.artifact,
    technocore: attestation.technocore,
    response: result,
  };
  const output = resolve(args.output ?? defaultOutput("receipts", "technocore", attestation.artifact.sha256));
  await writeJson(output, receipt);
  return { message: "Signed proof published to Technocore.", output, status: result.status };
}

async function keygen(args) {
  if (!args.output) throw new Error("keygen requires --output PEM.");
  const passphrase = identityPassphrase(args);
  if (!passphrase) throw new Error("Set ALPHAGRAPH_PASSPHRASE or use --keychain-service to encrypt the new key.");
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({
    format: "pem",
    type: "pkcs8",
    cipher: "aes-256-cbc",
    passphrase,
  });
  const output = resolve(args.output);
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, pem, { encoding: "utf8", mode: 0o600 });
  const identity = await loadIdentity(output, passphrase);
  return {
    message: "New Ed25519 identity created. Keep the PEM and passphrase out of git.",
    output,
    did: identity.did,
  };
}

async function btAgent(args) {
  if (!args.room) throw new Error("bt-agent requires --room ROOM.");
  if (!args.identity) throw new Error("bt-agent requires --identity PEM.");
  const identity = await loadIdentity(args.identity, identityPassphrase(args));
  const options = {
    room: args.room,
    identity,
    statePath: resolve(args.state ?? "artifacts/bt-agent/state.json"),
    artifactsDir: resolve(args.artifacts ?? "artifacts/bt-agent"),
    log: (line) => process.stderr.write(`${line}\n`),
  };
  if ("once" in args || args._.includes("once")) {
    const result = await runAgentOnce(options);
    return { message: "bt-agent single pass completed.", did: identity.did, ...result };
  }
  await watchAgent(options);
  return { message: "bt-agent watch loop exited." };
}

async function demo() {
  const data = await demoData({ output: "data/btcusdt-1h-synthetic.csv", bars: "2400" });
  const proposal = await propose({ strategy: "examples/btc-sma-cross.json" });
  const report = await backtest({ proposal: proposal.output, data: data.output });
  const site = await dashboard({});
  return {
    message: "Local paper-research demo completed. Synthetic results have no market significance.",
    proposal: proposal.output,
    report: report.output,
    dashboard: site.outputPath,
  };
}

export async function runCli(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { raw: HELP };
  }
  const args = parseArgs(rest);
  if (command === "propose") return propose(args);
  if (command === "demo-data") return demoData(args);
  if (command === "fetch-binance") return fetchBinance(args);
  if (command === "backtest") return backtest(args);
  if (command === "reproduce") return reproduce(args);
  if (command === "seal") return seal(args);
  if (command === "reveal") return reveal(args);
  if (command === "ledger-verify") return ledgerVerify(args);
  if (command === "citations") return citations(args);
  if (command === "site") return site(args);
  if (command === "eval-intake") return evalIntake(args);
  if (command === "hl-universe") return hlUniverse(args);
  if (command === "fetch-hl") return fetchHl(args);
  if (command === "tenant-init") return tenantInit(args);
  if (command === "tenant-grant") return tenantGrant(args);
  if (command === "tenant-revoke") return tenantRevoke(args);
  if (command === "tenant-load-hl") return tenantLoadHl(args);
  if (command === "tenant-usage") return tenantUsage(args);
  if (command === "tenant-verify") return tenantVerify(args);
  if (command === "attest") return attest(args);
  if (command === "verify") return verify(args);
  if (command === "dashboard") return dashboard(args);
  if (command === "publish") return publish(args);
  if (command === "keygen") return keygen(args);
  if (command === "bt-agent") return btAgent(args);
  if (command === "demo") return demo(args);
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

export function printResult(result) {
  if (result.raw) {
    process.stdout.write(result.raw);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
