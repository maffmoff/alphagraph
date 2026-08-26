import { assertNumber, assertPlainObject, assertString, hashJson } from "./core.mjs";

// 「実行可能な論文」の提出単位（docs/fable-concept.md §2）。
// 固定テンプレートではなく、主張・方法・データ・引用系譜を束ねた1個のパッケージ。
// パッケージ自体は決定的（時刻を含まない）。封緘の時刻は台帳イベント側が持つ。
export const PAPER_TYPES = new Set(["strategy", "empirical", "refutation", "dataset", "methods"]);

// 引用は符号と種別を持つ（docs/mvp.md §3）。符号なしの被引用数を評価に使わないため、
// 「壊れた論文が反証で引用されて高評価になる」倒錯を型で塞ぐ。
export const CITATION_KINDS = new Map([
  ["depends-on", { sign: 0, label: "依拠", note: "先行研究の結果・データ・手法を前提として使う" }],
  ["builds-on", { sign: 1, label: "発展", note: "先行研究を正しいものとして拡張する" }],
  ["refutes", { sign: -1, label: "反証", note: "先行研究が壊れる条件を再現するコードを伴う" }],
  ["contradicts", { sign: -1, label: "否定", note: "同じ問いに対して両立しない結果を得た" }],
]);

const PAPER_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function assertHash(value, label) {
  assertString(value, label, { max: 64, pattern: SHA256 });
  return value;
}

function normalizeSeries(entry, index) {
  assertPlainObject(entry, `verification.data[${index}]`);
  const series = {
    seriesId: assertString(entry.seriesId, `verification.data[${index}].seriesId`, { max: 120 }),
    sha256: assertHash(entry.sha256, `verification.data[${index}].sha256`),
    source: assertString(entry.source, `verification.data[${index}].source`, { max: 300 }),
    // 再配布可否はレーンを決める（docs/fable-concept.md §6 データ=二レーン）。
    // redistributable=false の系列は「計算持ち込み」でしか使えず、等級1再現は成立しない。
    redistributable: entry.redistributable === true,
  };
  if (entry.license) series.license = assertString(entry.license, `verification.data[${index}].license`, { max: 200 });
  if (entry.url) series.url = assertString(entry.url, `verification.data[${index}].url`, { max: 500 });
  return series;
}

function normalizeCitation(entry, index) {
  assertPlainObject(entry, `citations[${index}]`);
  const kind = assertString(entry.kind, `citations[${index}].kind`, { max: 20 });
  if (!CITATION_KINDS.has(kind)) {
    throw new Error(`citations[${index}].kind must be one of ${[...CITATION_KINDS.keys()].join(", ")}.`);
  }
  const citation = { kind, paperHash: assertHash(entry.paperHash, `citations[${index}].paperHash`) };
  if (entry.note) citation.note = assertString(entry.note, `citations[${index}].note`, { max: 300 });
  return citation;
}

export function validatePaper(input) {
  assertPlainObject(input, "Paper");
  if (input.schema !== "alphagraph-paper-v1") throw new Error("Expected a alphagraph-paper-v1 package.");
  const type = assertString(input.type, "type", { max: 20 });
  if (!PAPER_TYPES.has(type)) throw new Error(`type must be one of ${[...PAPER_TYPES].join(", ")}.`);

  assertPlainObject(input.verification, "verification");
  const data = Array.isArray(input.verification.data) ? input.verification.data : [];
  if (!data.length) throw new Error("verification.data must pin at least one series.");

  const citations = Array.isArray(input.citations) ? input.citations : [];
  // 反証・訂正型は対象論文の名指しが必須（docs/fable-concept.md §2）。
  if (type === "refutation" && !citations.some((entry) => entry?.kind === "refutes")) {
    throw new Error("A refutation paper must cite its target with kind \"refutes\".");
  }

  const paper = {
    schema: "alphagraph-paper-v1",
    type,
    id: assertString(input.id, "id", { max: 64, pattern: PAPER_ID }),
    title: assertString(input.title, "title", { max: 200 }),
    // テーゼ: 何が・なぜ機能するはずか。結果を見る前に封緘される部分。
    claim: assertString(input.claim, "claim", { max: 2000 }),
    // 機構: 制度・規制・参加者の制約から「こうなるはず」を先に導く（帰納だけでは足りない）。
    mechanism: assertString(input.mechanism, "mechanism", { max: 2000 }),
    // 払い手: エッジの反対側。誰が何のために払っているか。特定できないことは不採用理由にしない。
    whoPays: assertString(input.whoPays, "whoPays", { max: 1000 }),
    verification: {
      data: data.map(normalizeSeries),
      method: assertString(input.verification.method, "verification.method", { max: 2000 }),
      successCriteria: assertString(input.verification.successCriteria, "verification.successCriteria", { max: 1000 }),
      costs: assertString(input.verification.costs, "verification.costs", { max: 500 }),
    },
    citations: citations.map(normalizeCitation),
    runtime: {
      engine: assertString(input.runtime?.engine ?? "alphagraph", "runtime.engine", { max: 64 }),
      version: assertString(input.runtime?.version ?? "0.2.0", "runtime.version", { max: 32 }),
      node: assertString(input.runtime?.node ?? ">=20", "runtime.node", { max: 32 }),
    },
    disclosure: normalizeDisclosure(input.disclosure),
  };
  if (input.code) {
    assertPlainObject(input.code, "code");
    paper.code = {
      path: assertString(input.code.path, "code.path", { max: 300 }),
      sha256: assertHash(input.code.sha256, "code.sha256"),
    };
  }
  return paper;
}

