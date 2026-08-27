import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { hashJson, readJson, stableStringify, sha256, writeJson } from "./core.mjs";
import { didFromPrivateKey, publicKeyFromDid, signText } from "./did.mjs";
import { verify as cryptoVerify } from "node:crypto";

// 透明性ログ（docs/ledger-design.md 部品1）。書き手は運営一人だが、
// 改竄・遅延・削除は誰にでも検出可能。信頼モデルは「防止でなく検出」。
export const LEDGER_EVENT_TYPES = new Set([
  "PAPER_SEALED",
  "INTAKE_REJECTED",
  "PAPER_REVEALED",
  "REPRODUCTION_RECORDED",
  "EVALUATION_SIGNED",
  "SERIES_REGISTERED",
  "PAYOUT",
  "TENANT_GRANTED",
  "TENANT_REVOKED",
  "USAGE_REPORTED",
]);

const GENESIS_PREV_HASH = "0".repeat(64);

function canonicalEvent(event) {
  return [
    "alphagraph-ledger-v1",
    event.seq,
    event.at,
    event.type,
    hashJson(event.data),
    event.prevHash,
  ].join("|");
}

export function buildEvent({ seq, at, type, data, prevHash, privateKey }) {
  if (!LEDGER_EVENT_TYPES.has(type)) throw new Error(`Unknown ledger event type: ${type}`);
  if (!Number.isInteger(seq) || seq < 1) throw new Error("Ledger seq must be a positive integer.");
  const base = { schema: "alphagraph-ledger-event-v1", seq, at, type, data, prevHash };
  const canonical = canonicalEvent(base);
  const event = {
    ...base,
    authorDid: didFromPrivateKey(privateKey),
    canonical,
    signature: signText(privateKey, canonical),
  };
  return { ...event, hash: sha256(stableStringify(event)) };
}

export function verifyEvent(event) {
  const { hash, ...rest } = event;
  const problems = [];
  if (sha256(stableStringify(rest)) !== hash) problems.push("hash");
  if (canonicalEvent(event) !== event.canonical) problems.push("canonical");
  try {
    const valid = cryptoVerify(
      null,
      Buffer.from(event.canonical, "utf8"),
      publicKeyFromDid(event.authorDid),
      Buffer.from(event.signature, "base64url"),
    );
    if (!valid) problems.push("signature");
  } catch {
    problems.push("signature");
  }
  return { valid: problems.length === 0, problems };
}

// 連鎖の連続性・全署名を一括検査（docs/ledger-design.md 部品5の最小版）。
export function verifyChain(events) {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const problems = [];
  let previousHash = GENESIS_PREV_HASH;
  ordered.forEach((event, index) => {
    if (event.seq !== index + 1) problems.push({ seq: event.seq, problem: "seq-gap" });
    if (event.prevHash !== previousHash) problems.push({ seq: event.seq, problem: "broken-link" });
    const result = verifyEvent(event);
    if (!result.valid) problems.push({ seq: event.seq, problem: result.problems.join(",") });
    previousHash = event.hash;
  });
  return { valid: problems.length === 0, events: ordered.length, headHash: previousHash, problems };
}

function eventFileName(event) {
  return `${String(event.seq).padStart(6, "0")}-${event.hash.slice(0, 12)}.json`;
}

export async function readLedger(directory) {
  const eventsDir = resolve(directory, "events");
  if (!existsSync(eventsDir)) return [];
  const files = (await readdir(eventsDir)).filter((name) => name.endsWith(".json")).sort();
  const events = [];
  for (const file of files) events.push(await readJson(resolve(eventsDir, file)));
  return events.sort((a, b) => a.seq - b.seq);
}

// 追記のみ。既存イベントは書き換えない（同じseqのファイルがあれば拒否）。
export async function appendEvent(directory, { type, data, privateKey, at }) {
  const events = await readLedger(directory);
  const head = events.at(-1);
  const event = buildEvent({
    seq: (head?.seq ?? 0) + 1,
    at: at ?? new Date().toISOString(),
    type,
    data,
    prevHash: head?.hash ?? GENESIS_PREV_HASH,
    privateKey,
  });
  const path = resolve(directory, "events", eventFileName(event));
  if (existsSync(path)) throw new Error(`Ledger event already exists: ${path}`);
  await writeJson(path, event);
  await writeJson(resolve(directory, "head.json"), {
    schema: "alphagraph-ledger-head-v1",
    seq: event.seq,
    hash: event.hash,
    type: event.type,
    at: event.at,
  });
  return { event, path };
}
