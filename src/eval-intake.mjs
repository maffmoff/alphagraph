import { readRoom } from "./bt-agent.mjs";

// Technocore の署名付き反応を台帳の EVALUATION_SIGNED に変換する取込口。
// 「注目の単位は閲覧でなく返信」——閲覧は誰にも検証できないが、返信はDIDが立つ。
// ファーミング目的の空反応も署名履歴として残るので、後から篩にかけられる（fable-concept §7b）。
//
// 信頼モデルの注意: Technocore の読み取りAPIは署名そのものを返さない（実測・fable-concept §6）。
// from が did:key で立っていることは「サーバが書き込み時に署名を検証した」ことの証跡であって、
// 読者が独立に検証できる証明ではない。だから取り込んだ評価は attestation: "server-attested" と
// 明示し、独立検証可能な評価（attest コマンドの署名ファイル提出）とは区別する。

// 文法: alphagraph-eval-v1 paper:<64hex> verdict:<語> 以降は自由文
const GRAMMAR = /^alphagraph-eval-v1\s+paper:([0-9a-f]{64})\s+verdict:([a-z-]{2,24})(?:\s+(.*))?$/;
export const EVAL_VERDICTS = new Set(["reproduced", "challenged", "risk", "comment"]);

export function parseEvalMessage(message) {
  if (typeof message?.text !== "string") return null;
  if (typeof message.from !== "string" || !message.from.startsWith("did:key:")) return null;
  const match = message.text.trim().match(GRAMMAR);
  if (!match) return null;
  const [, paperHash, verdict, statement] = match;
  if (!EVAL_VERDICTS.has(verdict)) return null;
  return {
    paperHash,
    verdict,
    statement: (statement ?? "").slice(0, 500),
    evaluatorDid: message.from,
    room: message.room ?? null,
    seq: message.seq,
    at: message.ts ?? null,
    attestation: "server-attested",
  };
}

// 台帳の既存イベントと突き合わせ、新規に積むべき評価だけを返す純関数。
// - 台帳に無い論文への評価は捨てる（存在しないものは評価できない）
// - 同じ評価者×同じ論文×同じverdictは1回だけ（連投は数を作らない）
// - 自己評価は捨てない。台帳に残して誰でも見える状態にする（防止でなく検出）
export function selectNewEvaluations(ledgerEvents, messages) {
  const sealedHashes = new Set(
    ledgerEvents.filter((event) => event.type === "PAPER_SEALED").map((event) => event.data.paperHash),
  );
  const seen = new Set(
    ledgerEvents
      .filter((event) => event.type === "EVALUATION_SIGNED")
      .map((event) => `${event.data.evaluatorDid}|${event.data.paperHash}|${event.data.verdict}`),
  );
  const fresh = [];
  for (const message of messages) {
    const parsed = parseEvalMessage(message);
    if (!parsed) continue;
    if (!sealedHashes.has(parsed.paperHash)) continue;
    const key = `${parsed.evaluatorDid}|${parsed.paperHash}|${parsed.verdict}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(parsed);
  }
  return fresh;
}

export async function fetchRoomSince(room, sinceSeq, fetchImpl = fetch) {
  const view = await readRoom(room, sinceSeq ? { since: sinceSeq } : {}, fetchImpl);
  return {
    lastSeq: view.last_seq,
    messages: (view.messages ?? []).map((message) => ({ ...message, room })),
  };
}
