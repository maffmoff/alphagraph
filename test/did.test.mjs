import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  createAttestation,
  didFromPrivateKey,
  publishTechnocoreAttestation,
  verifyAttestation,
} from "../src/did.mjs";

const artifact = {
  schema: "alphagraph-backtest-v1",
  strategyHash: "abc123",
  metrics: { outOfSample: { netReturnPct: 1.5 } },
};

test("signs and verifies an artifact with an Ed25519 did:key", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const attestation = createAttestation(artifact, {
    privateKey,
    role: "reproducer",
    verdict: "reproduced",
    statement: "Independent deterministic reproduction.",
    technocoreRoom: "alphagraph-lab",
    artifactUrl: "https://example.com/report.json",
    nonce: "1700000000000",
  });
  assert.equal(attestation.did, didFromPrivateKey(privateKey));
  assert.match(attestation.did, /^did:key:z6Mk/);
  assert.equal(verifyAttestation(attestation, artifact).valid, true);
  assert.match(attestation.technocore.writeUrl, /^https:\/\/technocore\.chat\/r\/alphagraph-lab\/say-signed\//);
});

test("detects artifact and statement tampering", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const attestation = createAttestation(artifact, {
    privateKey,
    role: "challenger",
    verdict: "challenged",
    statement: "Cost assumptions are incomplete.",
  });
  assert.equal(verifyAttestation(attestation, { ...artifact, strategyHash: "changed" }).valid, false);
  assert.equal(verifyAttestation({ ...attestation, statement: "Everything is fine." }, artifact).valid, false);
});

test("publishes only the prebuilt Technocore URL and surfaces failures", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const attestation = createAttestation(artifact, {
    privateKey,
    role: "proposer",
    verdict: "proposed",
    statement: "Locked before evaluation.",
    technocoreRoom: "alphagraph-lab",
  });
  let requested;
  const success = await publishTechnocoreAttestation(attestation, async (url) => {
    requested = url;
    return new Response("ok", { status: 200 });
  });
  assert.equal(requested, attestation.technocore.writeUrl);
  assert.equal(success.ok, true);
  await assert.rejects(
    publishTechnocoreAttestation(attestation, async () => new Response("rate limited", { status: 429 })),
    /HTTP 429/,
  );
});

test("a write that landed without a response is confirmed by reading back, not resent", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const attestation = createAttestation(artifact, {
    privateKey,
    role: "proposer",
    verdict: "proposed",
    statement: "Locked before evaluation.",
    technocoreRoom: "alphagraph-lab",
  });
  let writes = 0;
  const result = await publishTechnocoreAttestation(attestation, async (url) => {
    const target = String(url);
    if (target.includes("/say-signed/")) {
      writes += 1;
      throw new Error("socket hang up");
    }
    return new Response(JSON.stringify({
      room: "alphagraph-lab",
      messages: [{ seq: 1, from: attestation.did, text: attestation.technocore.message }],
    }), { status: 200 });
  });
  assert.equal(result.ok, true);
  assert.equal(result.confirmed, true);
  // 単回限りの署名URLを再送していないこと。
  assert.equal(writes, 1);
});

test("a write that truly failed still throws after the read-back finds nothing", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const attestation = createAttestation(artifact, {
    privateKey,
    role: "proposer",
    verdict: "proposed",
    statement: "Locked before evaluation.",
    technocoreRoom: "alphagraph-lab",
  });
  await assert.rejects(
    publishTechnocoreAttestation(attestation, async (url) => (
      String(url).includes("/say-signed/")
        ? new Response("boom", { status: 500 })
        : new Response(JSON.stringify({ room: "alphagraph-lab", messages: [] }), { status: 200 })
    )),
    /HTTP 500/,
  );
});
