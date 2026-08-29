import { assertPlainObject, hashJson } from "./core.mjs";

// 等級1再現の決定性契約（docs/mvp.md §8-1）。
// 同一コード×同一データの再実行が、実行時刻や保存ファイル名に依らず同じハッシュになるための正規形。
// この定義自体が再現の合否を決めるため、契約はハッシュ固定して公開し、変更は台帳イベントとして扱う。
// 変更手順: supersedes に旧契約のハッシュを釘付けし、CONTRACT_CHANGED を台帳に積み、
// test/golden-repro.test.mjs の定数を再固定する。
export const REPRO_CONTRACT = {
  schema: "alphagraph-repro-contract-v2",
  reportSchema: "alphagraph-backtest-v1",
  supersedes: {
    schema: "alphagraph-repro-contract-v1",
    hash: "3edce959b890e880357c27f6d997134e4e248221e3790d271573e1434680209e",
    change: "data.quality を drop に追加。--provenance 付きの著者レポートが等級1再現で構造的に environment-drift になる欠陥の修正。",
  },
  drop: [
    "createdAt",
    "proposal",
    "reproduction",
    "data.label",
    "data.provenance",
    "data.quality",
  ],
  reason: {
    createdAt: "実行時刻。再現者と著者で必ず異なる。",
    proposal: "封緘物のラッパ。中のcreatedAtが伝播する。コードとの結び付きはstrategyHashが担う。",
    reproduction: "この契約で計算した値そのもの。自己参照を避けるため対象外。",
    "data.label": "保存ファイル名。再現者は別名で保存する。データ本体はdata.sha256が釘付けする。",
    "data.provenance": "取得元メタデータ。fetchedAtを含む。内容の同一性はdata.sha256が担う。",
    "data.quality": "provenance由来の品質ゲート要約。--provenanceという実行時の任意入力の有無で正規形が変わってはならず、根拠データの同一性はdata.sha256が担う。",
  },
  rule: "canonicalHash = sha256(stableStringify(正規形))、metricsHash = sha256(stableStringify({strategyHash, dataSha256, metrics, gate}))。",
};

export const REPRO_CONTRACT_HASH = hashJson(REPRO_CONTRACT);

export function canonicalizeReport(report) {
  assertPlainObject(report, "Report");
  if (report.schema !== REPRO_CONTRACT.reportSchema) {
    throw new Error(`Expected a ${REPRO_CONTRACT.reportSchema} artifact.`);
  }
  assertPlainObject(report.data, "Report data");
  const data = { sha256: report.data.sha256, bars: report.data.bars, start: report.data.start, end: report.data.end };
  return {
    schema: report.schema,
    engine: report.engine,
    strategy: report.strategy,
    strategyHash: report.strategyHash,
    data,
    split: report.split,
    assumptions: report.assumptions,
    metrics: report.metrics,
    gate: report.gate,
    requiredNextEvidence: report.requiredNextEvidence,
  };
}

// 2段ハッシュ。metricsHashが一致してcanonicalHashが不一致なら環境差、
// metricsHashが不一致なら計算結果そのものの相違。誰かが裁く必要をなくすための分離。
export function reproHashes(report) {
  const canonical = canonicalizeReport(report);
  return {
    contract: REPRO_CONTRACT.schema,
    contractHash: REPRO_CONTRACT_HASH,
    metricsHash: hashJson({
      strategyHash: canonical.strategyHash,
      dataSha256: canonical.data.sha256,
      metrics: canonical.metrics,
      gate: canonical.gate,
    }),
    canonicalHash: hashJson(canonical),
  };
}

function differingPaths(left, right, prefix = "") {
  // 片側にしか無いキー（undefined）はそこが差分。hashJsonはundefinedを直列化できない。
  if (left === undefined || right === undefined) return [prefix || "(root)"];
  if (hashJson(left) === hashJson(right)) return [];
  const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
  if (!isObject(left) || !isObject(right)) return [prefix || "(root)"];
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.flatMap((key) => differingPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key));
}

// 等級1再現の判定。verdictは4値で、matchのみが成立した再現。
export function compareReports(authorReport, candidateReport) {
  const author = canonicalizeReport(authorReport);
  const candidate = canonicalizeReport(candidateReport);
  const authorHashes = reproHashes(authorReport);
  const candidateHashes = reproHashes(candidateReport);
  const sameSubject = author.strategyHash === candidate.strategyHash
    && author.data.sha256 === candidate.data.sha256;

  let verdict;
  if (!sameSubject) verdict = "different-subject";
  else if (authorHashes.canonicalHash === candidateHashes.canonicalHash) verdict = "match";
  else if (authorHashes.metricsHash === candidateHashes.metricsHash) verdict = "environment-drift";
  else verdict = "mismatch";

  return {
    verdict,
    reproduced: verdict === "match",
    contractHash: REPRO_CONTRACT_HASH,
    subject: { strategyHash: author.strategyHash, dataSha256: author.data.sha256 },
    author: { metricsHash: authorHashes.metricsHash, canonicalHash: authorHashes.canonicalHash },
    candidate: { metricsHash: candidateHashes.metricsHash, canonicalHash: candidateHashes.canonicalHash },
    differences: verdict === "match" ? [] : differingPaths(author, candidate),
    note: {
      "different-subject": "封緘コードかデータが違う。等級1再現ではない。",
      match: "同一コード×同一データの再実行が正規形まで一致した。",
      "environment-drift": "数値結果は一致したが正規形が不一致。実行環境またはエンジン版の差。",
      mismatch: "数値結果が一致しない。論文側の欠陥か、決定性の破れ。",
    }[verdict],
  };
}
