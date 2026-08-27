import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { hashJson } from "../src/core.mjs";
import { CITATION_KINDS, citationLedger, sealPaper, validatePaper, verifyReveal } from "../src/paper.mjs";
import { appendEvent, buildEvent, readLedger, verifyChain, verifyEvent } from "../src/ledger.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hash = (character) => character.repeat(64);

const base = {
  schema: "alphagraph-paper-v1",
  type: "empirical",
  id: "ag-e-test",
  title: "Test paper",
  claim: "A claim sealed before the result is known.",
  mechanism: "Why it should hold, derived from participant constraints.",
  whoPays: "Who is on the other side of the edge.",
  verification: {
    data: [{ seriesId: "hl:BTC:1d", sha256: hash("a"), source: "Hyperliquid public info API", redistributable: true }],
    method: "Run the analysis code and emit one deterministic JSON.",
    successCriteria: "Positive rank correlation on every series.",
    costs: "Compute only.",
  },
  citations: [],
  disclosure: { policy: "immediate" },
};

test("a paper package is deterministic and carries no timestamp", () => {
  const first = validatePaper(base);
  const second = validatePaper({ ...base });
  assert.equal(hashJson(first), hashJson(second));
  assert.equal(JSON.stringify(first).includes("createdAt"), false);
});

test("the commitment discloses no claim, mechanism or method", () => {
  const sealed = sealPaper({ ...base, disclosure: { policy: "embargo", embargoDays: 90 } });
  const published = JSON.stringify(sealed.commitment);
  assert.ok(!published.includes(base.claim));
  assert.ok(!published.includes(base.mechanism));
  assert.ok(!published.includes(base.whoPays));
  assert.ok(!published.includes(base.verification.method));
  assert.equal(sealed.commitment.paperHash, sealed.paperHash);
  assert.deepEqual(sealed.commitment.disclosure, { policy: "embargo", embargoDays: 90 });
});

test("an embargoed commitment hides citation notes but keeps the lineage", () => {
  const citations = [{ kind: "depends-on", paperHash: hash("b"), note: "the mechanism this quietly leaks" }];
  const embargoed = sealPaper({ ...base, citations, disclosure: { policy: "embargo", embargoDays: 90 } });
  assert.equal(JSON.stringify(embargoed.commitment).includes("quietly leaks"), false);
  assert.deepEqual(embargoed.commitment.citations, [{ kind: "depends-on", paperHash: hash("b") }]);
  // 即時公開の論文はnoteを残す（伏せる理由がない）。
  const open = sealPaper({ ...base, citations });
  assert.equal(open.commitment.citations[0].note, "the mechanism this quietly leaks");
  // noteを伏せても論文ハッシュは変わらない（reveal時に一致する）。
  assert.equal(embargoed.paperHash, sealPaper({ ...base, citations, disclosure: { policy: "embargo", embargoDays: 90 } }).paperHash);
});

test("reveal is accepted only when it hashes to the commitment", () => {
  const sealed = sealPaper(base);
  assert.equal(verifyReveal(base, sealed.paperHash).valid, true);
  assert.equal(verifyReveal({ ...base, claim: "A quietly edited claim." }, sealed.paperHash).valid, false);
});

test("a refutation paper must name its target", () => {
  const refutation = { ...base, type: "refutation", id: "ag-r-test", citations: [] };
  assert.throws(() => validatePaper(refutation), /must cite its target/);
  const named = validatePaper({ ...refutation, citations: [{ kind: "refutes", paperHash: hash("b") }] });
  assert.equal(named.citations[0].kind, "refutes");
});

test("citation kinds carry a sign so unsigned totals are impossible", () => {
  assert.equal(CITATION_KINDS.get("builds-on").sign, 1);
  assert.equal(CITATION_KINDS.get("refutes").sign, -1);
  assert.equal(CITATION_KINDS.get("depends-on").sign, 0);
  assert.throws(() => validatePaper({ ...base, citations: [{ kind: "cites", paperHash: hash("b") }] }), /kind must be one of/);
});

test("the citation graph counts each kind separately", () => {
  const target = sealPaper(base);
  const supporter = sealPaper({ ...base, id: "ag-e-two", citations: [{ kind: "builds-on", paperHash: target.paperHash }] });
  const attacker = sealPaper({ ...base, type: "refutation", id: "ag-r-two", citations: [{ kind: "refutes", paperHash: target.paperHash }] });
  const graph = citationLedger([target.commitment, supporter.commitment, attacker.commitment]);
  const node = graph.find((entry) => entry.paperHash === target.paperHash);
  assert.deepEqual(node.counts, { "builds-on": 1, refutes: 1 });
});

test("non-redistributable series are marked, not silently accepted as reproducible", () => {
  const paper = validatePaper({
    ...base,
    verification: {
      ...base.verification,
      data: [{ seriesId: "vendor:equities", sha256: hash("c"), source: "licensed vendor", license: "no redistribution" }],
    },
  });
  assert.equal(paper.verification.data[0].redistributable, false);
});

test("the ledger chain links, signs and detects tampering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphagraph-ledger-"));
  try {
    const { privateKey } = generateKeyPairSync("ed25519");
    const sealed = sealPaper(base);
    const first = await appendEvent(directory, { type: "PAPER_SEALED", data: sealed.commitment, privateKey });
    const second = await appendEvent(directory, { type: "PAPER_REVEALED", data: { paperHash: sealed.paperHash }, privateKey });
    assert.equal(second.event.prevHash, first.event.hash);

    const events = await readLedger(directory);
    assert.equal(verifyChain(events).valid, true);
    assert.equal(verifyEvent(events[0]).valid, true);

    const tampered = structuredClone(events[0]);
    tampered.data.disclosure = { policy: "embargo", embargoDays: 365 };
    assert.equal(verifyEvent(tampered).valid, false);
    assert.equal(verifyChain([tampered, events[1]]).valid, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unknown event type is refused", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  assert.throws(
    () => buildEvent({ seq: 1, at: "2026-01-01T00:00:00.000Z", type: "MINT_TOKENS", data: {}, prevHash: hash("0"), privateKey }),
    /Unknown ledger event type/,
  );
});

test("reveal is only meaningful against a seal; the seal is what makes early edits impossible", () => {
  const sealed = sealPaper(base);
  // 猶予期間中の論文も、封緘したハッシュと一致すれば全文は受け付けられる（早期公開は著者の権利）。
  const embargoed = sealPaper({ ...base, disclosure: { policy: "embargo", embargoDays: 90 } });
  assert.equal(verifyReveal({ ...base, disclosure: { policy: "embargo", embargoDays: 90 } }, embargoed.paperHash).valid, true);
  // 猶予期間の長さを後から縮めた全文は別物になる。
  assert.equal(verifyReveal({ ...base, disclosure: { policy: "embargo", embargoDays: 30 } }, embargoed.paperHash).valid, false);
  // 主張を後から足した全文も別物になる。
  assert.equal(verifyReveal({ ...base, claim: `${base.claim} 追記。` }, sealed.paperHash).valid, false);
});
