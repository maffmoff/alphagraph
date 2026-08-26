import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hashJson } from "./core.mjs";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED25519_MULTICODEC = Buffer.from([0xed, 0x01]);
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ROOM_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;

function base58Encode(input) {
  const bytes = Buffer.from(input);
  let value = BigInt(`0x${bytes.toString("hex") || "0"}`);
  let output = "";
  while (value > 0n) {
    output = BASE58[Number(value % 58n)] + output;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    output = `1${output}`;
  }
  return output || "1";
}

function base58Decode(input) {
  let value = 0n;
  for (const character of String(input)) {
    const index = BASE58.indexOf(character);
    if (index < 0) throw new Error(`Invalid base58 character: ${character}`);
    value = (value * 58n) + BigInt(index);
  }
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let output = value === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let zeroes = 0;
  for (const character of String(input)) {
    if (character !== "1") break;
    zeroes += 1;
  }
  if (zeroes) output = Buffer.concat([Buffer.alloc(zeroes), output]);
  return output;
}

export function didFromPrivateKey(privateKey) {
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) throw new Error("Expected an Ed25519 key.");
  return `did:key:z${base58Encode(Buffer.concat([ED25519_MULTICODEC, Buffer.from(jwk.x, "base64url")]))}`;
}

export function publicKeyFromDid(did) {
  if (!String(did).startsWith("did:key:z")) throw new Error("Only did:key:z Ed25519 identifiers are supported.");
  const decoded = base58Decode(String(did).slice("did:key:z".length));
  if (decoded.length !== 34 || !decoded.subarray(0, 2).equals(ED25519_MULTICODEC)) {
    throw new Error("DID is not an Ed25519 did:key.");
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, decoded.subarray(2)]),
    format: "der",
    type: "spki",
  });
}

function cleanSingleLine(value, limit = 4096) {
  const cleaned = String(value).replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\u2028\u2029]/gu, " ").trim();
  if (!cleaned) throw new Error("Signed text is empty.");
  if (cleaned.length > limit) throw new Error(`Signed text exceeds ${limit} characters.`);
  return cleaned;
}

export function signText(privateKey, text) {
  return cryptoSign(null, Buffer.from(text, "utf8"), privateKey).toString("base64url");
}

export async function loadIdentity(path, passphrase) {
  if (!passphrase) throw new Error("No identity passphrase was provided.");
  const pem = await readFile(path, "utf8");
  const privateKey = createPrivateKey({ key: pem, format: "pem", passphrase });
  return { privateKey, did: didFromPrivateKey(privateKey) };
}

export function passphraseFromKeychain(service, account) {
  if (process.platform !== "darwin") throw new Error("macOS Keychain lookup is available only on macOS.");
  if (!service) throw new Error("Keychain service is required.");
  const args = ["find-generic-password", "-s", service];
  if (account) args.push("-a", account);
  args.push("-w");
  try {
    return execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .replace(/\r?\n$/, "");
  } catch {
    throw new Error("Passphrase was not found in macOS Keychain for the requested service/account.");
  }
}

export function createAttestation(artifact, options) {
  const artifactHash = hashJson(artifact);
  const role = cleanSingleLine(options.role, 40).toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(role)) throw new Error("Attestation role has an invalid format.");
  const verdict = cleanSingleLine(options.verdict, 20).toLowerCase();
  if (!new Set(["proposed", "reproduced", "challenged", "forward-tested"]).has(verdict)) {
    throw new Error("Verdict must be proposed, reproduced, challenged, or forward-tested.");
  }
  const statement = cleanSingleLine(options.statement, 500);
  const canonical = `alphagraph-attestation-v1|${artifactHash}|${role}|${verdict}|${statement}`;
  const did = didFromPrivateKey(options.privateKey);
  const signature = signText(options.privateKey, canonical);
  const attestation = {
    schema: "alphagraph-attestation-v1",
    createdAt: new Date().toISOString(),
    did,
    artifact: {
      schema: artifact.schema ?? "unknown",
      sha256: artifactHash,
    },
    role,
    verdict,
    statement,
    canonical,
    signature,
  };

  if (options.technocoreRoom) {
    const room = String(options.technocoreRoom).toLowerCase();
    if (!ROOM_NAME.test(room)) throw new Error("Technocore room name is invalid.");
    const nonce = String(options.nonce ?? Date.now());
    if (!/^\d{1,19}$/.test(nonce)) throw new Error("Technocore nonce must contain 1-19 digits.");
    const publicUrl = options.artifactUrl ? new URL(options.artifactUrl).toString() : "unpublished";
    const message = cleanSingleLine([
      "alphagraph-proof-v1",
      `artifact:${artifactHash}`,
      `role:${role}`,
      `verdict:${verdict}`,
      `source:${publicUrl}`,
    ].join(" "));
    const roomCanonical = `${room}|${nonce}|${message}`;
    const roomSignature = signText(options.privateKey, roomCanonical);
    const parts = [room, "say-signed", did, roomSignature, nonce, message].map(encodeURIComponent);
    attestation.technocore = {
      room,
      nonce,
      message,
      canonical: roomCanonical,
      writeUrl: `https://technocore.chat/r/${parts.join("/")}`,
      published: false,
    };
  }
  return attestation;
}

export function verifyAttestation(attestation, artifact) {
  if (attestation?.schema !== "alphagraph-attestation-v1") throw new Error("Unsupported attestation schema.");
  const artifactHash = hashJson(artifact);
  const canonical = `alphagraph-attestation-v1|${artifactHash}|${attestation.role}|${attestation.verdict}|${attestation.statement}`;
  const valid = artifactHash === attestation.artifact?.sha256
    && canonical === attestation.canonical
    && cryptoVerify(
      null,
      Buffer.from(canonical, "utf8"),
      publicKeyFromDid(attestation.did),
      Buffer.from(attestation.signature, "base64url"),
    );
  return { valid, artifactHash, did: attestation.did };
}

export async function publishTechnocoreAttestation(attestation, fetchImpl = fetch) {
  const writeUrl = attestation?.technocore?.writeUrl;
  if (!writeUrl || new URL(writeUrl).origin !== "https://technocore.chat") {
    throw new Error("Attestation does not contain a valid Technocore write preview.");
  }
  const response = await fetchImpl(writeUrl, { redirect: "error" });
  const body = await response.text();
  if (!response.ok) throw new Error(`Technocore returned HTTP ${response.status}: ${body}`);
  return { ok: true, status: response.status, body };
}
