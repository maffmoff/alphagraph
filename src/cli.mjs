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
import { citationLedger, sealPaper } from "./paper.mjs";
import { appendEvent, readLedger, verifyChain } from "./ledger.mjs";
import { fetchHyperliquidCandles, fetchHyperliquidUniverse } from "./data-source.mjs";

const HELP = `AlphaGraph — Proof of Useful Strategy

Usage:
  alphagraph propose --strategy FILE [--output FILE]
  alphagraph demo-data [--output FILE] [--bars NUMBER]
  alphagraph fetch-binance --symbol SYMBOL --interval INTERVAL --start ISO --end ISO [--output FILE]
  alphagraph backtest --proposal FILE --data CSV [--output FILE]
  alphagraph reproduce --report FILE --data CSV [--output FILE]
  alphagraph seal --paper FILE --identity PEM [--ledger DIR] [--output FILE]
  alphagraph ledger-verify [--ledger DIR]
  alphagraph citations [--ledger DIR]
  alphagraph hl-universe [--output FILE]
  alphagraph fetch-hl --coin COIN --interval INTERVAL --start ISO --end ISO [--output FILE]
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

Safety:
  Backtests and the dashboard are research artifacts, not trading instructions.
  Technocore is written only by the publish command with --confirm PUBLISH.
`;

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      result._.push(argument);
      continue;
    }
    const key = argument.slice(2);
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
  if (!comparison.reproduced) process.exitCode = 1;
  return {
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
  return {
    message: "Paper sealed. Only the commitment is on the ledger; the full text stays local until reveal.",
    output,
    ledgerEvent: path,
    paperHash: sealed.paperHash,
    did: identity.did,
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
  if (command === "ledger-verify") return ledgerVerify(args);
  if (command === "citations") return citations(args);
  if (command === "hl-universe") return hlUniverse(args);
  if (command === "fetch-hl") return fetchHl(args);
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
