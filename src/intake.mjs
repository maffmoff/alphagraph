import { verify as cryptoVerify } from "node:crypto";
import { assertPlainObject, hashJson } from "./core.mjs";
import { didFromPrivateKey, publicKeyFromDid, signText } from "./did.mjs";
import { sealPaper } from "./paper.mjs";

// 取込口の判定契約（docs/ledger-design.md 部品2）。
// 台帳の書き手は運営一人であり、運営に残る唯一の裁量は「載せるか黙殺するか」だった。
// 判定規則をここに宣言的に置き、契約自体をハッシュ固定して公開することで、
// 運営の行動は「公開コードを入力に適用した結果」と突き合わせて検証できるようになる。
// 受理だけでなく拒絶も台帳イベントにするので、黙殺は「受理も拒絶も記録が無い」という
// 形で立証可能になる（参加者側のTechnocore自己投稿が提出時刻の傍証になる）。
//
// 制限値の変更は契約ハッシュの変更として現れる。repro契約（src/repro.mjs）と同じ規律で、
// 定義権が運営に残ることを消すのではなく検出可能にする。
export const INTAKE_CONTRACT = {
  schema: "alphagraph-intake-contract-v1",
  requestSchema: "alphagraph-seal-request-v1",
  checks: [
    { reason: "bad-schema", rule: "リクエストのschemaが一致し、commitmentを持つこと" },
    { reason: "bad-signature", rule: "commitmentのハッシュに対する著者DIDのEd25519署名が成立すること" },
    { reason: "duplicate-paper", rule: "同じpaperHashのPAPER_SEALEDが台帳に無いこと" },
    { reason: "rate-limited", rule: "同一著者DIDの封緘が直近windowHours以内にmaxSealsPerWindow未満であること" },
  ],
  // fable-concept §5「計算枠はDIDごとのレート制限」の封緘側。未決11への回答。
  rateLimit: { maxSealsPerWindow: 20, windowHours: 24 },
  note: "判定は純関数。運営はこの契約を実行するだけで、内容による選別はできない（封緘時に見えるのはハッシュのみ）。",
};

export const INTAKE_CONTRACT_HASH = hashJson(INTAKE_CONTRACT);

const canonicalFor = (commitment) => `${INTAKE_CONTRACT.requestSchema}|${hashJson(commitment)}`;

// 参加者側。台帳には触らず、署名済みリクエストを組み立てるだけ。
export function buildSealRequest(paper, privateKey) {
  const { commitment } = sealPaper(paper);
  const canonical = canonicalFor(commitment);
  return {
    schema: INTAKE_CONTRACT.requestSchema,
    commitment,
    authorDid: didFromPrivateKey(privateKey),
    contractHash: INTAKE_CONTRACT_HASH,
    canonical,
    signature: signText(privateKey, canonical),
  };
}

function signatureHolds(request) {
  try {
    if (request.canonical !== canonicalFor(request.commitment)) return false;
    return cryptoVerify(
      null,
      Buffer.from(request.canonical, "utf8"),
      publicKeyFromDid(request.authorDid),
      Buffer.from(request.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

// 運営側の判定。純関数——同じ台帳と同じリクエストからは誰が実行しても同じ結論が出る。
export function decideSealRequest(ledgerEvents, request, nowMs = Date.now()) {
  const reject = (reason, detail) => ({ accept: false, reason, detail, contractHash: INTAKE_CONTRACT_HASH });
  try {
    assertPlainObject(request, "Seal request");
  } catch {
    return reject("bad-schema", "リクエストがオブジェクトではない");
  }
  if (request.schema !== INTAKE_CONTRACT.requestSchema) return reject("bad-schema", "schemaが一致しない");
  if (!request.commitment || typeof request.commitment.paperHash !== "string") {
    return reject("bad-schema", "commitmentが無いかpaperHashを持たない");
  }
  if (typeof request.authorDid !== "string" || !request.authorDid.startsWith("did:key:")) {
    return reject("bad-schema", "authorDidがdid:keyでない");
  }
  if (!signatureHolds(request)) return reject("bad-signature", "署名が成立しない");

  const sealed = ledgerEvents.filter((event) => event.type === "PAPER_SEALED");
  if (sealed.some((event) => event.data?.paperHash === request.commitment.paperHash)) {
    return reject("duplicate-paper", "同じpaperHashが既に封緘されている");
  }

  const { maxSealsPerWindow, windowHours } = INTAKE_CONTRACT.rateLimit;
  const floor = nowMs - (windowHours * 3_600_000);
  const recent = sealed.filter(
    (event) => event.data?.authorDid === request.authorDid && Date.parse(event.at) > floor,
  );
  if (recent.length >= maxSealsPerWindow) {
    return reject("rate-limited", `直近${windowHours}時間に${recent.length}件（上限${maxSealsPerWindow}）`);
  }
  return { accept: true, contractHash: INTAKE_CONTRACT_HASH };
}

// 台帳に積む形。受理・拒絶のどちらでも記録が残ることが要点。
export function sealedEventData(request) {
  return { ...request.commitment, authorDid: request.authorDid, contractHash: INTAKE_CONTRACT_HASH };
}

export function rejectedEventData(request, decision) {
  return {
    requestHash: hashJson(request),
    paperHash: request?.commitment?.paperHash ?? null,
    authorDid: typeof request?.authorDid === "string" ? request.authorDid : null,
    reason: decision.reason,
    detail: decision.detail,
    contractHash: INTAKE_CONTRACT_HASH,
  };
}
