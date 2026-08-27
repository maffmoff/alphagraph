import assert from "node:assert/strict";
import test from "node:test";
import { parseEvalMessage, selectNewEvaluations } from "../src/eval-intake.mjs";

const hash = (character) => character.repeat(64);
const DID = "did:key:z6MkExampleEvaluatorDid";

const signed = (text, overrides = {}) => ({ seq: 10, ts: "2026-08-27T00:00:00Z", from: DID, text, room: "general", ...overrides });

test("parses the eval grammar only from signed messages", () => {
  const ok = parseEvalMessage(signed(`alphagraph-eval-v1 paper:${hash("a")} verdict:reproduced matched on my machine`));
  assert.equal(ok.paperHash, hash("a"));
  assert.equal(ok.verdict, "reproduced");
  assert.equal(ok.statement, "matched on my machine");
  assert.equal(ok.attestation, "server-attested");
  // 無署名（fromがニックネーム）は拾わない。署名の証跡が無い発言は評価にならない。
  assert.equal(parseEvalMessage(signed(`alphagraph-eval-v1 paper:${hash("a")} verdict:reproduced`, { from: "alice" })), null);
  assert.equal(parseEvalMessage(signed("hello world")), null);
  assert.equal(parseEvalMessage(signed(`alphagraph-eval-v1 paper:${hash("a")} verdict:awesome`)), null);
});

test("keeps only evaluations of sealed papers and dedupes by evaluator+paper+verdict", () => {
  const ledger = [
    { type: "PAPER_SEALED", data: { paperHash: hash("a") } },
    { type: "EVALUATION_SIGNED", data: { evaluatorDid: DID, paperHash: hash("a"), verdict: "risk" } },
  ];
  const messages = [
    signed(`alphagraph-eval-v1 paper:${hash("a")} verdict:reproduced first`),
    // 連投は数を作らない
    signed(`alphagraph-eval-v1 paper:${hash("a")} verdict:reproduced again`, { seq: 11 }),
    // 既に台帳にある verdict は再取り込みしない
    signed(`alphagraph-eval-v1 paper:${hash("a")} verdict:risk repeat`, { seq: 12 }),
    // 台帳に無い論文は評価できない
    signed(`alphagraph-eval-v1 paper:${hash("f")} verdict:comment ghost`, { seq: 13 }),
  ];
  const fresh = selectNewEvaluations(ledger, messages);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].statement, "first");
});