function normalizeDisclosure(input) {
  const policy = input?.policy ?? "immediate";
  if (policy !== "immediate" && policy !== "embargo") {
    throw new Error("disclosure.policy must be immediate or embargo.");
  }
  if (policy === "immediate") return { policy };
  // 猶予は上限であって義務ではない（docs/fable-concept.md §2）。非戦略型は即時公開を選べる。
  return { policy, embargoDays: assertNumber(input.embargoDays, "disclosure.embargoDays", { min: 1, max: 365, integer: true }) };
}

// 封緘＝commit。公開されるのはハッシュと型と公開予定だけで、主張も方法も出ない。
// 猶予期間中の論文は引用のnoteも伏せる: noteは自由文なので機構を書けてしまい、
// 「中身は出ない」という封緘の保証を破る経路になる（実装時の実測で発見）。
// 引用の種別と対象ハッシュは系譜として常に公開する——そこは伏せる対象ではない。
export function sealPaper(paper) {
  const validated = validatePaper(paper);
  const paperHash = hashJson(validated);
  const embargoed = validated.disclosure.policy === "embargo";
  return {
    paper: validated,
    paperHash,
    // 台帳イベントに載る公開部分。中身は伏せたまま優先権だけ確定する。
    commitment: {
      paperHash,
      type: validated.type,
      id: validated.id,
      disclosure: validated.disclosure,
      citations: validated.citations.map(({ kind, paperHash: target, note }) => (
        embargoed || note === undefined ? { kind, paperHash: target } : { kind, paperHash: target, note }
      )),
      dataPins: validated.verification.data.map((series) => ({
        seriesId: series.seriesId,
        sha256: series.sha256,
        redistributable: series.redistributable,
      })),
    },
  };
}

// reveal＝猶予期間満了後の全文公開。台帳が封緘時のハッシュとの一致を検証する。
export function verifyReveal(revealedPaper, commitmentHash) {
  const validated = validatePaper(revealedPaper);
  const paperHash = hashJson(validated);
  return { valid: paperHash === commitmentHash, paperHash, expected: commitmentHash };
}

// 引用グラフの畳み込み。符号つきで数え、依拠と反証を混ぜない。
export function citationLedger(commitments) {
  const nodes = new Map();
  const ensure = (hash) => {
    if (!nodes.has(hash)) nodes.set(hash, { paperHash: hash, cites: [], citedBy: [], counts: {} });
    return nodes.get(hash);
  };
  for (const commitment of commitments) {
    const node = ensure(commitment.paperHash);
    node.type = commitment.type;
    node.id = commitment.id;
    for (const citation of commitment.citations ?? []) {
      node.cites.push(citation);
      const target = ensure(citation.paperHash);
      target.citedBy.push({ kind: citation.kind, paperHash: commitment.paperHash });
      target.counts[citation.kind] = (target.counts[citation.kind] ?? 0) + 1;
    }
  }
  return [...nodes.values()];
}
