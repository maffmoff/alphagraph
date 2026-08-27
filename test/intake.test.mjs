import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashJson } from "../src/core.mjs";
import { didFromPrivateKey } from "../src/did.mjs";
import { appendEvent, readLedger, verifyChain } from "../src/ledger.mjs";
import { buildSite } from "../src/site.mjs";
import {
  INTAKE_CONTRACT,
  INTAKE_CONTRACT_HASH,
  buildSealRequest,
  decideSealRequest,
  rejectedEventData,
  sealedEventData,
} from "../src/intake.mjs";

const hash = (character) => character.repeat(64);

const paper = (id) => ({
  schema: "alphagraph-paper-v1",
  type: "empirical",
  id,
  title: "Intake test paper",
  claim: "A claim sealed before the result is known.",
  mechanism: "Why it should hold.",
  whoPays: "Who is on the other side.",
  verification: {
    data: [{ seriesId: "hl:BTC:1d", sha256: hash("a"), source: "public API", redistributable: true }],
    method: "Run the analysis code.",
    successCriteria: "Positive rank correlation.",
    costs: "Compute only.",
  },
  citations: [],
  disclosure: { policy: "immediate" },
});

const key = () => generateKeyPairSync("ed25519").privateKey;

test("a well-formed request from an unknown DID is accepted", () => {
  const request = buildSealRequest(paper("ag-e-intake"), key());
  const decision = decideSealRequest([], request);
  assert.equal(decision.accept, true);
  assert.equal(decision.contractHash, INTAKE_CONTRACT_HASH);
});

test("tampering with either the signature or the commitment fails the same check", () => {
  const request = buildSealRequest(paper("ag-e-intake"), key());
  assert.equal(decideSealRequest([], { ...request, signature: request.signature.replace(/^./, "A") }).reason, "bad-signature");
  // commitmentを差し替えるとcanonicalと食い違う（署名は元のcommitmentに対するもの）。
  const swapped = { ...request, commitment: { ...request.commitment, id: "ag-e-other" } };
  assert.equal(decideSealRequest([], swapped).reason, "bad-signature");
  // 別人のDIDを名乗っても通らない。
  assert.equal(decideSealRequest([], { ...request, authorDid: didFromPrivateKey(key()) }).reason, "bad-signature");
});

test("malformed requests are refused before any signature work", () => {
  assert.equal(decideSealRequest([], null).reason, "bad-schema");
  assert.equal(decideSealRequest([], { schema: "something-else" }).reason, "bad-schema");
  const request = buildSealRequest(paper("ag-e-intake"), key());
  assert.equal(decideSealRequest([], { ...request, authorDid: "alice" }).reason, "bad-schema");
});

test("the same paper cannot be sealed twice", () => {
  const request = buildSealRequest(paper("ag-e-intake"), key());
  const ledger = [{ type: "PAPER_SEALED", at: "2026-08-27T00:00:00.000Z", data: sealedEventData(request) }];
  assert.equal(decideSealRequest(ledger, request).reason, "duplicate-paper");
});

test("one DID may seal up to the contract limit inside the window, not beyond", () => {
  const privateKey = key();
  const did = didFromPrivateKey(privateKey);
  const { maxSealsPerWindow, windowHours } = INTAKE_CONTRACT.rateLimit;
  const now = Date.parse("2026-08-27T12:00:00.000Z");
  const at = (hoursAgo) => new Date(now - (hoursAgo * 3_600_000)).toISOString();

  const inWindow = Array.from({ length: maxSealsPerWindow - 1 }, (_, index) => ({
    type: "PAPER_SEALED",
    at: at(1),
    data: { paperHash: hash(String(index % 10)), authorDid: did },
  }));
  const request = buildSealRequest(paper("ag-e-intake"), privateKey);
  assert.equal(decideSealRequest(inWindow, request, now).accept, true, "上限の1本手前は通る");

  const atLimit = [...inWindow, { type: "PAPER_SEALED", at: at(2), data: { paperHash: hash("e"), authorDid: did } }];
  assert.equal(decideSealRequest(atLimit, request, now).reason, "rate-limited");

  // 窓の外の封緘は数えない。
  const aged = atLimit.map((event) => ({ ...event, at: at(windowHours + 1) }));
  assert.equal(decideSealRequest(aged, request, now).accept, true);

  // 制限は著者ごと。別人は影響を受けない。
  const other = buildSealRequest(paper("ag-e-other"), key());
  assert.equal(decideSealRequest(atLimit, other, now).accept, true);
});

test("the contract is hash-pinned so a quiet limit change is visible", () => {
  assert.equal(INTAKE_CONTRACT_HASH.length, 64);
  assert.equal(hashJson(INTAKE_CONTRACT), INTAKE_CONTRACT_HASH);
  const loosened = { ...INTAKE_CONTRACT, rateLimit: { ...INTAKE_CONTRACT.rateLimit, maxSealsPerWindow: 1000 } };
  assert.notEqual(hashJson(loosened), INTAKE_CONTRACT_HASH);
});

test("rejections land on the ledger, so silence is distinguishable from refusal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphagraph-intake-"));
  const output = await mkdtemp(join(tmpdir(), "alphagraph-intake-site-"));
  try {
    const operatorKey = key();
    const authorKey = key();
    const request = buildSealRequest(paper("ag-e-intake"), authorKey);

    await appendEvent(directory, { type: "PAPER_SEALED", data: sealedEventData(request), privateKey: operatorKey });
    const repeat = decideSealRequest(await readLedger(directory), request);
    assert.equal(repeat.accept, false);
    await appendEvent(directory, {
      type: "INTAKE_REJECTED",
      data: rejectedEventData(request, repeat),
      privateKey: operatorKey,
    });

    const events = await readLedger(directory);
    assert.equal(verifyChain(events).valid, true);
    const rejection = events.find((event) => event.type === "INTAKE_REJECTED");
    // 拒絶の記録は、何を・誰が出したかと理由を残す。中身は残さない。
    assert.equal(rejection.data.reason, "duplicate-paper");
    assert.equal(rejection.data.requestHash, hashJson(request));
    assert.equal(rejection.data.authorDid, didFromPrivateKey(authorKey));
    assert.equal(rejection.data.contractHash, INTAKE_CONTRACT_HASH);

    const site = await buildSite(directory, output);
    assert.equal(site.metrics.rejected, 1);
    assert.equal(site.metrics.papers, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});
